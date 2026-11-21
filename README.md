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
3. The server's matchmaker pairs players by rating (window widens with wait time, same region first). Tournament opponents are paired with each other first. There are two queues that never pair with each other: **ranked** (the ladder) and **casual** (looser matching on a hidden casual rating; results never touch the ranked rating, the leaderboard or events). Two pilots who just met are not paired again while either has someone else to play. The opponent is only named once the match exists.
4. Both mods post their own SteamID64 for the match; each pilot's mod then gets only the opponent's, and the native runtime links the two PCs over Steam, relay-only (Valve's relays: neither pilot learns the other's IP address). The main menu becomes the **ready-up screen** (the opponent, both ready states); once both pilots are ready, both PCs launch into the match at the same moment, and the match itself starts at one agreed time on both. (The native deathmatch is RVNG's own: official rooms can't be used by a modded client. Status: proven on one PC; the two-PC test is next, see `tools/autotest/README.md`, suite `pvp`.)
5. At match end **both** mods submit a match log. The server cross-checks them: score, deaths, aircraft, duration, how the match ended (kill target, time limit, or a surrender both logs agree on), kill events, rule bans, each pilot's live aircraft stats, and each pilot's top speed *as seen by the opponent*.
6. If the logs agree the match is **verified**. Elo ratings update, the leaderboard changes, and tournament series advance (a casual match only moves the hidden casual rating). If they don't agree it goes to **disputed** for an admin to review, and the event series waits for the ruling.

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
#    Logs and crash dumps are skipped (the players' scanner never reports them). One approve covers one build:
#    the loader is its folder plus the proxy DLL next to the game exe. Each mod is approved on its own: the
#    competitive mod lives inside the loader's Mods folder, so leave it out of the loader with --exclude (the
#    server refuses a file that another mod already pins). Exclude every Lua mod you approve on its own, e.g.
#    --exclude Mods/ProjectRVNG,Mods/CockpitColors once a cosmetic mod from step 3 lives there too.
node client/rvng.js approve --game "C:/.../ACE COMBAT 8" --path ACE8/Binaries/Win64/ue4ss,ACE8/Binaries/Win64/dwmapi.dll --exclude Mods/ProjectRVNG --name UE4SS --version 3.0.1 --category required
curl -X POST "$SERVER/api/admin/mods" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' --data @mods-UE4SS-3.0.1.json
node client/rvng.js approve --game "C:/.../ACE COMBAT 8" --path ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG --name "Project RVNG" --version 1.0 --category required
#    Upload mods-Project_RVNG-1.0.json the same way.
# 3. Optional cosmetic mods: --category cosmetic. A Lua mod in the loader's Mods folder is its own build: add its
#    folder to the loader's --exclude list (step 2) from then on.
# 4. After a game patch: upload the new baseline, then retire the old build so it can no longer queue:
curl -X POST "$SERVER/api/admin/baselines/1.0.1/active" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"active":false}'
# 5. New release of a required mod: run the same approve command as in step 2 (for the loader: both paths and
#    every --exclude) with the SAME --name and a new --version, and upload it. Both builds pass while players
#    update (each build lists all of its files, also those it shares with the other). Then retire the old
#    build. Pilots who still have it are told to update (outdated_mod) and are not flagged. To roll back a bad
#    release, retire the new build instead. Do not purge old builds: a purged build reads as a tampered mod.
#    Uploading a build again replaces its files under the approved paths: a changed file keeps the earlier one
#    known as retired, and a file it no longer has is retired. Still, a new --version for every changed release
#    keeps the history readable.
curl -X POST "$SERVER/api/admin/mods/retire" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"name":"Project RVNG","version":"1.0"}'
```

Upgrading a server from an earlier release: the earlier releases kept one row per approved file, so a file that two builds shared ended up in only one of them. After the upgrade:

1. Approve and upload every current build once more, with the step 2 commands and each build's current version, the loader first. `rvng approve` replaces the `mods-*.json` files an earlier release left in the folder when they hold the same paths.
2. If an upload is refused because another mod already pins files, the message lists every such file with the build and row id that pins it. When the files belong to the build you are uploading (a loader approved, under an older release, together with the competitive mod inside it), retire those rows with the one `POST /api/admin/mods/retire {"ids":[...]}` the message gives, then upload again right away: pilots who scan in between are told to update, never flagged. Do not approve the other build again from your install for this: your install may hold a different release of it. When the files belong to the other mod (a cosmetic Lua mod inside the loader's Mods folder), add that mod's folder to `--exclude` instead.
3. Builds approved before versions existed have the version `""` (see `GET /api/admin/mods`). Once they are uploaded again under a version, retire the version-less ones: `POST /api/admin/mods/retire` with `{"name":"UE4SS"}` and `{"name":"Project RVNG"}`. Otherwise they keep passing after you retire the versioned build.

Behind a reverse proxy, start the server with `TRUST_PROXY=1` (the number of proxy hops) or the proxy addresses (`TRUST_PROXY="loopback, 10.0.0.0/8"`) so the per-client sign-up limit sees real client addresses. `TRUST_PROXY=true` is refused: with a proxy that appends to `X-Forwarded-For`, every client could pick its own address.

Players: sign up on the website (or `rvng register`), save `credentials.json` in the folder you run the companion from (or in `client/`, next to `rvng.js`; or pass `--credentials <file>`), then run `node client/rvng.js run --game "<install dir>"` alongside the game. To enter an open event: `node client/rvng.js join-event --id <event number>`. For event matches add `--no-cache` to `run` so every file is re-hashed. The mod picks the queue (`mode` in `request.json`); `run --mode casual` sets the queue for mods that do not send one. To report a pilot to the admins: `rvng report --player <id> --reason cheating|griefing|abuse|other [--match <match id>] [--details "..."]`. To show only your tier on the website instead of the number: `rvng settings --hide-rating on` (`off` to show it again).

### Server settings

| Env | Default | Effect |
|---|---|---|
| `RVNG_INVITE_ONLY` | `0` (off) | `1`: new accounts start `pending` and can only read until an admin lets them in with `POST /api/admin/players/:id/status {"status":"active"}`. Find them with `GET /api/admin/players?status=pending`. |
| `RVNG_RANKED` | `1` (on) | `0`: ranked joins are refused with a message to queue casual, and a join that names no mode goes to casual. Pilots who owe an event series can still queue for that game. The leaderboard stays up and says the ranked queue is paused. |

Both are on/off switches (`1`/`0`, `true`/`false`, `on`/`off`); any other value stops the server at startup. The defaults keep an upgraded server working as before. **For the private test group, start with `RVNG_INVITE_ONLY=1 RVNG_RANKED=0`** (assume the client will leak: only pilots an admin lets in can play, and everyone plays casual until the ranked ladder is opened).

Tuning lives in `server/src/config.js`: the casual windows (`matchmaking.casual`: base 300, +15 per second, at most 1200, cross-region after 45 s; ranked is 100, +5, 600 and 120 s), the repeat-opponent rule (`matchmaking.rematch`: pilots who met in the last 30 minutes are paired again only if neither has anyone else, after both waited 60 s), player roles (`players.roles`: player, tester, veteran) and the note length (200), report reasons and limits (`reports`: 5 per hour per reporter, details up to 500 characters), and the lapse cooldown (`dodging`: a host whose room lapsed 3 times in 24 hours waits 15 minutes after the last lapse).

## API summary

Public: `GET /api/leaderboard`, `/api/players/:id`, `/api/matches`, `/api/tournaments`, `/api/tournaments/:id`, `/api/stats` (`queues` says which queues run), `POST /api/players/register`. Players carry `role` and `note`; a pilot who hides their rating has `rating: null` (the `tier` is still there). The casual rating is never in any response.

Player (HMAC-signed): `POST /api/integrity/report`, `/api/queue/join` (`region`: global, na, sa, eu, asia, oce, me, af; `mode`: ranked or casual), `/api/queue/leave`, `GET /api/queue/status`, `GET /api/matches/:id`, `POST /api/matches/:id/lobby`, `/api/matches/:id/report`, `/api/tournaments/:id/register`, `GET /api/me`, `POST /api/me/settings` (`{hideRating: true|false}`), `POST /api/reports` (`{playerId, reason, matchId?, details?}`; reasons: cheating, griefing, abuse, other)

Admin (Bearer `ADMIN_TOKEN`): `PUT /api/admin/baselines`, `POST /api/admin/baselines/:version/active`, `GET|POST /api/admin/mods` (`version`; `category`: required, cosmetic or retired; `roots`: the approved files and folders, as `rvng approve` writes them), `POST /api/admin/mods/retire` (`{name, version}`, or `{ids}` for single files, all or none), `DELETE /api/admin/mods/:id` (retires; `?purge=1` deletes), `GET /api/admin/integrity`, `GET /api/admin/players` (`?status=pending` for sign-ups waiting on an invite-only server), `POST /api/admin/players/:id/status` (`active`, `pending`, `flagged` or `banned`), `POST /api/admin/players/:id/role` (`{role?, note?}`: role player, tester or veteran; note up to 200 characters of plain text, shown on the player's card), `GET /api/admin/reports` (`?state=open|resolved|dismissed|all`), `POST /api/admin/reports/:id/close` (`{state: "resolved"|"dismissed", note?}`; closing a report changes nothing else), `/api/admin/matches/:id/resolve` (`{winner, scoreHost, scoreGuest}` or `{void:true}`, also for a room the sweep closed; a void also reverts a verified match and reopens an event series it decided), `/api/admin/tournaments`, `/api/admin/tournaments/:id/start`, `/api/admin/series/:id/forfeit` (`{winner: <player id>}` walkover)

More: [`docs/GAME_INTEGRATION.md`](docs/GAME_INTEGRATION.md) · [`docs/SECURITY.md`](docs/SECURITY.md)

Not affiliated with Bandai Namco. Modding online play may violate the game's terms of service, so check them before running events.
