import { randomUUID } from 'node:crypto';
import { contractKey, extractContracts } from './contracts.js';
import { assertSafeUrl, fetchDocument } from './fetch-page.js';
import { config } from './config.js';
import { addWatcher, isActiveWatcher, saveStore, watchers } from './store.js';
import { contractEmbed, newPathEmbed, tokenMentionEmbed } from './alert.js';

let client;
let busy = false;

function scopeHost(rawUrl) {
  const host = new URL(rawUrl).hostname.toLowerCase();
  // Starting at www.example.com should still include app.example.com and example.com.
  return host.startsWith('www.') ? host.slice(4) : host;
}

function inScope(url, rootHost) {
  const host = new URL(url).hostname.toLowerCase();
  return host === rootHost || host.endsWith(`.${rootHost}`);
}

function normalizeLink(href, baseUrl, rootHost) {
  try {
    const url = new URL(href, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !inScope(url, rootHost)) return null;
    url.hash = '';
    // Tracking query variations creates an unbounded crawl with filters, analytics, and pagination.
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return assertSafeUrl(url.toString());
  } catch { return null; }
}

function pathKey(rawUrl) {
  const url = new URL(rawUrl);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isLaunchDetailPath(rawUrl) {
  const path = new URL(rawUrl).pathname;
  return /\/(?:token|coin|launch|mint|asset|project|trade)s?(?:\/|$)/i.test(path);
}

function tokenCardMetadata(text) {
  const rows = text.replace(/\r/g, '').split('\n').map(row => row.trim()).filter(Boolean);
  const symbolIndex = rows.findIndex(row => /^\$[^\s$]{1,32}$/.test(row));
  if (symbolIndex < 0) return {};
  const symbol = rows[symbolIndex].slice(1);
  const name = rows.slice(symbolIndex + 1).find(row => !/^(NEW|CA|Paired with|Just launched|Vol\b|\$[\d,.]+|[+-]?[\d.]+%)$/i.test(row) && !row.startsWith('$'));
  const pairIndex = rows.findIndex(row => /^Paired with$/i.test(row));
  const pair = pairIndex >= 0 ? rows[pairIndex + 1] : undefined;
  const pairType = pairIndex >= 0 ? rows[pairIndex + 2] : undefined;
  const network = rows.find(row => /^(SOLANA|SOL|ETHEREUM|ETH|BASE|BSC|BNB(?: CHAIN)?|ARBITRUM|OPTIMISM|POLYGON|AVALANCHE)$/i.test(row));
  const networkNames = { sol: 'solana', eth: 'ethereum', 'bnb chain': 'bsc', bnb: 'bsc' };
  return { symbol, name: name?.slice(0, 100), pair, pairType, network: network ? (networkNames[network.toLowerCase()] ?? network.toLowerCase()) : undefined };
}

function tokenImage(card, metadata, contract) {
  if (card.tokenImageUrl) return card.tokenImageUrl;
  const images = card.imageCandidates ?? [];
  if (!images.length) return card.imageUrl;
  const symbol = metadata.symbol?.toLowerCase();
  const name = metadata.name?.toLowerCase();
  const address = contract.address.toLowerCase();
  const ranked = images.map((image, index) => {
    const label = image.alt.toLowerCase();
    let score = 0;
    if (address && image.url.toLowerCase().includes(address)) score += 1_000;
    if (symbol && (label === symbol || label === `$${symbol}`)) score += 500;
    else if (symbol && label.includes(symbol)) score += 250;
    if (name && label === name) score += 400;
    else if (name && name.length > 2 && label.includes(name)) score += 200;
    if (/pair|quote|base asset/i.test(label)) score -= 200;
    return { ...image, score, index };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  // With several images, no identifier match means the image could be the
  // paired asset. Leave the thumbnail blank rather than show the wrong token.
  if (ranked[0].score > 0 || images.length === 1) return ranked[0].url;
  // A direct /token/<address> link is an actual token card, not a broad page
  // container. Some launchpads leave img alt empty, but place the token logo
  // as the first image in that card before its ticker.
  if (/\/(?:token|coin)s?\//i.test(card.href ?? '')) return images[0].url;
  return undefined;
}

function announcementKey(token) {
  return `${token.sourceUrl}|${token.identity ?? token.symbol.toLowerCase()}|${(token.name ?? '').toLowerCase()}`;
}

function cardIdentity(text, metadata) {
  // A displayed short CA is not suitable for a contract alert, but it is a
  // stable card identity. This prevents price/volume changes from producing
  // new-token messages while still distinguishing two same-ticker launches.
  const shortAddress = text.match(/0x[a-f0-9]{4,}\.{3}[a-f0-9]{4,}/i)?.[0];
  return (shortAddress ?? `${metadata.symbol}|${metadata.name ?? ''}`).toLowerCase();
}

function visibleContractsWithContext(text) {
  // A bare hexadecimal/base58-looking string in page copy is not enough: it
  // could be an example, a hash, or documentation.  Require nearby UI wording
  // that identifies it as a token/contract.  Token-card paths and explicit DOM
  // address attributes are handled separately below.
  return extractContracts(text).filter(contract => {
    const index = text.indexOf(contract.address);
    const context = text.slice(Math.max(0, index - 160), index + contract.address.length + 160);
    return /\b(contract|contract address|token address|\bca\b|mint|launch(?:ed)?\s+token)\b/i.test(context);
  });
}

async function crawl(watcher, { discoverOnly = false } = {}) {
  // One-time migration to a single-page real-time UI/source watcher.
  if (watcher.crawlerVersion !== 15) {
    watcher.pages = [watcher.url];
    watcher.rendered = true;
    watcher.preferNewest = true;
    watcher.initialized = false;
    watcher.baselineUntil = Date.now() + 30_000;
    watcher.crawlerVersion = 15;
  }
  watcher.pages = [watcher.url];
  watcher.scopeHost ??= scopeHost(watcher.url);
  const queue = [watcher.url];
  const visited = new Set();
  const contracts = [];
  const tokenMentions = [];
  const tokenDetails = new Map();
  const discoveredPaths = new Set();
  let launchpadSignal = false;
  while (queue.length && visited.size < config.maxSitePages) {
    const target = queue.shift();
    if (visited.has(target)) continue;
    visited.add(target);
    try {
      const document = await fetchDocument(target, watcher.rendered, { preferNewest: watcher.preferNewest === true });
      const launchpadUi = /\b(launchpad|create token|launch(?:ing)?\s+token|sort launches|newest)\b/i.test(document.text);
      // Contracts must be exposed by the rendered UI.  Do not mine JavaScript
      // bundles or hydration source: those often retain old launch data and
      // create false "new contract" alerts when a bundle is redeployed.
      contracts.push(...visibleContractsWithContext(document.text).map(contract => ({ ...contract, sourceUrl: document.url, sourceLabel: 'rendered page' })));
      for (const card of document.tokenCards ?? []) {
        const metadata = tokenCardMetadata(card.text ?? '');
        const cardContracts = extractContracts(`${card.address ?? ''}\n${card.href ?? ''}`);
        let cardUrl = document.url;
        try { if (card.href) cardUrl = new URL(card.href, document.url).toString(); } catch { /* page is the source */ }
        if (isLaunchDetailPath(cardUrl)) tokenDetails.set(cardUrl, { metadata, card });
        // Full addresses only.  A shortened value such as 0x1234...abcd is
        // not enough information to alert accurately, so it is ignored.
        for (const contract of cardContracts) {
          contracts.push({ ...contract, ...metadata, imageUrl: tokenImage(card, metadata, contract), sourceUrl: cardUrl, sourceLabel: 'visible launch card', tokenPath: true });
        }
        // A card with a ticker but no full address can be an upcoming token.
        // Demand launch/contract context so ordinary dollar amounts and page
        // navigation labels never become alerts.
        if (!cardContracts.length && metadata.symbol && (launchpadUi || /\b(new|launch|launching|upcoming|coming soon|contract|\bca\b|mint|token)\b/i.test(card.text ?? ''))) {
          tokenMentions.push({ ...metadata, identity: cardIdentity(card.text ?? '', metadata), imageUrl: tokenImage(card, metadata, { address: '' }), sourceUrl: cardUrl });
        }
      }
      if (launchpadUi) launchpadSignal = true;
      for (const href of document.links) {
        const next = normalizeLink(href, document.url, watcher.scopeHost);
        // A full CA embedded in any same-site visible URL is immediately
        // useful. For opaque routes, inspect newly discovered launch-style
        // detail pages in the browser rather than assuming a fixed URL shape.
        if (next) {
          discoveredPaths.add(pathKey(next));
          if (isLaunchDetailPath(next)) tokenDetails.set(next, tokenDetails.get(next) ?? { metadata: {}, card: {} });
          const linked = extractContracts(next).map(contract => ({ ...contract, sourceUrl: next, sourceLabel: `${new URL(document.url).hostname} visible token path`, tokenPath: true }));
          if (linked.length) { contracts.push(...linked); launchpadSignal = true; }
        }
      }
    } catch (error) {
      // Drop dead links from the queue. Do not fill the terminal with expected 404s.
      if (error.response?.status === 404 || error.response?.status === 410) {
        watcher.pages = watcher.pages.filter(page => page !== target || page === watcher.url);
      } else {
        console.warn(`Page fetch failed (${target}): ${error.message}`);
      }
    }
  }
  // A launch card may deliberately shorten its CA. For newly appearing token
  // links, open the public detail page and inspect its rendered copy/address
  // controls. Bound this work so a large launchpad cannot create a crawl storm.
  const baselineActive = !watcher.initialized || Date.now() < (watcher.baselineUntil ?? 0);
  const knownPaths = watcher.knownPaths ?? [];
  const newPaths = [...discoveredPaths].filter(path => !knownPaths.includes(path));
  watcher.knownPaths = [...new Set([...knownPaths, ...discoveredPaths])].slice(-10_000);
  const knownTokenPaths = watcher.knownTokenPaths ?? [];
  const newTokenDetails = [...tokenDetails.entries()].filter(([url]) => !knownTokenPaths.includes(url));
  watcher.knownTokenPaths = [...new Set([...knownTokenPaths, ...tokenDetails.keys()])].slice(-5_000);
  const resolvedDetails = new Set();
  if (!baselineActive) {
    for (const [detailUrl, { metadata, card }] of newTokenDetails.slice(0, 4)) {
      try {
        const detail = await fetchDocument(detailUrl, true);
        const visible = visibleContractsWithContext(detail.text);
        const copied = (detail.tokenCards ?? []).flatMap(item => extractContracts(`${item.address ?? ''}\n${item.href ?? ''}`));
        const found = new Map([...visible, ...copied].map(contract => [contractKey(contract), contract]));
        for (const contract of found.values()) {
          contracts.push({ ...contract, ...metadata, imageUrl: tokenImage(card, metadata, contract), sourceUrl: detail.url, sourceLabel: 'visible token detail', tokenPath: true });
          resolvedDetails.add(detailUrl);
        }
      } catch (error) { console.warn(`Token detail fetch failed (${detailUrl}): ${error.message}`); }
    }
  }
  const unique = new Map();
  for (const contract of contracts) {
    const previous = unique.get(contractKey(contract));
    if (!previous || (contract.tokenPath && !previous.symbol)) unique.set(contractKey(contract), contract);
  }
  const tokenMints = [...unique.values()].filter(contract => contract.tokenPath).map(contractKey);
  const priorLaunches = watcher.launchpad?.observedMints ?? [];
  if (launchpadSignal || tokenMints.length) {
    watcher.launchpad = {
      isLaunchpad: true, name: new URL(watcher.url).hostname, evidence: 'visible launch UI or token paths',
      observedMints: [...new Set([...priorLaunches, ...tokenMints])].slice(-5_000), checkedAt: new Date().toISOString()
    };
  } else if (!watcher.launchpad) {
    watcher.launchpad = { isLaunchpad: false, evidence: 'no visible launch UI or token paths found', observedMints: [], checkedAt: new Date().toISOString() };
  }
  const uniqueMentions = new Map();
  for (const mention of tokenMentions) if (!resolvedDetails.has(mention.sourceUrl)) uniqueMentions.set(announcementKey(mention), mention);
  return { contracts: [...unique.values()], tokenMentions: [...uniqueMentions.values()], newPaths };
}

export async function watch({ guildId, channelId, url, rendered }) {
  const watcher = { id: randomUUID().slice(0, 8), guildId, channelId, url: assertSafeUrl(url), scopeHost: scopeHost(url), rendered, preferNewest: true, pages: [assertSafeUrl(url)], known: [], initialized: false, crawlerVersion: 15, baselineUntil: Date.now() + 30_000, createdAt: new Date().toISOString() };
  await addWatcher(watcher);
  return watcher;
}

export function startMonitor(discordClient, intervalMs) {
  client = discordClient;
  setInterval(() => tick().catch(error => console.error('Watcher tick failed:', error)), intervalMs);
  setTimeout(() => tick().catch(error => console.error('Initial watcher tick failed:', error)), 2_000);
}

async function tick() {
  if (busy) return;
  busy = true;
  try { await Promise.all(watchers().map(scanWatcher)); await saveStore(); }
  finally { busy = false; }
}

async function scanWatcher(watcher) {
  try {
    const result = await crawl(watcher);
    const { contracts, tokenMentions, newPaths } = result;
    // Watchers created by older releases have no rendered-frontend baseline. Do not back-alert existing coins.
    if (!watcher.initialized || Date.now() < (watcher.baselineUntil ?? 0)) {
      watcher.known = [...new Set([...(watcher.known ?? []), ...contracts.map(contractKey)])].slice(-5_000);
      watcher.knownTokenMentions = [...new Set([...(watcher.knownTokenMentions ?? []), ...tokenMentions.map(announcementKey)])].slice(-5_000);
      watcher.initialized = true;
      return;
    }
    const newContracts = contracts.filter(contract => !watcher.known.includes(contractKey(contract)));
    const newMentions = tokenMentions.filter(mention => !watcher.knownTokenMentions?.includes(announcementKey(mention)));
    if (!newContracts.length && !newMentions.length && !newPaths.length) return;
    watcher.known.push(...newContracts.map(contractKey));
    // Mark as seen before alerting so a transient Discord/API failure cannot repeatedly spam a channel.
    watcher.known = [...new Set(watcher.known)].slice(-5_000);
    watcher.knownTokenMentions = [...new Set([...(watcher.knownTokenMentions ?? []), ...newMentions.map(announcementKey)])].slice(-5_000);
    // A scan can finish after /unwatch. Re-check persistent state before any network alert.
    if (!isActiveWatcher(watcher.id, watcher.guildId, watcher.channelId)) return;
    const channel = await client.channels.fetch(watcher.channelId);
    if (!channel?.isTextBased()) return;
    for (const contract of newContracts) {
      if (!isActiveWatcher(watcher.id, watcher.guildId, watcher.channelId)) return;
      const roleId = watcher.alertRoleId ?? config.defaultAlertRoleId;
      await channel.send({
        content: roleId ? `<@&${roleId}>` : undefined,
        allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
        embeds: [await contractEmbed(contract, contract.sourceUrl ?? watcher.url, contract.sourceLabel)]
      });
    }
    for (const mention of newMentions) {
      if (!isActiveWatcher(watcher.id, watcher.guildId, watcher.channelId)) return;
      await channel.send({ embeds: [tokenMentionEmbed(mention, mention.sourceUrl)] });
    }
    for (const path of newPaths.slice(0, 20)) {
      if (!isActiveWatcher(watcher.id, watcher.guildId, watcher.channelId)) return;
      await channel.send({ embeds: [newPathEmbed(path, watcher.url)] });
    }
  } catch (error) { console.warn(`Watch ${watcher.id} (${watcher.url}) failed: ${error.message}`); }
}
