import axios from 'axios';
import * as cheerio from 'cheerio';
import { config } from './config.js';

let browserPromise;
const renderedPages = new Map();
const RELOAD_AFTER_MS = 1_500;

async function waitForLaunchUi(page, timeout) {
  // Do not rely on a site's network requests or private endpoints.  Wait only
  // for a public, rendered UI signal that a token/launch card may exist.
  await page.waitForFunction(() => {
    if (document.querySelector('a[href*="/token/"], a[href*="/coin/"], [data-address], [data-contract], [data-mint], [data-clipboard-text]')) return true;
    return /\$[A-Za-z0-9_.$-]{2,32}\b/.test(document.body?.innerText ?? '');
  }, undefined, { timeout }).catch(() => {});
}

async function getBrowser(chromium) {
  browserPromise ??= chromium.launch({ headless: true }).then(browser => {
    browser.on('disconnected', () => { browserPromise = undefined; });
    return browser;
  }).catch(error => { browserPromise = undefined; throw error; });
  return browserPromise;
}

export function assertSafeUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) URLs can be watched.');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\.|^0\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1') {
    throw new Error('Private or local network URLs cannot be watched.');
  }
  return url.toString();
}

export async function fetchPage(rawUrl, rendered = config.usePlaywright) {
  return (await fetchDocument(rawUrl, rendered)).text;
}

export async function fetchDocument(rawUrl, rendered = config.usePlaywright, options = {}) {
  const url = assertSafeUrl(rawUrl);
  if (rendered) return fetchRendered(url, options);
  const response = await axios.get(url, { timeout: 15_000, maxRedirects: 5, responseType: 'text', headers: { 'User-Agent': config.userAgent, Accept: 'text/html,application/xhtml+xml' } });
  const $ = cheerio.load(response.data);
  // Include visible text plus inline scripts: many sites hydrate token data into JSON.
  const links = $('a[href]').map((_, node) => $(node).attr('href')).get();
  const tokenCards = $('a[href*="/token/"]').map((_, node) => ({ href: $(node).attr('href'), text: $(node).text() })).get();
  return { url: response.request?.res?.responseUrl ?? url, text: `${$('body').text()}\n${$('script').text()}`, source: response.data, links, tokenCards };
}

async function fetchRendered(url, { preferNewest = false } = {}) {
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('Playwright is not installed. Run npm install and npx playwright install chromium, or use rendered:false.'); }
  const browser = await getBrowser(chromium);
  let entry = renderedPages.get(url);
  try {
    const firstLoad = !entry || entry.page.isClosed();
    let refreshed = false;
    if (firstLoad) {
      const page = await browser.newPage({ userAgent: config.userAgent });
      entry = { page, reloadedAt: 0 };
      renderedPages.set(url, entry);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await waitForLaunchUi(page, 1_500);
      await page.waitForTimeout(250);
      refreshed = true;
    } else if (Date.now() - entry.reloadedAt >= RELOAD_AFTER_MS) {
      // Keep a live page open for fast DOM sampling.  Periodic reloads still
      // catch ordinary sites that do not update themselves via the frontend.
      await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
      await waitForLaunchUi(entry.page, 750);
      await entry.page.waitForTimeout(150);
      refreshed = true;
    }
    // Only move this timestamp after an actual navigation.  Updating it on
    // every 50ms DOM sample would indefinitely postpone refreshes for sites
    // whose frontend does not push new launch cards over a live connection.
    if (refreshed) entry.reloadedAt = Date.now();
    const page = entry.page;
    if (preferNewest && refreshed) {
      // Use the site's own visible sort control. This is UI interaction, not an API request.
      const newest = page.getByText('Newest', { exact: true }).first();
      if (await newest.count() && await newest.isVisible().catch(() => false)) {
        await newest.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
    // Launch feeds put new cards near the top; avoid scrolling through old market-cap cards in newest mode.
    for (let step = 0; step < (preferNewest ? 0 : 5); step += 1) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(350);
    }
    // Do not assume every launchpad uses /token/<address>.  Some use a card
    // with a data-mint/data-address attribute instead.  This inspects only
    // what the browser has rendered; it does not call a site's API.
    const tokenCards = await page.locator('body').evaluate(body => {
      const evm = /^0x[a-fA-F0-9]{40}$/;
      const solana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      const isAddress = value => evm.test(value) || solana.test(value);
      const selectors = [
        'a[href*="/token/"]', 'a[href*="/coin/"]',
        '[data-address]', '[data-contract]', '[data-contract-address]',
        '[data-mint]', '[data-token-address]', '[data-ca]',
        '[data-clipboard-text]', '[data-copy-text]', '[data-copy]', '[data-value]'
      ].join(',');
      const seen = new Set();
      const addressNodes = [...body.querySelectorAll(selectors)].map(node => ({ node, ticker: undefined }));
      // Some launchpads show a token card before the full CA is public.  Find
      // leaf ticker labels so those cards can be announced without pretending
      // that an abbreviated address is a valid contract.
      const tickerNodes = [...body.querySelectorAll('span, p, div, a, strong, b, h1, h2, h3')]
        .filter(node => /^\$[A-Za-z0-9_.$-]{2,32}$/.test((node.innerText || '').trim()))
        .slice(0, 300)
        .map(node => ({ node, ticker: (node.innerText || '').trim() }));
      return [...addressNodes, ...tickerNodes].flatMap(({ node, ticker }) => {
        const values = [...node.attributes].map(attribute => attribute.value.trim());
        const ownAddress = values.find(isAddress);
        const link = node.closest('a') ?? node.querySelector('a');
        const href = link?.href ?? node.getAttribute('href') ?? '';
        // A contract can be the last segment of a token/coin path even when
        // there is no explicit data-address attribute.
        const pathAddress = href.split(/[/?#]/).find(isAddress);
        const address = ownAddress ?? pathAddress;
        const key = `${href}|${address ?? ''}|${ticker ?? ''}`;
        if (seen.has(key)) return [];
        seen.add(key);
        // Token links are commonly nested in a small child element while the
        // image is a sibling near the top of the card.  Walk a few ancestors
        // and use the first card-like container that exposes an image.
        const ancestry = [];
        for (let current = node; current && current !== body && ancestry.length < 6; current = current.parentElement) ancestry.push(current);
        const shortVisualContainer = ancestry.find(current => {
          const length = (current.innerText || '').trim().length;
          return length > (ticker?.length ?? 0) && length < 2_000 && Boolean(current.querySelector('img'));
        });
        const card = ancestry.find(current => current.matches('article, li, [role="listitem"], [class*="card" i]')) ?? shortVisualContainer ?? ancestry.find(current => current.querySelector('img')) ?? node;
        const images = [...card.querySelectorAll('img')]
          .map(image => ({
            url: image.currentSrc || image.src,
            alt: image.alt || image.getAttribute('aria-label') || ''
          }))
          .filter(image => image.url)
          .filter((image, index, all) => all.findIndex(other => other.url === image.url) === index);
        return [{
          href,
          address,
          text: (card.innerText || node.innerText || '').slice(0, 2_000),
          // Retained as a fallback for one-image cards.  The monitor chooses
          // from imageCandidates using ticker/name to avoid selecting a pair.
          imageUrl: images.length === 1 ? images[0].url : undefined,
          // When a logo is immediately beside/above a ticker label, that is
          // stronger evidence than a later paired-asset image in the card.
          tokenImageUrl: ticker ? (node.parentElement?.querySelector('img')?.currentSrc || node.parentElement?.querySelector('img')?.src) : undefined,
          imageCandidates: images
        }];
      });
    });
    return {
      url: page.url(),
      text: await page.locator('body').innerText(),
      links: await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.href)),
      tokenCards
    };
  } catch (error) {
    // A failed/detached page must not poison subsequent live samples.
    if (entry?.page.isClosed?.() || /Target page, context or browser has been closed/i.test(error.message)) renderedPages.delete(url);
    throw error;
  }
}
