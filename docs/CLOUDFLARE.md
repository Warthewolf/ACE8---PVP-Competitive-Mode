# Running the RVNG server on Cloudflare

The whole server runs on Cloudflare's free plan: sign-ups, the mod scans, matchmaking, the link between the two PCs, match results, ratings, the leaderboard, events, the admin API and the website. Nobody's PC has to stay on. There is no Discord bot: everything is on the website.

It's the same code as the Node server (`server/src/`). `server/worker/` runs it on Cloudflare:
- **The database** is one Durable Object with its own SQLite (`worker/sqlstore.js`). It handles one request at a time, as the Node server did.
- **Matchmaking and the stale-match sweep** run on the Durable Object's alarm: every 3 s while someone is queued, every 30 s while a match is open, and not at all when idle. Pilots are also paired the moment they join.
- **The website** is `server/public/`, served as static files with the same security headers (`public/_headers`).

## Setup (about 10 minutes, once)

You need Node.js and a free Cloudflare account (https://dash.cloudflare.com/sign-up).

1. Open a terminal in `server/` and install the tools: `npm install`
2. Log in to Cloudflare: `npx wrangler login`. A browser page asks you to allow it.
3. Choose an admin password: a long random string that only you know. Store it: `npx wrangler secret put ADMIN_TOKEN` (paste it when asked).
4. Deploy: `npx wrangler deploy`. It prints the server's address, such as `https://rvng-server.<your-name>.workers.dev`.
5. Open that address in a browser. The website should show an empty leaderboard.
6. Open `/admin` on that address, sign in with the token, and upload the game build's file list and the approved mods under **Build & mods** (the same JSON files as the README's admin commands).
7. Each pilot signs up with the companion against the new address: `node client/rvng.js register --server https://rvng-server.<your-name>.workers.dev --name <pilot>`.

## The admin page

Open `/admin` on the server's address (`https://rvng-server.<your-name>.workers.dev/admin`) and sign in with the ADMIN_TOKEN. It is only for you: every action needs the token. The token stays only in that browser tab.

- **Disputes:** matches you decide. Examples: the link was lost mid-match, the two logs disagree, or one log never came. Both pilots' logs are side by side. **Settle** gives the win and the scores (filled in from the logs). **Void** leaves everyone as they were.
- **Players:**
  - **let in:** for a waiting pilot (invite-only).
  - **flag, ban:** under review, or refused everywhere.
  - **role / note:** the pilot's badge and the note on their card.
- **Reports:** reports from pilots. Close each one as resolved or dismissed.
- **Scans:** the companion's recent mod scans and what they found.
- **Build & mods:** upload the clean game's file list and the approved mods as JSON files, and retire old mods.

To deploy a new version later, run `npx wrangler deploy` again. The database stays.

Optional switches go in `wrangler.toml` under `[vars]`, then redeploy: `RVNG_INVITE_ONLY = "1"` (new accounts wait for you to let them in), `RVNG_RANKED = "0"` (pause ranked).

## Testing without an account

- `RVNG_TEST_WORKER=1 npm test`: the server's full test suite through the Cloudflare code, on Node.
- In Cloudflare's own runtime, on this PC:
  1. Put `ADMIN_TOKEN=local-admin-token` in `server/.dev.vars`.
  2. Run `npx wrangler dev --port 8787`.
  3. In another terminal, run `node test/worker-smoke.js`. It runs a whole native match: sign-ups, scans, queue, link, two results, verified, leaderboard.

## Free plan limits

The Durable Object free plan allows 100,000 requests a day and 5 GB of storage. A match costs a few hundred requests (the companion's polling), and a queue minute about 20 alarms, so this covers far more play than two friends need.
