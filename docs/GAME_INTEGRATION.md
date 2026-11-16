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
| Kills / deaths | `HOOKS.AircraftDestroyed`, `HOOKS.DamageApplied` | Kills are credited to the last pilot who damaged the victim. Crashes are deaths without a kill. `GAME.isLocal` / `GAME.isOpponent` tell the two pilots from AI. |
| Weapons | `HOOKS.WeaponFired`, `GAME.weaponKind` | `gun` / `missile` / `special`. Unknown kinds are logged as special (fail closed). |
| Surrender / disconnect | `HOOKS.PlayerLeft` | Logs a `disconnect` event. A leaver only loses when both logs record it. |
| Aircraft flight parameters | `AIRCRAFT_PARAM_CLASS`, `STAT_PROPS` | Read live at queue time, at match start and every second during the match. The same values (from a clean game) go into the admin baseline `aircraft` table, for every aircraft. |
| Aircraft ids and speeds | `GAME.aircraftIds()`, `GAME.speeds()` | Ids must match the baseline's aircraft table. Speeds fill `telemetry.selfMaxSpeed` / `opponentMaxSpeed`. |
| Game build string | `GAME_VERSION` | Must match the baseline `gameVersion` the player scanned clean on. |

Every finished hook also needs a matching entry in the baseline aircraft table and a test match between two PCs.

## Bridge protocol (mod ⇄ companion)

Files are written in `<game root>/ProjectRVNG/bridge/` using write-to-temp-then-rename. The scanner excludes this folder, except for file types the game can load (`.pak`, `.dll`, `.lua`, …).

The companion deletes `lobby.json` and `result.json` only after the server accepts them. A permanent rejection renames the file to `*.failed`. Results are also copied to `bridge/archive/`. The mod acts only on a `matched` state whose match is `pending` or `live` and that it has not already played.

| File | Writer | Content |
|---|---|---|
| `request.json` | mod | `{ "action": "queue" \| "cancel", "region"? }` |
| `runtime.json` | mod | `{ gameVersion, aircraft: { id: { maxSpeed, turnRate, hp, ... } }, loadedModules? }` |
| `lobby.json` | mod (host) | `{ matchId, lobbyCode }` |
| `result.json` | mod | Match log, see `server/src/matchlog.js`. `events` is always a JSON array (`Json.array()`); `runtime.aircraft` holds the sampled stats. |
| `state.json` | companion | `{ state: idle\|scanning\|queued\|matched\|rejected\|reported, message, match: { id, role, lobbyCode, rules, host, guest } }` |
