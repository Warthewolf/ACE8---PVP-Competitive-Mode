# AC8's online screens offline: what each one needs

This is a static audit of the 2026-11-02 exe, done on 2026-11-19. The game was not launched for it.

It answers one question: can RVNG reuse AC8's own online screens by removing the Bandai calls they make? The audit split the screens into four groups:
- the matchmaking screen;
- the online results screen;
- the NUI online menu system;
- the developers' debug lobby menus.

Each group had one agent map it and a second agent check the map and hunt for missed online calls. The full output, with an evidence list for every claim, is in `online_ui/audit.json`. The tags are:
- [V]: verified in the disassembly or the cooked assets.
- [I]: inferred.
- [?]: open.

Paths in `audit.json` that begin `<scratchpad>/` were temporary scratch files.

The rules were the same as for the rest of RVNG:
- no game launch;
- no contact with Bandai or the internet;
- no reading of anti-cheat code (each anti-cheat call site is marked "not analysed");
- no reading of `Live/Config/DefaultGame.ini`;
- the Survival repo was only read.

## The short answer

Removing the calls is mostly done already:
- D5 shuts web gates A and B.
- The Strix client is never created, so every Strix call returns at its null check.
- The online flag `SM+0x1fa` stays 0, so the screens take their offline branches.

What each screen is missing is the data Bandai's servers would have sent back. One new safety gap also turned up: D5 covered only 2 of at least 11 web gates. D9 (runtime 0.3.6, section 5) now closes all of them, and every place the game's code sends to an outside server, in every install.

| Screen | Verdict | What RVNG would have to add |
|---|---|---|
| SET SELECT (`ELiveNUIMenuType::Matching`, `WBP_Menu_Matching_000`) | usable, needs data | a page row on the main menu, the aircraft-set list, the opponent's pick, a release of the "waiting" state |
| Online results (`/Game/OnlineMode/Maps/Menu/Result`) | usable, needs data (costly) | a crash guard, a fake result record in an unknown layout, an OnlineLobby redirect for its exit |
| NUI framework (menu manager, parts) | usable for one page over the main menu | page row insert, room-member data; never create the Lobby part |
| Debug lobby menus | unsafe / nothing to reuse | none; the only match-setup path in them is all Bandai calls |

## 1. The "Matching" page is SET SELECT, not a search screen

[V] `ELiveNUIMenuType` 24 (`0x18`) is the screen players see after a match is found:
- each player picks an aircraft set against a countdown;
- then waits for the others;
- then sorties.

It has no search timer, no player count and no searching / found / cancelled states. RVNG's queue display has to be its own.

- **Class.** `ULiveNUIMenuMatchingRootWidget` (/Script/LiveLobby):
  - vtable `0x14cc652a0`, size `0x540`;
  - the Blueprint holds only the layout.
- **Functions.**
  - setup vslot `0x4b8` `0x148185530`;
  - cleanup `0x4c0` `0x148185e00`;
  - input `0x4f8` `0x148189600`;
  - tick `0x518` `0x1481851f0`;
  - close `0x528` `0x1481861e0`;
  - open sequence `0x570` `0x148186e70`;
  - decide `0x148189d80`;
  - apply `0x14818a8c0`;
  - IsOnline `0x14818a6d0` (= `SM+0x1fa`).
- **Tick states (`+0x4f9`).**

  | State | Meaning |
  |---|---|
  | 1 | selecting |
  | 3 | waiting for the room |
  | 4 | sortie delay (`InitSortieTimerValue` `+0x468`) |
  | 5 | close |
  | 6 | failed |

- **Online contacts.** There are only two, and both are already safe offline [V]:
  - an "in-game" status to the Strix Messenger (`0x1474f0a70`), which returns when the messenger's client `+0xf8` is null;
  - the AircraftSelect message (`0x14749b0b0`), which is sent only when `SM+0x1fa` is set. Otherwise the pick goes to the local selector (`0x147491460`).
- **No other service is reached.** A two-level call walk from every screen function found no Chronicle, gate A/B, EOS or anti-cheat call.

### How it is opened natively

[V] The chain:
1. MatchMaker finish `0x1477e80d0(mm, {0, 0})`.
2. Lobby part listener `0x1477f3a20`.
3. `0x1477f2c40` fills the MatchingStepProcessor.
4. Step `0x1477f3640` (`PushTaskMatchingSuccess`) calls `OpenMenu 0x14767edb0(mm, 0x18, 0, 0)`.

The listener dereferences the Lobby part's MenuManager (`+0x548`) without a check. So the native opener only works inside the Lobby part, which exists only on the online lobby map (level 99995). That map stays off-limits (6.2.4).

The main menu's manager, `WBP_NUICampaignMainMenuManager`, has no Matching row [V]. Its page table lists only Top, Shop2 and the System pages.

**The one route that looks workable** [V parts, ? as a whole] is to open the page over the offline main menu:
1. Get the current part with `0x1475ad750`.
2. Check that its class is `ULiveNUICampaignMainMenuPartManager` (`0x146f07a20`).
3. Take MenuManager = `part+0x4c0`. The game's own System-option openers `0x1477a1029` / `0x1477a7328` pick the manager this way.
4. Load `WBP_Menu_Matching_000_C`.
5. Give the manager a row for type 24. Either insert it into `MenuParamMap` `+0x480` (0x80-byte elements, needs a rehash) or overwrite an unused row's MenuClass [I].
6. Call `OpenMenu 0x14767edb0(mgr, 24, 0, 0)`.

The page null-checks the Lobby part at all four sites (`0x148185afb`, `0x148185b21`, `0x148185eef`, `0x148185f10`). The framework itself, from OpenMenu and the step builder to CreatePart and the bridge, touches no online service at depth 2.

### What the page needs that offline play lacks

- **The aircraft-set list** `UDM+0x1050` (stride `0x88`).
  - The pointer is set at boot, so there is no crash [V].
  - But the only add-site of an entry (`0x147933e30`) sits in an HTTP-200 handler (`0x14792cb20`) [I]. So offline the list is probably empty, and nothing can be picked (decide skips at `0x148189dde`).
  - RVNG would have to fill it, and the entry layout is unknown.
- **UDM+0xf38 = the DM MissionProgramId,** set before opening. It picks the mission previews.
- **Selectors.**
  - The offline open step `0x1474910d0` rebuilds the room-member manager. It calls the VM-protected `0x14748d870`, empties `MRMM+0x30` and creates one local selector keyed by the `UDM+0xfd0` user id.
  - So any selector RVNG makes before the open is reset. The opponent's selector must be filled after the open sequence (after state 1 is set).
- **The pick itself.**
  - Offline, apply copies UDM's current loadout into the local selector before decide writes the chosen set into UDM (`0x1476088b0` at `0x148189e1d`).
  - So RVNG should relay the chosen set's data, not the selector's.
  - The focus callback `0x148186b60` also calls apply on every focus move.
- **Factions.**
  - The common open step calls `NM 0x1474ae080`, which re-seeds `NM+0x4d0`.
  - RVNG must re-apply host = 1 / guest = 2 after SET SELECT opens.
- **The state-3 wait.**
  - State 3 waits for `SM+0x1fa` plus `LiveRandomEventSubsystem+0x31`, or for mission mode OnlineTutorials (10). Offline it stalls.
  - RVNG would move 3 → 4 itself once both picks are in, at `0x14818538b`.
- **Two failure exits.**
  - If `UDM+0xed4 != 0`, the screen goes to state 6 with "MatchingFailure".
  - When select + disconnect time runs out (`Time_000+0x448` → `0x148188010`), it goes to state 6 with "MatchingMember_Disconnection". The `DevelopParameters` defaults are 60 s + 20 s [I]; no config was read.
  - RVNG could use the second exit as its "peer lost" path.
- **The sortie travel.**
  - The close path travels by itself: LevelRow, then `RequestChangeMap 0x147901bf0` at `0x148188b3d`.
  - RVNG's own travel must not run as well. D6's RequestChangeMap hook will see this call.
- **Cleanup** (`0x147491760`) unregisters every selector's network object (`+0x188`).

**Never** start the native search, for any reason:
- MatchMaker start `0x1477e77d0` / `0x1477e7ac0`;
- `NM 0x1474af800`;
- `0x1474b0980` / `0x1474b00d0`.

That search goes to Chronicle's WebSocket matchmaker, which D5 and D7 do not block. An anti-cheat restriction check also sits inside `0x1474af800` (`0x1474af870` / `0x1474af87f`, not analysed).

## 2. The online results screen

[V] The match's Ended state travels to the Result map (`0x1471c5f0e`):
- **Map contents.** `ALiveResultAvatarGameMode` (vtable `0x14cc6bca0`), the avatar sublevel `SL_ResultAvatar` and the NUI Result part.
- **Root widget.** `ULiveNUIMenuResultRootWidget` (vtable `0x14c943f60`, slot 151 = `0x147704430`) is native code.
- **Views.** ViewTop `0x14c942dc0`, ViewPlayers `0x14c943548`, ViewPersonal `0x14c943220`, ViewDrop `0x14c942340`.

**What it shows.** It shows one result record from Bandai's Result API, read at `*(UDM+0x1228)`, with stride `0xc8`:
- known offsets [V]: `+0x20` = MVP/top id, `+0x30` = teams (stride `0x28`), with a users array at `+0x18` (stride `0x170`, `+0` = user id);
- unknown: the score, kill, death and reward fields.

It does not read the match's own EvaluationList or ScoreUpdate. So even a working stock screen would not show RVNG's match data unless RVNG writes the record.

**Why it crashes offline.** It was test 2 run C [V]:
1. With no record, slot 151 builds placeholder data: `rand()`, plus hard-coded Ace Pass points 5590 → 8020.
2. The placeholder Ace Pass builder `0x1477259e0` (only caller `0x147704864`) divides by the season's PointPerTier at `0x147725a84` / `0x147725aaf`.
3. The season lookup `0x14771a280` uses the clock `[GAC+0x108]+0x1b0`. That is the LiveWebAPI server time, which gate B caches even when D5 answers false, and it is never set offline.
4. So no season is found, PointPerTier is 0, and the game divides by zero.

**A time limit.** Any fix that feeds the lookup a real clock stops working when the local `DT_AcePass` row ends, on 2026-12-01 08:00 GMT [I from the cooked table].

**What else it reaches** (missed by the first map, found by the checker) [V]:
- **The exit travels to the online lobby.**
  - The root widget's exit handler, slot 165 `0x147704ba0`, calls `0x147ec9fc0` (it writes `UDM+0xf3c = 99995`), then `0x147ec9e40`, then RequestChangeMap.
  - The online lobby's game mode `ALiveLobbyAvatarGameMode` (vtable `0x14cc380e0`) runs:
    - messenger calls;
    - an EOS party invite;
    - a gate-A web request (slot 302);
    - an anti-cheat call at `0x1480eceff` (not analysed).
  - **D6 has no OnlineLobby half today.** It redirects only the Result map. So D6's Result half must stay until an OnlineLobby redirect exists.
- **LeaveRoom (`0x1474b5650`) runs offline from three places:**
  - GM EndPlay `0x1480ee14e`, whose guard sends `NM+0x4c9 == 0 && SM+0x1fa == 0` straight to the call;
  - root slot 165;
  - ViewPlayers slot 92.

  Its Strix calls return at the null client global `0x14e4c5818`. But it still clears `SM+0x1f9/+0x1fa`, sets `SM+0x30 = -1`, sets `NM+0x4c8 = 0` and resets `NM+0x710/+0x718`.
- **A matchmaker cancel at GM EndPlay.** `0x1474b1180` is a Chronicle matchmaker cancel, not a travel. It runs only when a matchmaker session exists, which never happens under RVNG [I].
- **The Personal view's Ace Pass gauge** reads the AcePass web model `UDM+0x1278` and the same server clock, even on the real-record path. A synthesized record does not cover it, so RVNG would have to hide that view or accept a default gauge.
- **The layout.** `UDM+0xf38` picks the layout through the mission row's `+0x6c`; 3 = Deathmatch.

**The minimum offline plan if RVNG ever wants the stock screen:**
1. Add an OnlineLobby redirect to D6.
2. Detour `0x1477259e0` to return. This is the crash guard; it is low risk with one caller.
3. Synthesize a record in `*(UDM+0x1228)`. Its field layout needs more RE, and some readers sit behind protected thunks (`0x147896890`).
4. Keep the MRMM members keyed by the same ids.
5. Accept a default Ace Pass gauge.

**Recommendation.** Keep D6 and draw RVNG's own result panel from RVNG's own match data. That data already exists: ScoreUpdate, the kills, the deaths and the winner. The stock screen would need a fake web record and would still not show the match's own data.

## 3. The NUI framework

[V] The game creates one NUI "part" per map from the level ID (bridge slot `0x61` `0x1475e27e0`, switch at `0x1475e28f2`):

| Level ID | Part |
|---|---|
| 99995 | Lobby |
| 2 | CampaignMainMenu |
| others | none |

So the deathmatch maps get no part [I]. The main menu's part keeps its MenuManager at `+0x4c0`; the Lobby part keeps its manager at `+0x548`.

- `FindMenuParam 0x147680250` returns null for a type that has no row, and both step lambdas null-check it. So asking the main menu's manager for Matching does nothing; it does not crash.
- `0x14767ef00` opens a page by key. It does not close one. No pop/close function was found yet.
- Five more OpenMenu callers take the menu type from data: `0x14757bba7`, `0x14769115d`, `0x1476993a8`, `0x1477a1111` and `0x1477a740b`.

**Don't reuse:**
- **The Lobby part.** Never create it, through CreatePart type 4 or the real lobby map. Its start-up sends a Stamp web request through an unhooked gate (`0x1477e9de5` → `0x1479d4df0` → gate `0x1479297c0` → request builder `0x147f94730`). Its every-frame tick (slot `0xa3` `0x1477ea760`):
  - reads the web server clock;
  - reads GeneralAPIController;
  - runs the MatchMaker tick, which can reach Chronicle and Strix.
- **Party, PlayerList and Lobby000/001.** They are built on PartyManager, the web API (Party / Friend / General controllers) and EOS invites, and under D5 their web requests never call back.

**SystemLobbySetting** (camera and avatar options) is already in the main menu's page table. Its save goes through the unhooked gate `0x1479c55b0`, then GAC `0x147959070`, then gate B, and gate B is what stops it.

## 4. The debug lobby menus

[V] The four DebugMenu packages are empty Blueprint shells, filled by native classes that are still in the exe:
- **LobbyTop** has four rows: "Matching Option >>", "Localize Text >>", "Tutorial Dialog >>" and "OpenOldDebugMenu".
- **"Matching Option" is empty in this build.** Its vtable `0x14c8cf180` is identical to its base.
- **LocalizeText and TutorialDialog** are local UI test pages.

**They make no Bandai calls. Shipping code never opens them:**
- None of the 21 resource-bank lookups asks for their keys.
- The cheat-manager command `OpenDebugMenu` has the shared empty native stub (`0x143cbef30` → `0x152836630`), so the opener was compiled out.

**The Debug Boot menu.** The only debug screen that really sets up a match is `ULiveNUIDebugBootMenuWidget`. Its PlayGame path is made entirely of Bandai steps:
1. GAC login and sign-up, which gate B refuses.
2. NM StartMatching `0x1474af800`, which goes to Chronicle.
3. A Strix room wait (`0x1474b39e0` on `SM+0x1fa`).
4. A Strix-gated aircraft select.
5. The travel, which RVNG already does directly.

So this group gives RVNG nothing:
- Never open `WBP_DebugBootMenu`.
- Never call `0x1474af800`, `0x1474b0980` / `0x1474b00d0`, or Chronicle `ApplyMatchDebug 0x1453fbbe0` / `JoinLobbyDebug 0x1453fca60`.

## 5. Safety: D9, the network wall (built 2026-11-19, runtime 0.3.6)

D5 shut only the two web gates a session was seen asking. A second static audit (2026-11-19: three maps, each checked by a separate verifier; labels [V] verified, [I] inferred, [?] open) found every place the game's code can reach an outside server, and where all of them can be stopped. D9 hooks those places in every install, beside D5 and D8.

**The send points D9 refuses** (signatures in `native/sigs.h`, each checked unique with `tools/re/sigcheck.py`):

| Send point | Covers | D9's answer | Effect [V unless noted] |
|---|---|---|---|
| LiveWebAPI element Start `0x148088980` | all 111 LiveWebAPI endpoints, gated or not: the 11 gates, 7 makers with the gate inlined, the GAC+0xf8 inline checks, 8 log uploaders, the scheduler's Heartbeat, protected-code makers | `4` ("no request"); element marked started, not done | The queue drops it: no HTTP request, no callback, no dialog, no retry. The game's own exit for an element with no request. |
| Cosmos `UWebApiConnect` sender `0x145449cc0` | all 20 Cosmos APIs (SysGetEnv, UserAuth, UserLogin, SysKpi, NG-word checks, purchases, Bnid), including the ungated boot-login branch | `0` | Each API returns its own "not sent". Cosmos doesn't use the LiveWebAPI. |
| `FCurlHttpRequest::ProcessRequest` `0x141ef0c50` (vtable slot 26) | every engine HTTP request: libcurl is the build's only HTTP library, and its one constructor call site is in `FHttpModule::CreateRequest` | the URL (`+0x268`) emptied, then the engine's own code | PreProcess fails it before anything is queued or resolved, through `FinishRequestNotInHttpManager`: the caller gets a failure callback, as for an empty URL. An object whose vtable isn't the curl class's is returned unsent. |
| `lws_client_connect_via_info` `0x14a38cba0` | every WebSocket client (the Chronicle matchmaker) | `NULL` | The UE WebSockets caller takes its "Could not initialize connection" path. |
| The game's Strix start `0x1474ec7e0` | the Strix client and master server (game path) | return | The client global stays null, as measured offline. Only the online lobby part's task calls it. |
| The game's Messenger set-up `0x1474f0200` | the Strix Messenger | return | No client (`+0xf8`), so its connect `0x1474f0740` returns at once. |

**The gates, all false in every install** (D5's A and B, D9's nine more; each logs its first 20 calls and then at powers of 2):

| Gate | Controller (endpoints) | How RVNG finds it |
|---|---|---|
| `0x147926ce0` (A, D5) | party, … | call site `0x1474e0e71` |
| `0x147959480` (B, D5) | GAC login steps | its own bytes |
| `0x1479297c0` | Aircrafts, Airsets, BoostTickets, Notifications, Rankings … | call site `0x1474d34e2` (two byte-identical copies exist) |
| `0x14794c290` | Lobbies, Mails, Gashas, DisplaysSchedules | call site `0x14794bf8e` |
| `0x14797c390` | Items | call site `0x14797c190` |
| `0x147972270` | Guilds, InstantRadiosets | call site `0x14777713b` (gate A's body) |
| `0x1479a16e0` | ApiVersion, MasterIndex, MasterFile | call site `0x1479a0f40` (gate A's body) |
| `0x147951270` | Friends | its own bytes |
| `0x1479c55b0` | Settings | its own bytes |
| `0x147940b70` | Blocks (a variant the first audit missed) | its own bytes |
| `0x147942010` | Currencies (a variant the first audit missed) | its own bytes |

Not hooked:
- `0x147945bc0`: it only returns "LiveWebAPI != null" for 12 getters of cached data. None of them sends anything, so false would only hide data.
- `0x15c413210`, Emotes: its code sits in the protector's section, and its stub can't be relocated.
- `0x147938b90`, Avatars: VM-protected code.

The Start refusal covers all three.

**What the game does with these** (measured in game, 2026-11-19):
- The master-data gate is asked by a per-frame tick at `0x1479a00a0`, about 100 times a second at the menu and through the deathmatch. The game's own gate answers yes to half of these calls.
  - Its caller only acts when a pending flag (`+0xc8`) is set. That action builds master-data requests, which Start would drop.
  - So a false answer changes nothing visible.
- No other D9 gate was asked.
- No LiveWebAPI request was queued in a whole session (AddRequest watched by the test logger).
- Nothing reached any send point (every refusal count 0).

**Measured, not assumed.** The autotest gate samples the game's TCP/UDP table four times a second during every run (`tools/autotest/netwatch.py`; the `NET:` line). With `netlog=1`, the runtime's observe-only network log (`native/netlog.h`) records which module looked up or connected to what. Before D9 (0.3.5) and with it (0.3.6, `prod` 6/6 and `net_dm` 16/16), the only outside contact in a whole session was:
- the EOS SDK's own: `EOSSDK-Win64-Shipping.dll` looks up `api.epicgames.dev` and keeps a TLS connection to Cloudflare (`104.18.124.108`/`104.18.125.108:443`);
- nothing from the game's own code.

Whether to block EOS is a separate decision: it is Epic's service, not Bandai's, and it is anti-cheat-adjacent.

**EOS, looked into (2026-11-19, measured):**
- **What the game asks of EOS.** The exe delay-loads 296 EOS functions; a session looks up 32 of them, all within 0.1 s of start (netlog's GetProcAddress log, through the exe's delay-load helper at `exe+0xA8BC7F2`):
  - `EOS_Initialize`, `EOS_Platform_Create`, application and network status, `Tick`;
  - the `Get…Interface` calls (Auth, UserInfo, UI, Friends, Presence, Connect, Sessions, Stats, Leaderboards, Metrics, Achievements, TitleStorage, PlayerDataStorage, P2P, Lobby);
  - notification registrations (display settings, session and lobby invites and updates, Connect auth expiration);
  - two of EOS's anti-cheat interface functions (counted only, never named or followed).
  - **No login** (`EOS_Connect_Login`, `EOS_Auth_Login`), no query, no metrics session, no stat ingest.
- **The connection** is the SDK's own platform start-up, about 12 s after load.
- **The block, a test switch `eosblock=1`** (`native/eoswall.h`):
  - when the EOS SDK loads (ntdll's DLL-load notification: imports bound, none of its code run yet), its import slots for the Winsock calls that reach out, and `GetProcAddress`, point at wrappers;
  - the wrappers let loopback through and answer everything else as an unknown host or an unreachable network, without resolving or sending;
  - no game or EOS code is patched.
- **Results:**
  - `net_eos` 8/8 and `net_dm_eos` 17/17 (twice): no outside connection by the game at all (netwatch), 0 outside calls in netlog.
  - EOS retries its lookup every few seconds (57 in a 6-minute run), each refused, each with a loopback socket pair of its own.
  - The menu looks the same, with no error.
- **Seen in some runs, owner not yet known:** about 30 UDP sockets bound together on `0.0.0.0` (2 of 7 runs, with and without the block). netlog saw no outside send from any module. netlog now also logs `bind` (with the caller) and `WSASendMsg`, so the next time they appear their owner is named.

**Not covered by D9** [V]:
- the EOS SDK's own sockets (above);
- Steam (IPC to the Steam client);
- the protector's own WinINet, which is called only from VM code and not analysed;
- Strix's own socket layer: covered only through the game-side Strix and Messenger refusals;
- UE's IoStore on-demand raw-socket client (not configured in this install);
- NVIDIA Streamline's update check (in NVIDIA's DLLs).

The crash reporter's Slack post is compiled out:
- `ULiveCrashReportSubsystem::ShouldCreateSubsystem` returns false;
- its Initialize is empty;
- the exe has no Slack API strings;
- `CrashReportClient.exe` isn't shipped.

**Timing.** The hooks go in once the runtime's scan finishes:
- the scan now buckets its signatures by first byte: 56 signatures in 2.6 s, down from about 11 s for 41;
- D9 is installed first;
- requests sent before that aren't covered, but none was seen (netlog starts within 0.1 s of the runtime).

## 6. Corrections to earlier notes

- `0x1474af800` **starts** a matchmaking search (StartMatching [I name]); it is not CancelMatch. Its "CancelMatch" text (code `0x10c8e1`) labels only the branch taken when a match is already running. Its callers are the lobby MatchMaker `0x1477e7afa` and the debug boot `0x14756faa7`. The real cancel is `NM 0x1474b1180` (Chronicle, `GI+0x918`). This fixes `deathmatch/deep_pass.json`.
- In reflection, `UDM+0x12a0` is **PenaltyAPIController**. The LiveWebAPI itself is `GI+0x970`, which gate A caches at `ctrl+0x40` and gate B at `GAC+0x108`.
- GameInstance members, from reflection [V]:

  | Offset | Member |
  |---|---|
  | `0x910` | StrixManager_ |
  | `0x918` | MatchmakerManager_ |
  | `0x920` | StrixMessenger_ |
  | `0x928` | NetworkManager_ |
  | `0x930` | NetworkP2P_ |
  | `0x948` | PartyManager_ |
  | `0x958` | MissionRoomMemberManager_ |
  | `0x970` | LiveWebAPI_ |
  | `0x980` | NUIManager_ |

- UserDataManager members [V]:

  | Offset | Member |
  |---|---|
  | `0xfb0` | General |
  | `0xfc8` | User |
  | `0x1010` | Block |
  | `0x1220` | Result |
  | `0x1238` | Settings |
  | `0x1270` | AcePass |
  | `0x12a0` | Penalty |
  | `0x1330` | Log |

  Each of these is the name of an APIController.

- GM EndPlay's LeaveRoom **does** run offline. Earlier notes said it ran only when `SM+0x1fa` or `SM+0x30` was set.

## 7. What to build, in order

1. ~~**D9: close the rest of the web API**~~ Done (runtime 0.3.6, 2026-11-19; section 5).
2. **RVNG's own result panel** instead of the stock Result screen, while D6 stays. It needs no fake web data and shows the real match data. **First version done** (2026-11-19, DEATHMATCH_NATIVE.md 9.12): MATCH RESULT, VICTORY / DEFEAT / DRAW and both scores, in the main menu's own text widgets after D6 brings the pilot back.
3. **RVNG's own queue display** (searching / found / connecting / cancelled). No AC8 screen has one offline. **Partly done** (2026-11-19): the ready-up screen (`Scripts/rvng_ready.lua`, DEATHMATCH_NATIVE.md 9.12) shows match found / connecting / ready / launching in the main menu's own text widgets:
   - the header, the COMPETITIVE 1V1 row and the description line, which are LiveLocalizeTextBlocks inside `WBP_Menu_MainTop_000`;
   - written by SetText every tick, because the game reads RVNG's text hook only when it builds the menu.

   **Done** (2026-11-19 evening): RVNG's pages (`Scripts/rvng_pages.lua`) are the queue display, in the same widgets:
   - MULTIPLAYER > RANKED 1V1 / CASUAL 1V1 > LOBBY (SEARCHING..., the opponent, READY UP, LAUNCHING IN n, LEAVE LOBBY) > MATCH RESULT;
   - the game's own cursor is placed on each page by its own SetSelectedIndex;
   - in game: `ui_pages` 19/19, `dm_r` 46/46 (DEATHMATCH_NATIVE.md 9.12).

   The press by a real controller, keyboard and mouse still needs the hand check (IN_GAME_TESTS.md).
4. **Optional: SET SELECT over the main menu** (section 1), after the link layer works. It needs:
   - the page-row insert;
   - a filled aircraft-set list, whose entry layout needs RE first;
   - the opponent's pick relayed over the link;
   - the state-3 release;
   - the faction re-apply.

   The first in-game step would be opening the page with an empty list and confirming it shows and closes with no gate call.

Open questions are in each group's `openQuestions` in `online_ui/audit.json`. The ones that matter most:
- the aircraft-set entry layout, and whether any save data fills it offline;
- the result record's field layout;
- what `LiveRandomEventSubsystem+0x31` is;
- whether the 9 extra gates answer true in an RVNG session.
