# Website Contract Watcher

A Discord bot that watches public, rendered web frontends for newly appearing EVM and Solana token addresses, then posts chain-correct trading, explorer, and social links. Use a token-data bot such as Rickbot for analytics.

## Setup

1. Install Node.js 20+ and run `npm install`.
2. Copy `.env.example` to `.env`, then add your Discord application token and client ID.
3. In the Discord developer portal, give the bot the `bot` and `applications.commands` scopes. It needs permission to send messages and embed links in the destination channel.
4. Register slash commands with `npm run register`, then start with `npm start`.

## Commands

- `/watch url:<public URL> [channel:<alert channel>] [role:<role to ping>]` — starts or updates a site watcher. It always scans the rendered frontend. The initial crawl is a baseline, so it only alerts for contracts added later.
- `/unwatch id:<watch id>` — stops one watcher.
- `/list` — lists active watchers and their IDs.
- `/help` — shows this short guide in Discord.

The bot uses Playwright to scan front-end apps that add content after load. Install its browser once with `npx playwright install chromium`.

## Notes

Each watcher repeatedly scrapes the exact URL you give it: the rendered UI and the page’s frontend source. It does not crawl linked pages or call a site's application API. UI/source diffs are posted when visible content or frontend code changes; a newly appearing EVM/Solana address creates a contract alert.

Alerts are intentionally link-only and come only from the watched page’s rendered UI and frontend source. The bot does not call site APIs, market APIs, or live-data feeds.

## Railway deployment

This repository includes a `Dockerfile` so Railway installs Chromium for the rendered frontend scanner.

1. Push this folder to a private GitHub repository, then create a new Railway project from that repository.
2. Railway detects the Dockerfile automatically. Do not expose a public networking domain; this bot only needs its Discord gateway connection.
3. Add a Railway volume mounted at `/data`.
4. In Railway Variables, add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `DEFAULT_ALERT_ROLE_ID`, `POLL_INTERVAL_MS=50`, `USE_PLAYWRIGHT=true`, and `DATA_DIR=/data`.
5. Deploy. The service start command is `npm start` and the volume preserves watched sites across deploys.
