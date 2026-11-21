# In-game tests 1 and 2: the native test logger

**These tests also run unattended.** `tools/autotest/README.md` covers the suites `smoke`, `menu`, `flags`, `dm_a`, `dm_b`, `dm_c` and `prod`. They:
- start the game through the shared gate;
- reach the deathmatch through the game's own mission-by-ID travel, with no input;
- log PASS/FAIL;
- leave the install as it was.

The steps below are the manual way.

These are the first two tests in `docs/re/DEATHMATCH_NATIVE.md` section 9. They check the research before anything else is built on it. The test logger is RVNG's native DLL, version 0.1.x (`native/rvng_rt.c`).

- **It never sends anything** and never turns on a Strix flag.
- **It only changes the game in five ways**, marked below. Only the web-gate block works on its own. The other four need Ctrl+F6, `d2=1` or `w1=1`.
- **It is off by default.** With `probe=0` in `rvng_test.ini`, or with no `rvng_test.ini` at all, it logs its version and hooks nothing.

## What it does when it's on

- **Watch, once a second.** It logs the values that prove the game is offline:
  - the Strix client global;
  - `StrixManager +0x1f8/+0x1f9/+0x1fa` and `+0x30`;
  - the EOS P2P object's `+0x28`;
  - `GI+0x970` (LiveWebAPI);
  - `UserDataManager +0x12a0`, `+0xfb0`, `+0xf38` and `+0xf3c`;
  - `NetworkManager +0x538/+0x610/+0x614`.

  A line is written whenever a value changes, and a full line every 10 s. If a value that should stay 0 isn't 0, it writes `watch: NOT OFFLINE`.
- **Web gates** (`gates=block`). Both LiveWebAPI gates are hooked. The log shows what the game's own gate answered, and RVNG answers false, so no web-API call can go ahead. **Game change 1.**
- **Game-mode states.** Every online state change (SetState/NextState) is logged with the deathmatch fields: `+0x5f1`, `+0x498` (the match length), `+0x80c`, `+0x804`, `+0x521`, `+0x538`, `NM+0x538`, `NM+0x3d8` and `NM+0x740`.
- **Ctrl+F6 in the hangar.** It writes the deathmatch MissionID (`mission=`, 160010 by default) into `UserDataManager+0xf38` and clears `NM+0x538`. **Game change 2.**
- **Travel.** The menu transition logs `+0xf38/+0xf3c/+0xf60`. If Ctrl+F6 armed it and `+0xf3c` is a campaign level (19..49), `+0xf3c` is set to 99991 (OnlineStartup, the value the online flow uses) so the game travels by MissionID. **Game change 3.** RequestChangeMap logs the map it loads.
- **`d2=1`.** The SyncStartMatch phaseIndex gate answers true. This stands in for RVNG's synchronized start. **Game change 4.**
- **`w1=1`.** It writes `GM+0x80c = 2` when GameTerminating (state 15) starts. **Game change 5.**

Each session writes its own log: `ue4ss/Mods/ProjectRVNG/logs/RVNG_<date>_<time>.log`.

## Install

1. Build the DLL with `sh native/build.sh`. Set `LLVM_BIN` to LLVM's bin folder if LLVM isn't on PATH.
2. Install it with `AC8_DIR="<game folder>" PROBE=1 sh tools/install_mod.sh`. This copies the Lua scripts and `dlls/main.dll` to `<game>/Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/` and turns the logger on.
3. Edit the installed `rvng_test.ini` between runs. It is read once, when the game starts.

To remove everything, delete that `ProjectRVNG` folder.

## Test 1: flag watch

Use the settings `probe=1`, `gates=block`, `d2=0`, `w1=0`.

1. Start the game and wait about 30 s at the main menu.
2. Play a short Survival sortie, or any campaign or free mission, through to the result screen.
3. Go back to the main menu and quit.

**Pass:**
- Every `watch:` line shows `client 0`, `1f8 0 1f9 0 1fa 0` and `P2P+28 0`.
- `NOT OFFLINE` never appears.
- Note the `web gate` lines: they show what the game's gates answered, and from where.

## Test 2: solo deathmatch travel

Use one PC, with the **network cable unplugged or Wi-Fi off**. Do three runs, changing `rvng_test.ini` before each one.

**Every run starts the same way:**
1. Main menu → Free Mission → any mission.
2. In the hangar, pick a plane.
3. Press **Ctrl+F6**. The log shows `Ctrl+F6: armed`.
4. Press Sortie.

| Run | Settings | What to expect | What to do |
|---|---|---|---|
| A | `d2=0 w1=0` | `RequestChangeMap ... PL_DM_001`, then states 1 → 12, then it **stalls at 12** | Wait 60 s, then quit (Alt+F4 if the pause menu has no exit) |
| B | `d2=1 w1=0` | It passes 12 and the 210 s clock runs (14), then it **stalls at 15** | Wait about 4 minutes, then quit |
| C | `d2=1 w1=1` | 15 → 16 … 19, then the Result map | Write down what the Result map shows and whether it gets stuck |

**If the sortie doesn't load a `PL_DM_00x` map, stop.** That's when the RequestChangeMap line names a campaign map, or there is no transition line. Send the log: the travel route needs changing before going on.

## Hand check: the MULTIPLAYER pages (no match needed)

The unattended suites `ui_pages` and `dm_r` press the rows for the pilot, because posted keys don't reach an unfocused game. This check is the real controller, keyboard and mouse.

1. Build the DLL, then install normally (no `PROBE`): `AC8_DIR="<game folder>" sh tools/install_mod.sh`. Start the game the usual way.
2. On the main menu, MULTIPLAYER sits where ACE COMBAT ONLINE was. Press it.
   - **Expect:** the header reads MULTIPLAYER, the rows read RANKED 1V1, CASUAL 1V1, BACK, and the cursor is on RANKED 1V1.
3. Move up and down with the D-pad, the arrow keys and the mouse.
   - **Expect:** the highlight moves with the game's own sound. The two blank rows can be highlighted, and pressing them does nothing.
4. Press RANKED 1V1.
   - **Expect:** the LOBBY with RANKED 1V1, SEARCHING... and LEAVE LOBBY, the cursor on the second row.
   - Without the companion app running, nobody is found; the request file is still written.
5. Press LEAVE LOBBY.
   - **Expect:** MULTIPLAYER again, the cursor on RANKED 1V1.
   - Repeat steps 4 and 5 with CASUAL 1V1.
6. Press BACK.
   - **Expect:** the stock main menu (CAMPAIGN ... QUIT GAME), the cursor on MULTIPLAYER. CAMPAIGN and the other rows work as before.
   - BACK is drawn on the stock QUIT GAME row; the DLL takes that press while a page is up. If the game's quit prompt appears instead, answer No and say so.
7. Press the controller's B, and Esc on the keyboard, on each page (runtime 0.4.1).
   - **Expect:** the same as the page's BACK row. In the LOBBY that's LEAVE LOBBY (back to MULTIPLAYER); on MULTIPLAYER, back to the stock main menu with the cursor on MULTIPLAYER.
   - On the stock main menu B and Esc still do nothing, as before.

Send back what you saw at each step, and the `RVNG_*.log`. Its `main menu: RVNG's pages up` / `down` lines mark each page, and `main menu: B/Esc n on RVNG's page: BACK` each B / Esc press.

## Hand check: the lobby in the hangar (runtime 0.4.3; during the two-PC run)

The unattended suite `hangar_p` runs this on one PC with a stand-in opponent and presses for the pilot. With your friend, both PCs do it for real, with the controller and keyboard (docs/re/HANGAR.md).

1. Both of you: MULTIPLAYER > RANKED 1V1 (or CASUAL 1V1), and wait in the LOBBY until the match is found.
   - **Expect:** both games travel into the hangar (a tropical airbase). For about 25 s the stock pages flash past (HANGAR MENU, SELECT AIRCRAFT, SP WEAPON 1 and 2, SQUAD): RVNG confirms them for you with the plane as it was last set. Then STANDBY.
2. On STANDBY, check the FLIGHT panel on the right.
   - **Expect:** your RVNG name over the game's REX, with your plane and special weapons; the opponent's RVNG name in the wingman's row, with their plane and weapons.
   - **Expect:** only two planes on the apron: yours and the opponent's (theirs, not an ADF-X02).
3. Press SORTIE before anyone is ready.
   - **Expect:** the game's reject sound, nothing else. The row reads SORTIE (LOCKED 0/2).
4. Change your plane: SELECT AIRCRAFT (and the weapon or parts rows), pick something, come back to STANDBY.
   - **Expect:** on the other PC the opponent's plane on the apron and in the FLIGHT panel changes to yours within a few seconds.
5. Press READY UP (the row that was SELECT WINGMEN AIRCRAFT).
   - **Expect:** CANCEL READY (1/2) here, the description says you're ready; on the other PC their row shows (1/2) too. Pressing it again un-readies.
6. When both are ready: SORTIE reads SORTIE (unlocked). One of you presses it.
   - **Expect:** both PCs show SORTIE IN 5..1, then both launch into the same deathmatch together, each opponent flying their own plane.
7. After the match: the result page (MATCH RESULT), PLAY AGAIN takes you back to the LOBBY.
8. Another time: LEAVE THE HANGAR on STANDBY instead.
   - **Expect:** you're back on the main menu's top page; the other PC goes back too ("left before the match").
   - B / Esc on STANDBY goes back through the stock pages (to change the plane); on the HANGAR MENU, BRIEFING, SELECT DIFFICULTY and TRAINING give the reject sound, and QUIT MISSION or B there leaves the lobby (the main menu's top page, the other PC told).

Send back what you saw at each step, both PCs' `RVNG_*.log` (the `hangar:` and `lua: hangar lobby:` lines), and a picture of STANDBY from each PC.

## What to send back

From each run, send:
- the `RVNG_*.log` file;
- `ue4ss/UE4SS.log`;
- a line on what you saw on screen.

The results go into `docs/re/DEATHMATCH_NATIVE.md`. Section 10 lists the open questions they answer.
