# Game integration: what is known and what still needs work

## Known facts (public information, Nov 2026)

- ACE COMBAT 8: Wings of Theve launched on **2 October 2026** for PC (Steam), PS5 and Xbox Series X|S. It runs on **Unreal Engine 5**.
- Online play ("ACE COMBAT Online") has Co-Op Assault and Co-Op Warfare, rotating PvP events (4v4 Team Deathmatch, 8-player free-for-all), and a hub lobby for up to 100 players. Cross-play is supported.
- **There is no official 1v1 mode**, and there is no official mod support or public modding API.

So the competitive mode has to drive the game's existing private/custom-room or deathmatch flow with 2 players and our rules. Only the PC version can be modded.

## What the mod needs (all placeholders in `mod/ACE8Competitive/Scripts/main.lua`)

The mod targets [UE4SS](https://github.com/UE4SS-RE/RE-UE4SS), the usual Lua/C++ scripting framework for UE4/UE5 games. Once UE4SS is injected into AC8, use its Live View and object dump to find:

| Need | Placeholder | Notes |
|---|---|---|
| Main-menu entry | `HOOKS.MainMenuConstruct` | Add a "COMPETITIVE 1v1" button that calls `requestQueue()`. F8/F9 keybinds work until then. |
| Create / join private room | `CreatePrivateRoom`, `JoinPrivateRoom` | Host creates the room and writes `lobby.json`; guest joins by code. Apply `match.rules` (time limit, kill target, 2 slots, special weapons). |
| Match start / end | `MatchStart`, `MatchEnd` | Opens and closes the match log and maps the end reason. |
| Kills / deaths / weapons | `AircraftDestroyed`, `WeaponFired`, `DamageApplied` | Plus `isLocal(pawn)` to tell the local pilot from the opponent. |
| Aircraft flight parameters | `AIRCRAFT_PARAM_CLASS`, `STAT_PROPS` | Read live for the stat-tamper check. The same values (from a clean game) go into the admin baseline `aircraft` table. |
| Aircraft speed sampling | `LoopAsync` TODO | Fills `telemetry.selfMaxSpeed` / `opponentMaxSpeed`. |
| Game build string | `GAME_VERSION` | Must match the baseline `gameVersion`. |

Every finished hook also needs a matching entry in the baseline aircraft table and a test match between two PCs.

## Bridge protocol (mod ⇄ companion)

Files are written in `<game root>/ACE8Competitive/bridge/` using write-to-temp-then-rename. The scanner excludes this folder.

| File | Writer | Content |
|---|---|---|
| `request.json` | mod | `{ "action": "queue" \| "cancel", "region"? }` |
| `runtime.json` | mod | `{ gameVersion, aircraft: { id: { maxSpeed, turnRate, hp, ... } }, loadedModules? }` |
| `lobby.json` | mod (host) | `{ matchId, lobbyCode }` |
| `result.json` | mod | Match log, see `server/src/matchlog.js` |
| `state.json` | companion | `{ state: idle\|scanning\|queued\|matched\|rejected\|reported, message, match: { id, role, lobbyCode, rules, host, guest } }` |
