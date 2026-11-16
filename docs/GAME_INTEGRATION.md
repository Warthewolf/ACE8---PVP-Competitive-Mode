# Game integration: what is known and what still needs work

## Known facts (public information, Nov 2026)

- ACE COMBAT 8: Wings of Theve launched on **2 October 2026** for PC (Steam), PS5 and Xbox Series X|S. It runs on **Unreal Engine 5**.
- Online play ("ACE COMBAT Online") has Co-Op Assault and Co-Op Warfare, rotating PvP events (4v4 Team Deathmatch, 8-player free-for-all), and a hub lobby for up to 100 players. Cross-play is supported.
- **There is no official 1v1 mode**, and there is no official mod support or public modding API.

So the competitive mode has to drive the game's existing private/custom-room or deathmatch flow with 2 players and our rules. Only the PC version can be modded.

## What the mod needs (all placeholders in `mod/ProjectRVNG/Scripts/main.lua`)

Every game-specific call goes through the `GAME` adapter table at the top of `main.lua`, and every hook path is in `HOOKS`. The rest of the mod (bridge files, per-match join/retry logic, logging, stat sampling) is tested with stubs in `mod/test/`.

The mod targets [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS), the usual Lua/C++ scripting framework for UE4/UE5 games. Once UE4SS is injected into AC8, use its Live View and object dump to find:

| Need | Placeholder | Notes |
|---|---|---|
| Main-menu entry | `HOOKS.MainMenuConstruct` | Add a "COMPETITIVE 1v1" button that calls `requestQueue()`. F8/F9 keybinds work until then. |
| Create / join private room | `GAME.createRoom(rules)`, `GAME.joinRoom(code)` | Host creates the room (retried every 5 s until it returns an id) and writes `lobby.json`; the guest joins each match's room once. Apply `match.rules` (time limit, kill target, 2 slots, special weapons). |
| Match start / end | `HOOKS.MatchStart`, `HOOKS.MatchEnd`, `GAME.endReason(ctx)` | Opens and closes the match log. The end reason must be the real one: the server checks it against the rules and the opponent's log. |
| Kills / deaths | `HOOKS.AircraftDestroyed`, `HOOKS.DamageApplied`, `GAME.key` | Kills are credited to the last pilot who damaged the victim. Crashes are deaths without a kill. `GAME.isLocal` / `GAME.isOpponent` tell the two pilots from AI. UE4SS creates a new Lua wrapper every time a hook receives an object, so the victim is remembered by `GAME.key(obj)` (default: `obj:GetAddress()`), never by the wrapper itself. The entry is dropped whenever any aircraft (AI too) is destroyed, because the engine reuses freed addresses. |
| Weapons | `HOOKS.WeaponFired`, `GAME.weaponKind` | `gun` / `missile` / `special`. Unknown kinds are logged as special (fail closed). |
| Surrender / disconnect | `HOOKS.PlayerLeft` | Logs a `disconnect` event. A leaver only loses when both logs record it. |
| Aircraft flight parameters | `AIRCRAFT_PARAM_CLASS`, `STAT_PROPS` | Read live at queue time, at match start and every second during the match; the log keeps the lowest and highest value of each stat. The same values (from a clean game) go into the admin baseline `aircraft` table, for every aircraft. These must be fixed parameters (maximum HP, not current HP). |
| Aircraft ids and speeds | `GAME.aircraftIds()`, `GAME.speeds()` | Ids must match the baseline's aircraft table. Speeds fill `telemetry.selfMaxSpeed` / `opponentMaxSpeed`. |
| Game build string | `GAME_VERSION` | Must match the baseline `gameVersion` the player scanned clean on. |

Every finished hook also needs a matching entry in the baseline aircraft table and a test match between two PCs.

## Bridge protocol (mod ⇄ companion)

Files are written in `<game root>/ProjectRVNG/bridge/` using write-to-temp-then-rename. The scanner excludes this folder, except for file types the game can load (`.pak`, `.dll`, `.lua`, …).

If the server cannot be reached when the companion starts (or when it re-checks after a cancel), it keeps asking, after 2 s and then at doubling intervals up to a minute, so an open match is always shown once the server is back and a banned account or stale credentials do not poll every second. A pending `result.json` is sent before a queue request read in the same tick, so a late log that settles an event game reopens the series before the pilot is queued, and a rejected scan stays on screen; a log that cannot be sent then does not hold up the queue request. A late log of an earlier match while another match is on screen leaves that match on screen. `credentials.json` is read from `--credentials`, else the folder the companion runs from, else the folder of `rvng.js`. The companion deletes `lobby.json` and `result.json` only after the server accepts them. A rejection of the content (400, 403, 404, 409, 413) renames the file to `*.failed`; network errors, a 401 from a skewed clock, 429 and 5xx are retried every second. Results are also copied to `bridge/archive/`. A scan refused because it came too soon after the last one (429) is repeated by the companion once the server allows it, with state `waiting` meanwhile. The mod acts only on a `matched` state whose match is `pending` or `live` and that it has not already played.

| File | Writer | Content |
|---|---|---|
| `request.json` | mod | `{ "action": "queue" \| "cancel", "region"? }` |
| `runtime.json` | mod | `{ gameVersion, aircraft: { id: { maxSpeed, turnRate, hp, ... } }, loadedModules? }` |
| `lobby.json` | mod (host) | `{ matchId, lobbyCode }` |
| `result.json` | mod | Match log, see `server/src/matchlog.js`. `events` is always a JSON array (`Json.array()`); `runtime.aircraft` and `runtime.aircraftMin` hold the highest and lowest sampled stats. |
| `state.json` | companion | `{ state: idle\|scanning\|waiting\|queued\|matched\|rejected\|reported, message, error?, match: { id, role, lobbyCode, rules, host, guest } }` |
