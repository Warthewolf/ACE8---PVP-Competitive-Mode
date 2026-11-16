# Project RVNG

**Project RVNG** is a community 1v1 ranked ladder and knockout tournament system for **modded ACE COMBAT 8: Wings of Theve** multiplayer (PC/Steam).

| Part | Path | Status |
|---|---|---|
| Website + API server (leaderboards, matches, brackets, integrity) | `server/` | Working, tested |
| Companion app (integrity scanner, signed API client, bridge to the mod) | `client/` | Working, tested against the server |
| In-game mod (main-menu queue entry, private room, match logging) | `mod/ProjectRVNG/` | **Template.** Game hook names must be found by reverse engineering (see `docs/GAME_INTEGRATION.md`) |

## How a match works

1. The pilot picks **Competitive 1v1** in the main menu (until the menu hook exists: F8 to queue, F9 to cancel).
2. The mod writes its live aircraft stats to the bridge folder. The companion app scans the install (file sizes + SHA-256, mods, injected DLLs) and sends a signed integrity report. Only a **clean** verdict gets a 30-minute integrity token.
3. The server's matchmaker pairs players by rating (window widens with wait time, same region first). Tournament opponents are paired with each other first.
4. The **host** creates a private room with the match rules and posts the room code. The **guest** gets the code and joins. Both pilots sortie into the same match.
5. At match end **both** mods submit a match log. The server cross-checks them: score, deaths, aircraft, duration, kill events, rule bans, and each pilot's top speed *as seen by the opponent*.
6. If the logs agree the match is **verified**. Elo ratings update, the leaderboard changes, and tournament series advance. If they don't agree it goes to **disputed** for an admin to review.

## Quick start

```bash
cd server && npm install
ADMIN_TOKEN=change-me npm start          # http://localhost:8080
npm test                                  # 13 tests: integrity, auth, matchmaking, disputes, brackets
DB_PATH=demo.sqlite node scripts-demo.js  # optional demo data, then: DB_PATH=demo.sqlite npm start
```

Admin setup for each game version:

```bash
# On a clean, unmodded install:
node client/rvng.js baseline --game "C:/.../ACE COMBAT 8" --version 1.0.2 --aircraft aircraft-stats.json
curl -X PUT $SERVER/api/admin/baselines -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data @baseline-1.0.2.json
# Pin the competitive mod itself as required (and any allowed cosmetic mods):
curl -X POST $SERVER/api/admin/mods -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Project RVNG","path":"<rel path>","size":1234,"sha256":"<hash>","category":"required"}'
```

Players: sign up on the website (or `rvng register`), save `credentials.json`, then run `node client/rvng.js run --game "<install dir>"` alongside the game.

## API summary

Public: `GET /api/leaderboard`, `/api/players/:id`, `/api/matches`, `/api/tournaments`, `/api/tournaments/:id`, `/api/stats`, `POST /api/players/register`

Player (HMAC-signed): `POST /api/integrity/report`, `/api/queue/join`, `/api/queue/leave`, `GET /api/queue/status`, `GET /api/matches/:id`, `POST /api/matches/:id/lobby`, `/api/matches/:id/report`, `/api/tournaments/:id/register`

Admin (Bearer `ADMIN_TOKEN`): `PUT /api/admin/baselines`, `POST /api/admin/mods`, `GET /api/admin/integrity`, `POST /api/admin/players/:id/status`, `/api/admin/matches/:id/resolve`, `/api/admin/tournaments`, `/api/admin/tournaments/:id/start`

More: [`docs/GAME_INTEGRATION.md`](docs/GAME_INTEGRATION.md) · [`docs/SECURITY.md`](docs/SECURITY.md)

Not affiliated with Bandai Namco. Modding online play may violate the game's terms of service, so check them before running events.
