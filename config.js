import 'dotenv/config';

const interval = Number.parseInt(process.env.POLL_INTERVAL_MS ?? '3000', 10);
const maxPages = Number.parseInt(process.env.MAX_SITE_PAGES ?? '100', 10);
const maxPagesPerScan = Number.parseInt(process.env.MAX_PAGES_PER_SCAN ?? '12', 10);
const maxSubdomains = Number.parseInt(process.env.MAX_PUBLIC_SUBDOMAINS ?? '200', 10);

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || undefined,
  defaultAlertRoleId: process.env.DEFAULT_ALERT_ROLE_ID || undefined,
  // 50ms samples an already-rendered browser page.  It does not cause a full
  // HTTP navigation every 50ms; fetch-page refreshes a page at a sane cadence.
  pollIntervalMs: Math.min(Math.max(Number.isFinite(interval) ? interval : 3000, 50), 60_000),
  maxSitePages: Math.min(Math.max(Number.isFinite(maxPages) ? maxPages : 100, 1), 500),
  maxPagesPerScan: Math.min(Math.max(Number.isFinite(maxPagesPerScan) ? maxPagesPerScan : 12, 1), 50),
  // Certificate records contain many stale/internal hosts. Follow real website links instead of probing them.
  discoverPublicSubdomains: process.env.DISCOVER_PUBLIC_SUBDOMAINS === 'true',
  maxPublicSubdomains: Math.min(Math.max(Number.isFinite(maxSubdomains) ? maxSubdomains : 200, 1), 1_000),
  usePlaywright: process.env.USE_PLAYWRIGHT === 'true',
  userAgent: process.env.USER_AGENT || 'WebsiteContractWatcher/1.0'
};

export function assertConfig() {
  if (!config.token) throw new Error('Missing DISCORD_TOKEN. Copy .env.example to .env and fill it in.');
}
