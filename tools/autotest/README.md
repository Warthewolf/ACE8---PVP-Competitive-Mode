# tools/autotest: RVNG's in-game tests, unattended

An agent installs RVNG's mod with a self-test, starts the game, runs scripted checks inside it, collects PASS / FAIL, and leaves the install exactly as it was. Nobody needs to be at the controller.

The design comes from the user's upload of 2026-11-18, "AC8 automated in-game testing: how ours is built". The code is RVNG's own copy of Survival Mode's `tools/autotest` (gate, kit, job), adapted. Every rule below came from a real failure.

```
agent --queues--> gate.py (one game run at a time, shared queue, safety, restore) --runs--> job.py (install, launch, watch, verdict)
                                                                                              |
                                                                                              +- in the game: rvng_selftest.lua logs PASS/FAIL
```

## The user's yes (2026-11-18)

- **Launches.** Gated runs may start the game whenever it's closed.
- **Other mods.** All other mods are moved aside for each run and put back after. The one exception is **SkipIntro**, kept so the title page needs no button press.

## Run one

```
python -I tools/autotest/gate.py run --who rvng --label "dm_a" --max-minutes 15 \
    --cleanup "python -I \"<repo>/tools/autotest/kit.py\" restore" -- \
    python -I "<repo>/tools/autotest/job.py" --suite dm_a
python -I tools/autotest/gate.py status
python -I tools/autotest/gate.py cancel --who rvng      # the only safe stop (never kill the gate: then nothing is restored)
python -I tools/autotest/gate.py recover --who rvng     # after a gate killed from outside: its cleanup, by hand
```

- **Running it.** Start `run` in the background; it waits until it's this run's turn.
- **Results.** Each run gets its own folder, `build/autotest/runs/<stamp>_<who>/`, holding:
  - `verdict.txt`, `provenance.txt` and `job_out.txt`;
  - `rvng_logs/`: the runtime's log, with the self-test's lines in it;
  - `UE4SS.log`;
  - `install_diff.txt`, only if something changed;
  - `crash_*`, only after a crash.
- **Gate log.** `build/autotest/gate_log.txt` has the START / LAUNCH / END lines, and the shared queue folder's `gate_log.txt` gets copies tagged `[RVNG]`.

## Settings (`.env`, git-ignored; `.env.example` lists them)

- `AC8_DIR`: the game's install folder.
- `AC8_GATE_QUEUE`: **the queue folder shared with Survival's gate** (Survival's main tree's `build/autotest`). It keeps every project's runs one at a time. Without it, RVNG's runs could start the game while a Survival run is going.
- `LLVM_BIN`: for `native/build.sh`.

## Suites (`docs/IN_GAME_TESTS.md` explains tests 1 and 2)

| Suite | `rvng_test.ini` | What it checks |
|---|---|---|
| `smoke` | `d2=0 w1=0` | The runtime answers. All 8 hooks are in (the 2 web gates, D8's ReportCheat, the logger's 5). The main menu is reached with no input. Offline there. |
| `menu` | `d2=0 w1=0` | Smoke, then STORE off and ONLINE turned into RVNG's COMPETITIVE 1V1 row (`rvng_menu.lua` + the DLL's text and decide hooks), its label answered, a picture. The job then posts Down, Down, Enter (`selftest: KEYS`). Posted keys don't reach an unfocused game, so a press that isn't seen is only noted. The rows are checked again 30 s later. |
| `flags` | `d2=0 w1=0` | Test 1: smoke, then `watch_s` (60) more seconds at the main menu, offline the whole time. |
| `dm_a` | `d2=0 w1=0` | Test 2 run A: the game's own mission-by-ID travel to PL_DM_001, the online states up to 12 (SyncStartMatch), held there for 60 s. |
| `dm_b` | `d2=1 w1=0` | Run B: RVNG's start releases 12, the 210 s match runs (14) to time-up, held at 15. |
| `dm_c` | `d2=1 w1=1 d6=1` | Run C: W1 takes it on through 16..19 (Ended). D6 then sends the game to the main menu instead of the Result map, which crashes offline. |
| `dm_f` | `d2=1 w1=1 d6=1 faction=2` | Test 6: dm_c with the local user's faction entry written as Bravo: the plane is Bravo and starts on a Bravo start point; end pictures. |
| `dm_s` | `d2=1 w1=1 d6=1 opponent=1` | Test 3: dm_c with a fake second member in the room tables: the game's remote spawn makes the opponent's copy (role 2, netId 2); the tables are emptied after the match. 9 hooks. |
| `dm_l` | `dm_s` + `loopback=1` | Test 4, the loopback mirror: the local plane's Physics captured at Send (replaced), encoded and decoded with the game's MessagePack code, re-keyed and routed to the copy, which flies 150 m ahead. The plane leaves the combat area, so D8 must switch off the game's combat-zone cheat reports, and no Cheat message may reach Send. 11 hooks. |
| `dm_l3` | `dm_l` + `lb_role3=1` | Test 5: the local plane at role 3 (as online); the game refreshes and sends Physics itself; the synced clock is checked against TriggerTimes. |
| `dm_h` | `dm_l3` + `hit=1` | Test 7: the local plane hits the copy through the copy's own TakeDamage (30 %, then lethal), then the copy respawns. Checks damage, score, the Damage and ScoreAddition messages, the kill and the respawn, with a picture. |
| `dm_g` | `dm_h` + `guest=1` | D3/D4: this PC is the guest (player 2). Its hits on the host's plane (the copy, 2/1) become DamageClients (D3), handed to this PC's own DamageClient handler standing in for the host. Its score function is off (D4). 13 hooks. |
| `dm_x` | `d2=1 w1=1 d6=1 linkloss=120` | The lost link: 120 s into the match, the game mode's forced end (Finished), then W1, Ended, D6 and the main menu. |
| `prod` | `probe=0` | A normal install (runtime 0.2.4+): only the 3 always-on hooks (the 2 web gates and, since 0.3.5, D8's ReportCheat), the refused boot login ended by D7 through the always-on tick (`rvng_native.lua`), Online/Store off, no gate asked again, pictures of the menu. |
| `net` | `prod` + `netlog=1` | D9's measurement, menu only: prod's steps with `native/netlog.h`'s observe-only network log, which logs each module's connects, sends and name lookups (`netlog:` lines in the runtime's log) and blocks nothing. A last step reports its counts. |
| `net_dm` | `dm_c` + `netlog=1` | The same through a deathmatch, its end and the main menu after it. |
| `link` | `prod` + `netlog=1` | The link's Steam side on one PC: ISteamNetworkingMessages found, relay-only set and read back, Valve's relay network ready, this PC's SteamID read, a link to itself refused. |
| `dm_k` | `dm_l` + `wire=1` | The loopback mirror carried by a pair of links inside the game (`native/link.h`): hello, clock, D2 opened at the agreed GO time, every message through the link. |
| `dm_kx` | `dm_k` + `linkloss=110` | The wire cut 110 s into the match: the link's own loss detection (6 s) brings the forced end, then W1, D6 and the main menu. |
| `dm_r` | `dm_k` | RVNG's pages first (MULTIPLAYER > RANKED 1V1 > the LOBBY, pressed for the pilot through `Pages.press`), then the ready-up screen: the main menu's header, COMPETITIVE 1V1 row and description show it; this PC readies (the stand-in peer with it), the host's LAUNCH, the countdown, both launch at the agreed time, then the match. |
| `ui_scan` | `prod` | Read only: the main menu's text widgets (class, full name), for the ready-up screen. |
| `ui_pages` | `prod` | RVNG's pages at the main menu, no match (about 2.5 min): MULTIPLAYER > RANKED 1V1 > LOBBY > LEAVE LOBBY > BACK, with the cursor checked on every page; then B / Esc in the LOBBY and on MULTIPLAYER (0.4.1: `RVNG_MenuBack` sets the menu's pending-cancel byte, so the game's own tick runs its cancel path into RVNG's BACK). |
| `dm_p` | `dm_r` with `probe=0` | **A normal install's match on one PC** (0.4.1): no test logger, so the match hooks idle from the start until the ready-up screen's launch arms the match; dm_r's pages, ready-up, match and result page on the in-process link pair (`rehearse=1`, a stand-in peer instead of Steam); then the disarm after the travel back. |
| `hangar` | `prod` + `hangar=1` | **The stock pre-sortie hangar** (0.4.2, docs/re/HANGAR.md, about 4 min): the main menu's own travel into the hangar (Mission014), a picture of every page on the way to STANDBY (each pressed by its own decide), the opponent's plane on the wingman's spot, B back out, the HANGAR MENU's other pages (`--conf visits=0` skips them), QUIT, B to the main menu. SORTIE is never pressed. |
| `hangar_p` | `dm_p` | **RVNG's lobby in the hangar on one PC** (0.4.3, about 2.6 min): RANKED 1V1, the match found, both into the hangar, the walk to STANDBY, READY UP / SORTIE (LOCKED), the stand-in's F-14A on the wingman's spot (the display group's own plane is checked), the FLIGHT panel's names, SORTIE refused before both are ready, READY UP, SORTIE, the synced launch, the deathmatch with the copy in the stand-in's F-14A. `--conf leave=1`: LEAVE THE HANGAR instead (back on RVNG's MULTIPLAYER page); `leave=2`: B from STANDBY to the HANGAR MENU and B there (the hooked quit); `leave=3`: the stand-in's link cut on STANDBY (the opponent gone); `full=1`: the match to time-up, the result page, PLAY AGAIN and a second hangar session (~7 min). |
| `pvp` | `dm_r` + `wire=2` | **The two-PC test.** Run on both PCs at the same time: `job.py --suite pvp --link-peer <the other PC's SteamID64> --link-player 1` on the host, `2` on the guest, the same `--link-tag` on both. Steam relay-only between them: the ready-up screen on both, the launch together, D2 at the agreed GO time, the guest on the host's clock, each plane flown on the other PC by its own Physics, then time-up, W1, D6. (Planes fly on with no input; hits across the PCs are wired but not exercised by this suite.) |

Every suite runs with `d7=1` (the boot login end; `docs/re/DEATHMATCH_NATIVE.md` 9.2). The web gates always answer false: a `gates=` line other than `block` is ignored.

Since runtime 0.3.6, every suite also checks D9, the network wall (`DEATHMATCH_NATIVE.md` 9.10, `ONLINE_UI.md` 5):
- right after the hooks step, that its 6 send points and 9 more web gates are hooked (`RVNG_WallInfo`). They are counted apart from the hook counts above;
- as its last step, an `INFO D9 refused:` line with what the game tried to send (all refused) and how often the extra gates were asked.

With the test logger on, the runtime also logs every LiveWebAPI request queued. The same last step checks that the EOS SDK's own outside calls are refused (`native/eoswall.h`, part of D9 in every install since 2026-11-19): its reaching-out imports all point at the refusing wrappers. The gate's `NET:` line should then list no outside connection.

`job.py --mission 160020` (or 160030, 160040, 160060) runs a deathmatch suite on another map. All five maps passed `dm_a` on 2026-11-18.

The deathmatch suites use a **fast path**. The DLL's `RVNG_TravelDM` does exactly what the menu transition's mission-by-ID branch does:
1. sets `UDM+0xf38` to the MissionID;
2. looks up the level row;
3. calls `RequestChangeMap(GI+0x888, &row+0x48, an empty FString)`;
4. runs the NetworkManager's prepare step.

This skips the hangar and the loadout. So on RESULT the **job closes the game**; the game's own exit flow never runs.

## The pieces

- **gate.py.** Its jobs:
  - the queue, shared through `AC8_GATE_QUEUE`; the user playing counts as busy;
  - a snapshot of Win64 + Paks (size, mtime) before the run;
  - a backup of the saves (a copy left by a killed run is the true pre-run state and goes back first);
  - every second while the job runs, it checks for:
    - the job's launch flag, which starts the safe launch;
    - a cancel flag;
    - anti-cheat (kill, rc 99);
    - free commit under 3 GB (kill, rc 97);
    - the max time (rc 124);
    - the driver-warning box, which gets a posted No: a WM_COMMAND to its own message loop, never a sent BM_CLICK;
    - the lowest free RAM, which is only recorded (`memory:` line at the end). The GPU crash of 2026-11-19 12:28 came with 0.7 MB free while other work on the PC filled the RAM.
  - Throughout, `netwatch.py` samples the game process's TCP and UDP tables every 0.25 s (read-only, like `netstat -ano`) into `<run>/net_watch.json`. A `NET:` line in the gate log lists every outside address the game reached, named from the local DNS cache where it can be. It never fails a run; it reports.
  - Always afterwards:
    - the cleanup command runs;
    - changed saves are put back;
    - the snapshot is diffed (a difference = rc 4);
    - a new crash folder means rc 3.
- **The safe launch.** It is never Steam's Play or `steam://run` with mods in. It starts the game exactly the way the mod launcher's Play modded does: ShellExecuteEx with the user's environment. It refuses if:
  - the game or anti-cheat is already running;
  - Steam isn't running;
  - UE4SS is missing;
  - free commit is under 20 GB.

  It counts as good once UE4SS.log names ProjectRVNG.
- **kit.py.** Install:
  - moves every mod folder except SkipIntro and `shared` into `build/autotest/aside`, each move recorded as it happens;
  - copies RVNG in as a new folder: a marker first, then a sha256 manifest;
  - adds the test-only overlay: `rvng_selftest.lua`, `selftest.txt`, the suite's `rvng_test.ini`, and `require("rvng_selftest")` in the installed `main.lua` copy.

  Restore copies RVNG's logs out, removes our folder (only with this install's marker) and moves the user's folders back.
- **job.py.** It installs the kit, writes the provenance, asks the gate to launch, and follows RVNG's log. The watchdog fires after 180 s with no new line. On `selftest: RESULT` it closes the game, then restores the kit and writes `verdict.txt`.
- **lua/rvng_selftest.lua.** A list of steps on RVNG's one game-thread tick (`rvng_tick.lua`, once a second). It never uses a coroutine and never runs on UE4SS's async thread. It writes `selftest: PASS|FAIL|INFO ...` and finally `selftest: RESULT n/m` into the runtime's log through `RVNG_Log`.

## Rules (adopted as they are)

1. Every game run goes through the gate, with `--cleanup`. Nothing else starts the game for a test.
2. Stop a run with `cancel`, never by killing the gate.
3. A crash stops that test line. Don't run it again until the cause is found and written down.
4. Leave the launcher's mode alone.
5. The self-test and its overlay are installed by kit.py only, never in a build or a zip.
6. Each result names its build (`provenance.txt`), its path (the fast path) and anything test-only it used.
7. Never call `FindAllOf` / `FindFirstOf` every tick: about 10 ms each. The self-test looks for the main menu every 5 s.

## Lessons from the first runs (2026-11-18)

- **The main menu.** `FindFirstOf("LiveMenuMainTopWidget")` never matches: FindFirstOf takes the exact class only, and the menu's widgets are blueprint subclasses. The self-test watches for the runtime's logged `RequestChangeMap` to `PL_MainMenu` instead.
- **Settling.** 20 s after that request, only the menu's background and a loading icon are on screen. The deathmatch travel works from there anyway.
- **States.** NextState calls SetState after its increment. Ended (18 → 19) and its travel happen in one frame, and the game mode is gone by the next Lua tick. So the self-test also reads the hooks' last state (`RVNG_LastState`).
- **The Result map crashes offline.** It divides by a season count that comes from the web API, which RVNG blocks. `d6=1` (the `dm_c` suite) sends Ended's travel to the main menu instead.
- **A gate killed from outside skips its cleanup.** At 18:50 Claude Code stopped the background gate mid-match because the PC was low on memory: the game commits 20-30 GB while loading. The user's mods were left aside and the test install stayed in. `gate.py recover --who rvng` now does the gate's cleanup by hand: the kit restore, the saves, the install diff and the crash check. Claude Code's notice says not to start the stopped run again until the user asks.
- **It happened again at 19:33**, this time during boot. Both stops came while the agent's session sat idle waiting for the run; the picture run of 19:03, during which the agent kept working, was never stopped. Starting Claude Code with `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` turns this off; it's the user's choice. `recover` restored the install the first time it was used for real.
- **Pictures.** A `selftest: SHOT <name>` line makes job.py capture the game's window into the run's `shots/`. It uses PrintWindow, takes no focus, and also reports whether the window still responds.

## Checks without the game

- `mod/test/selftest_test.lua`: the suites against a fake game.
- `mod/test/probe_test.lua`: the tick and the probe.
- `native/tests/run.sh`: the DLL's hooks, travel, watch and the Result-map redirect.
- `python -I tools/autotest/tests/netwatch_test.py`: netwatch.py against a loopback connection, a listener and a UDP bind of its own Python process (nothing leaves the PC).
- `python -I tools/autotest/tests/kit_test.py`: kit install / restore against a fake game folder in `build/autotest_test`. It covers the user's own ProjectRVNG, a folder in the way of a move back, an install cut short, and leftovers in aside.
