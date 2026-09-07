import { EmbedBuilder } from 'discord.js';

const truncate = (value, length = 1000) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

function explorerLink(contract, network) {
  if (contract.chain === 'solana') return `https://solscan.io/token/${contract.address}`;
  const base = {
    ethereum: 'https://etherscan.io/token/', bsc: 'https://bscscan.com/token/', base: 'https://basescan.org/token/',
    arbitrum: 'https://arbiscan.io/token/', polygon: 'https://polygonscan.com/token/', optimism: 'https://optimistic.etherscan.io/token/',
    avalanche: 'https://snowtrace.io/token/'
  }[network] ?? 'https://etherscan.io/address/';
  return `${base}${contract.address}`;
}

function links(contract, market) {
  const q = encodeURIComponent(contract.address);
  const chain = market?.network ?? (contract.chain === 'solana' ? 'solana' : null);
  const dex = market?.dexUrl ?? `https://dexscreener.com/search?q=${q}`;
  const x = `https://x.com/search?q=${q}&src=typed_query`;
  const explorer = explorerLink(contract, market?.network);
  if (contract.chain === 'solana') return [
    `[GMGN](https://gmgn.ai/sol/token/${contract.address})`,
    `[Axiom](https://axiom.trade/t/${contract.address})`, `[DexScreener](${dex})`,
    `[Solscan](${explorer})`, `[X search](${x})`
  ].join(' • ');
  const gmgnChain = { ethereum: 'eth', bsc: 'bsc', base: 'base', arbitrum: 'arb', avalanche: 'avax' }[chain] ?? 'eth';
  const basedBot = chain ? `[BasedBot](https://basedbot.app/token/${chain}/${contract.address})` : null;
  return [
    `[GMGN](https://gmgn.ai/${gmgnChain}/token/${contract.address})`, `[DexScreener](${dex})`, basedBot,
    `[Explorer](${explorer})`, `[X search](${x})`
  ].filter(Boolean).join(' • ');
}

export async function contractEmbed(contract, sourceUrl, sourceLabel) {
  const market = null;
  const page = new URL(sourceUrl);
  const source = `${page.hostname}${page.pathname}${page.search}`;
  const site = page.hostname.replace(/^www\./, '').toUpperCase();
  const title = contract.symbol
    ? `${site} — $${contract.symbol}${contract.name ? ` · ${contract.name}` : ''}`
    : `${site} — new contract`;
  const sourceLine = `**Source:** [${site}](${sourceUrl})`;
  const description = [
    sourceLine,
    `\`${contract.address}\``,
    '', links(contract, market)
  ].join('\n');
  const embed = new EmbedBuilder().setColor(contract.chain === 'solana' ? 0x9945ff : 0x627eea).setTitle(title).setURL(sourceUrl).setDescription(description).setTimestamp();
  const fields = [
    { name: 'Chain', value: contract.network ? contract.network.toUpperCase() : (contract.chain === 'solana' ? 'SOLANA' : 'EVM'), inline: true }
  ];
  if (contract.pair) fields.push({ name: 'Paired with', value: `${contract.pair}${contract.pairType ? ` · ${contract.pairType}` : ''}`, inline: true });
  embed.addFields(fields);
  return embed;
}

export function tokenMentionEmbed(token, sourceUrl) {
  const page = new URL(sourceUrl);
  const site = page.hostname.replace(/^www\./, '').toUpperCase();
  const title = `${site} — $${token.symbol}${token.name ? ` · ${token.name}` : ''}`;
  const embed = new EmbedBuilder()
    .setColor(0x58a6ff)
    .setTitle(title)
    .setURL(sourceUrl)
    .setDescription(`**New token mention detected.**\n**Source:** [${site}](${sourceUrl})\nNo full contract address is visible yet.`)
    .setTimestamp();
  return embed;
}

export function newPathEmbed(pathUrl, watcherUrl) {
  const path = new URL(pathUrl);
  const source = new URL(watcherUrl);
  const site = path.hostname.replace(/^www\./, '').toUpperCase();
  return new EmbedBuilder()
    .setColor(0x58a6ff)
    .setTitle(`${site} — new URL path`)
    .setURL(pathUrl)
    .setDescription(`**New path:** [${path.pathname || '/'}](${pathUrl})\n**Found on:** [${source.hostname.replace(/^www\./, '').toUpperCase()}](${watcherUrl})`)
    .setTimestamp();
}
