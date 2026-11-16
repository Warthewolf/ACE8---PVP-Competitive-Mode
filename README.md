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
5. At match end **both** mods submit a match log. The server cross-checks them: score, deaths, aircraft, duration, how the match ended (kill target, time limit, or a surrender both logs agree on), kill events, rule bans, each pilot's live aircraft stats, and each pilot's top speed *as seen by the opponent*.
6. If the logs agree the match is **verified**. Elo ratings update, the leaderboard changes, and tournament series advance. If they don't agree it goes to **disputed** for an admin to review, and the event series waits for the ruling.

## Quick start

```bash
cd server && npm install
ADMIN_TOKEN=change-me npm start          # http://localhost:8080
npm test                                  # integrity, auth, matchmaking, disputes, brackets, security regressions
DB_PATH=demo.sqlite node scripts-demo.js  # optional demo data, then: DB_PATH=demo.sqlite npm start
```

Admin setup for each game version:

```bash
# 1. On a clean, unmodded install. The aircraft stats are required: without them every match is disputed.
node client/rvng.js baseline --game "C:/.../ACE COMBAT 8" --version 1.0.2 --aircraft aircraft-stats.json
curl -X PUT "$SERVER/api/admin/baselines" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data @baseline-1.0.2.json
# 2. Pin the script loader and the competitive mod, every file, as REQUIRED. This includes UE4SS-settings.ini
#    (with ModsFolderPath empty and the debug console off), mods.txt and the mod's enabled.txt: any loader
#    file or script that is not pinned is rejected, and a required mod must match one pinned build exactly.
#    Logs and crash dumps are skipped (the players' scanner never reports them). Each mod is approved on its
#    own: the competitive mod lives inside the loader's Mods folder, so leave it out of the loader with
#    --exclude (the server refuses a file that another mod already pins).
node client/rvng.js approve --game "C:/.../ACE COMBAT 8" --path ACE8/Binaries/Win64/ue4ss --exclude Mods/ProjectRVNG --name UE4SS --version 3.0.1 --category required
curl -X POST "$SERVER/api/admin/mods" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data @mods-UE4SS-3.0.1.json
node client/rvng.js approve --game "C:/.../ACE COMBAT 8" --path ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG --name "Project RVNG" --version 1.0 --category required
#    Upload that file the same way, and pin the loader's proxy DLL next to the game exe as part of the loader
#    (--path ACE8/Binaries/Win64/dwmapi.dll --name UE4SS --version 3.0.1).
# 3. Optional cosmetic mods: --category cosmetic.
# 4. After a game patch: upload the new baseline, then retire the old build so it can no longer queue:
curl -X POST "$SERVER/api/admin/baselines/1.0.1/active" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"active":false}'
# 5. New release of a required mod: approve it with the SAME --name and a new --version and upload it. Both
#    builds pass while players update (each build lists all of its files, also those it shares with the other).
#    Then retire the old build. Pilots who still have it are told to update (outdated_mod) and are not
#    flagged. To roll back a bad release, retire the new build instead. Do not purge old builds: a purged
#    build reads as a tampered mod.
curl -X POST "$SERVER/api/admin/mods/retire" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"Project RVNG","version":"1.0"}'
```

Upgrading a server from an earlier release: the earlier releases kept one row per approved file, so a file that two builds shared ended up in only one of them. After the upgrade, approve and upload every current build once more.

Behind a reverse proxy, start the server with `TRUST_PROXY=1` (the number of proxy hops) or the proxy addresses (`TRUST_PROXY="loopback, 10.0.0.0/8"`) so the per-client sign-up limit sees real client addresses. `TRUST_PROXY=true` is refused: with a proxy that appends to `X-Forwarded-For`, every client could pick its own address.

Players: sign up on the website (or `rvng register`), save `credentials.json`, then run `node client/rvng.js run --game "<install dir>"` alongside the game. To enter an open event: `node client/rvng.js join-event --id <event number>`. For event matches add `--no-cache` to `run` so every file is re-hashed.

## API summary

Public: `GET /api/leaderboard`, `/api/players/:id`, `/api/matches`, `/api/tournaments`, `/api/tournaments/:id`, `/api/stats`, `POST /api/players/register`

Player (HMAC-signed): `POST /api/integrity/report`, `/api/queue/join` (`region`: global, na, sa, eu, asia, oce, me, af), `/api/queue/leave`, `GET /api/queue/status`, `GET /api/matches/:id`, `POST /api/matches/:id/lobby`, `/api/matches/:id/report`, `/api/tournaments/:id/register`

Admin (Bearer `ADMIN_TOKEN`): `PUT /api/admin/baselines`, `POST /api/admin/baselines/:version/active`, `GET|POST /api/admin/mods` (`version`; `category`: required, cosmetic or retired), `POST /api/admin/mods/retire` (`{name, version}`), `DELETE /api/admin/mods/:id` (retires; `?purge=1` deletes), `GET /api/admin/integrity`, `POST /api/admin/players/:id/status`, `/api/admin/matches/:id/resolve` (`{winner, scoreHost, scoreGuest}` or `{void:true}`, also for a room the sweep closed; a void also reverts a verified match and reopens an event series it decided), `/api/admin/tournaments`, `/api/admin/tournaments/:id/start`, `/api/admin/series/:id/forfeit` (`{winner: <player id>}` walkover)

More: [`docs/GAME_INTEGRATION.md`](docs/GAME_INTEGRATION.md) · [`docs/SECURITY.md`](docs/SECURITY.md)

Not affiliated with Bandai Namco. Modding online play may violate the game's terms of service, so check them before running events.
