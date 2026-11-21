# The stock pre-sortie hangar for RVNG's lobby

**What the user asked for** (2026-11-21):
- "Players need to be able to select their aircraft and edit them in the hangar before the match starts."
- Use the campaign hangar, with the opponent's aircraft where the wingman's normally stands.
- "Launch straight into the hangar", select everything on the screen that has SORTIE, and block SORTIE until both players
  have readied up.
- The plan the user OK'd ("Sounds good"): match found → both PCs straight into the hangar → set up the plane → READY UP
  beside SORTIE (the help line shows READY n/2) → SORTIE refused until both are ready → either press starts the 5 s
  synced launch.

**Research** (static, 2026-11-21; raw notes in `hangar/`):
- `hangar/flow_notes.md`: how the hangar is reached, its pages, SORTIE, the quit, the hook points.
- `hangar/wingman_notes.md`: how the wingman's plane is chosen and built, how to show any aircraft there, DLC.
- `hangar/allowlist.txt`: the 34 stock aircraft (32 base, ADF-X02, F-14A DLC) with their display blueprints and skins.
- `hangar/wingman_sigs.txt`: signatures.
- The online lobby's hangar (`LiveLobbyHangar*`, level 99995) stays off-limits: that map sends web requests (ONLINE_UI.md).

## 1. The in-game probe (runtime 0.4.2, `native/hangar.h`, the kit's `hangar` suite)

Test-only (`rvng_test.ini hangar=1`), on top of a normal install's settings:
- **The travel:** UDM+0xf38 = 6 (Mission006: free aircraft choice, PL_Hangar002), UDM+0xf60 = 2 (free mission), then the
  main menu page's own `GoToLevel(page, 13, 0)` (0x147a76cc0), as the stock free mission's difficulty page goes there.
- **The pages:** the menus' confirm input (the menu base, slot 0xDF, 0x147a79a30) is hooked. The page whose tick asks it is
  the active page. A press the self-test asks for runs that page's own decide (slot 0xEE) inside its own tick. B / Esc
  sets the page's own pending-cancel byte (+0x6c4).
- **A safety net:** GoToMission (0x147a76d00, the Sortie page's travel) is refused while RVNG's hangar session is up.
- **The opponent's plane:** `LiveHangarManager::ApplyGroupDisplay(mgr, 1, spec, 1)` (0x1472019a0) with a spec from the game's
  constructor (0x147201240), its emblem array freed with FMemory::Free afterwards, as the game's own callers do. The
  manager's hangar interface (+0x78 / +0x80) is checked first (the function doesn't check it). Only the 34 stock ids.
- **The command rows** (`LiveMenuCommandsDataTable`, from the game's usmap; the rows at page+0x690, count +0x698, stride
  0x1b8, read from the base row getter's code): +0x8 CommandID **FName**, +0x10 TextRefArgs, +0x18 TitleTextID **FString**,
  +0x28 a TMap, +0x78 HelpTitleTextID, +0x88 HelpTextID, +0x98 a TMap, +0xe8 BackGroundID, **+0xf8 MenuID FString**,
  +0x108 LevelId uint32, +0x110 OptionID, +0x120 DialogID, +0x130 StringArgs (all FStrings), +0x140 bIsInvalid, +0x141
  RefFeature, +0x142 InvalidAppearance.

## 2. Runs

### Run 1 (2026-11-21 10:16, crashed 10:17:57)
- **Worked:** 13 hooks; D9 and D7; RVNG's pages (pictures of MULTIPLAYER and the LOBBY); `RVNG_HangarGo`. **The hangar loaded in
  8 s:** RequestChangeMap to `/Game/Maps/Hangar/PL_Hangar002`, then `WBP_Menu_Hangar_Top_000_C` became the active page.
- **The crash:** an access violation reading 0xcc20 at exe+0x1870c08 on the game thread, from RVNG's row reader
  (`RVNG_PageRow`, main.dll → UE4SS's FName::ToString → the game's FName entry resolver 0x141870360).
- **Why:** the reader took the row's MenuID (+0xf8) as an FName. It is an FString (the usmap above). The low half of its data
  pointer (0x05ff6610) became a name id: block 0x5ff, which doesn't exist, and the game's resolver checks nothing
  (`add rax, [rdx + 8*rcx + 0x10]`, then the entry read at block + 0xcc20).
- **Fixed (before the rerun):**
  - MenuID is read as an FString.
  - Every FName RVNG reads from game data goes through `SafeNameText`. It finds the name pool by the resolver's signature
    (`kSigNameEntry`, the pool at exe+0xe367b80 in this build, blocks at +0x10), and checks the id's block exists and the
    entry's header and text are readable before asking for the text. Page class names too (a page pointer can go stale).
- Lowest free RAM 0.16 GB during the run (the gate's count): lower than the 0.38 GB of a deathmatch. Steam had been started
  just before. Not the crash's cause (the fault is the bad name id), but watched in the rerun.

### Run 2 (2026-11-21 10:23, 20/22, no crash, lowest free RAM 0.40 GB)
- **The hangar in 7 s again.** Its first page is the HANGAR MENU, titled with the context mission ("MISSION 05" for
  Mission006): START MISSION > SelectAircraft, AIRCRAFT SET > AircraftSet_SelectSlot, AIRCRAFT TREE, BRIEFING (LevelId 4),
  SELECT DIFFICULTY, TRAINING, QUIT MISSION (LevelId 2). Its background is a blueprint grid: the 3D hangar is hidden there.
- **The pages, each pressed by its own decide:** START MISSION → SELECT AIRCRAFT (`AircraftSettings_000`, the 3D hangar with
  the plane and ground crew) → SELECT SP WEAPON 1 → SP WEAPON 2 → SQUAD (`SquadSetting_000`: SELECT WINGMAN > SelectAircraft,
  RECOMMEND SETUP > Standby). The walk pressed the squad page's first row, which opens the wingman's aircraft page ("SELECT
  WINGMEN AIRCRAFT", Baxter's F/A-18C), so STANDBY wasn't reached (a test bug; run 3 presses the row to Standby).
- **B / Esc** (the page's own pending cancel) went back one page each time, to the HANGAR MENU; from AIRCRAFT TREE,
  SELECT DIFFICULTY and TRAINING in one each. AIRCRAFT SET was skipped (the test looked for the wrong MenuID).
- **The loadout (UDM):**
  - At the main menu: member 0 aircraft 24010, skin 0; the weapons and parts arrays empty.
  - The hangar's first page sets all four members to -1.
  - The aircraft page's confirm wrote member 0: aircraft 21010 (Su-57), skin 21002001, specials 17/21; the weapon pages
    filled **the weapons array (+0xdd8) with 12 ids** (2011802 2012802 2027802 ...). Parts stayed empty (no parts page on
    this path).
  - **B back to the HANGAR MENU reset member 0 to -1** (the weapons stayed). So RVNG reads the loadout on STANDBY (or at
    READY), never after the player backs out.
- **The opponent's plane:** `ApplyGroupDisplay` ran twice (Su-57, then the F-14A) on the HANGAR MENU, and refused 99999 and
  10013010. Not visible there (the blueprint background). The later pages' cameras frame the player's plane; one weapon-page
  picture shows a grey swing-wing plane behind the LACM, possibly the F-14A. Run 3 sets it again on STANDBY and takes
  pictures there.
- **QUIT MISSION** (its own row, LevelId 2) travelled to the main menu, but onto **FREE MISSION**
  (`WBP_Menu_CampaignFreeMission_000_C`): the quit's return page (menu context +0x18c) is 4 when the mode isn't campaign.
  RVNG's own way back must set it to the main menu's top (to find), or step back from there.
- No mission travel was tried (GoToMission refused nothing). `Campaign.sav` and `.bak` differed after the run (the gate put
  them back); the hangar boot marks the hangar as visited in the campaign data.

### Run 3 (10:31, 24/24) and run 4 (10:36, 26/26), no crash; lowest free RAM 0.04 GB and 0.49 GB
- **STANDBY is the screen the user described** ("select all our options from the Screen where it also allows us to sortie").
  Its rows: SORTIE (MenuID Sortie), SELECT AIRCRAFT, SELECT SP WEAPON 1, SELECT SP WEAPON 2, SELECT WINGMEN AIRCRAFT (a second
  SelectAircraft row), SELECT PARTS (SelectParts), LEAVE THE HANGAR (Top). Help line: "Sortie using the current setup."
  The FLIGHT panel lists the player (REX, Su-57, LACM / QAAM) and the three wingmen (Baxter, Tasha, Coster: ADF-X02 -PIX-).
  The 3D view is a slow cinematic pan along the flight lined up on the apron.
- The squad page's RECOMMEND SETUP row (MenuID Standby) leads there.
- **The opponent's plane on the wingman's spot works:**
  - On entering STANDBY the stock view had the wingmen's ADF-X02s again (the game refreshes the groups when a page builds).
  - RVNG then sent the F-14A: the STANDBY close-up shows a grey fighter with a Sidewinder on its glove pylon.
  - Then SELECT WINGMEN AIRCRAFT, whose camera frames display group 1: **it showed the F-14A** while the page's own panel said
    "ADFX-02 Morgan -PIXY-" (run 4, `hangar_13_wingman_page_stock`).
  - Sending a plane **while that wingman page is up** broke the view: after the F-14A again the spot stayed empty (the camera
    on the ceiling), after the F-15C the menu was hidden too (the page owns group 1 there and RVNG's call fights it). The
    page still answered B 2 s later and the run went on. RVNG's lobby never opens that page.
- **So, for RVNG:** send the opponent's plane after STANDBY has built (and whenever the link brings a new loadout), or
  detour ApplyGroupDisplay so the game's own refresh of group 1 carries the opponent's ids (wingman_notes 4). Hide
  SELECT WINGMEN AIRCRAFT, and the other wingmen (groups 2 and 3).
- AIRCRAFT SET (`AircraftSettings_001`, the set slots), AIRCRAFT TREE, SELECT DIFFICULTY, TRAINING: each opened and closed with
  B. QUIT → FREE MISSION; B three times → the main menu's top page.
- Pictures: `build/autotest/runs/20261121_103651_rvng/shots/` (23), sent to the user as JPEGs.
- **RAM:** the game alone takes nearly all of this PC's 31 GB (25 GB free with it closed); the hangar's pages took free RAM
  down to 0.04 GB once (run 3). No crash from it, but it is the closest yet.

### Run 5 (10:46, 20/20, no crash; lowest free RAM 2.90 GB after closing the PC's other apps; `--conf visits=0`)
- **The user:** "We need to delete the other wingman aircraft btw so that the opponent aircraft spawns there."
- **The context mission is now Mission014** (`hangar.h` HANGAR_MISSION 14, level 14 = PL_Hangar003, a tropical airbase).
  DT_LiveMissionTable: free aircraft choice, not carrier-only, and **one wingman slot** (HangarSelectWingman1st WingmanType 1;
  2nd and 3rd None). Mission013 has one too but is carrier-only (`bIsOnlyCarrierBasedPlaneCanSortie`); Mission015 has
  none, but runs 1-4's research left 11-15 out (its own row not checked yet).
- **STANDBY lists REX and BAXTER only**, and the apron shows two planes: the player's Su-57 and the wingman's spot.
  - On entering STANDBY the game puts Baxter's ADF-X02 there.
  - After `RVNG_HangarShow(mgr, 10034010)` **the F-14A stands next to the Su-57** (three pictures 6 s apart: the F-14A behind
    the Su-57, then a close-up of its two-seat cockpit with the Su-57 behind).
- The wingman's aircraft page (SELECT WINGMEN AIRCRAFT) puts its own focus (Baxter's ADF-X02) back on the spot: only a
  picture was taken there this time.
- Still the game's: the FLIGHT panel's "BAXTER / ADFX-02 -PIX- / MPBM TLS" (to be the opponent's name and plane), and
  the stock refresh of the spot when STANDBY builds.

## 2b. RVNG's lobby in the hangar (runtime 0.4.3: `native/lobby.h`, `Scripts/rvng_hangar.lua`, kit suite `hangar_p`)

**Built 2026-11-21** (the user: "Keep working until 2pm"):
- **Hooks in every install** (idle until a match opens the hangar; counted apart from RVNG_Hooks: `RVNG_HgInfo(0)` = 5):
  - the menus' confirm input: the active page, and the walk's presses;
  - GoToMission: refused during the session;
  - STANDBY's decide: SORTIE (refused, with the menu's reject sound, until both are ready), SELECT WINGMEN AIRCRAFT = READY UP,
    LEAVE THE HANGAR = leave;
  - the HANGAR MENU's decide: BRIEFING / SELECT DIFFICULTY / TRAINING refused, QUIT MISSION = leave;
  - ApplyGroupDisplay: group 1 gets the opponent's aircraft and skin whenever the game sets it.
- **The link (protocol 2):** LOADOUT (aircraft, skin, specials, paint, emblems, weapons, parts, and the sender's own
  "plane|sp1|sp2" names from its FLIGHT panel), reliable, sent when it changes or every 4 s; the ready flag 0..2 (2 = ready
  and SORTIE pressed: the host launches once both are ready and one pressed SORTIE). The receiver shows a stock aircraft only
  (else the F/A-18F) and a skin only with its own plane ((skin / 1e6) % 100 = the plane's number).
- **The match:** FillOpponent puts the opponent's LOADOUT aircraft and skin in slot 1's selector, so the game's own remote
  spawn builds the copy in the opponent's plane.
- **Lua:** a match found (main.lua's onLink, after Ready.begin) → `Hangar.start` (RVNG_HangarGo) → the walk to STANDBY → the
  lobby texts written every frame (READY UP (n/2) / CANCEL READY, SORTIE (LOCKED n/2), the description, the opponent's
  name and plane in the wingman's FLIGHT row) → the launch (`Hangar.stop` first: it puts the UDM's mission context back,
  then RVNG_TravelDM).

### Run 6 (11:08, 21/22) and run 7 (11:13, 23/23): the whole lobby on one PC (`hangar_p`, rehearse=1: the stand-in, an F-14A)
- RANKED 1V1 → the match found → the hangar (PL_Hangar003) → the walk to STANDBY in 27 s (7 presses).
- STANDBY: "SORTIE (LOCKED 0/2)", "READY UP (0/2)", "vs the stand-in. You: not ready. ...", the FLIGHT panel's wingman row
  "the stand-in" with the stand-in's plane and weapons names; the stand-in's F-14A on the wingman's spot; this pilot's
  LOADOUT sent (aircraft 21010 ...).
- SORTIE before ready: refused (the reject sound), no launch. READY UP: both ready (the stand-in readies with this PC),
  "CANCEL READY (2/2)", SORTIE open. SORTIE: the host's LAUNCH in 5 s; the session over, then the travel into PL_DM_001; the
  match armed; GamePlaying; **the opponent's copy is an F-14A** (the target box reads "F-14A").
- Run 6's one failure was the test's hook count (it said 6; there are 5).

### Run 8 (11:15, `--conf leave=1`): a crash at the first page, before the hangar
- "Abort signal received" (exception 0x4000 raised by the engine's abort-signal handler 0x141879990), on the game thread,
  between two of RVNG's 1 s ticks, from inside UE4SS (UE4SS.dll+0xc6c4fb .. +0xc68fb7, then the CRT's abort): the pattern of
  an unhandled C++ exception in UE4SS. The same steps had passed in runs 6 and 7.
- **Most likely cause:** Lua running on two threads in one Lua state. `rvng_tick.lua`'s LoopAsync function runs on UE4SS's
  async thread (it only reads flags, but it is Lua), while RVNG's per-frame loops run Lua on the game thread every frame. 0.4.3
  had added a second per-frame loop (the hangar's) to rvng_pages.lua's, doubling the overlap. Survival Mode met the same class
  of failure (rvng_tick.lua's header).
- **Fixed:** all of RVNG's Lua runs on the game thread now. One `LoopInGameThreadAfterFrames` loop in rvng_tick.lua runs the
  per-frame functions (`Tick.everyFrame`: the pages' and the lobby's texts) and the 1 s tick; LoopAsync is used only by the
  offline tests (or as a fallback when the game-thread loop is missing).

### Run 9 (11:19, leave=1, 16/16) and run 10 (11:21, 23/23), after the tick fix
- LEAVE THE HANGAR: RVNG_HgLeave (the page's own GoToLevel to the main menu, level 2) lands on **the main menu's top page** in
  4 s (not FREE MISSION, as the stock QUIT does), the lobby and the session over.
- The whole lobby again, 23/23, no tick errors.
- A `dm_p` regression run (11:24) was stopped by the user mid-run; `gate.py recover` put the mods and Campaign.sav back.

### The pilot's own name (the user, 11:26: "'Rex' also needs to be changed to the players name too")
- The FLIGHT panel's first callsign (the game's REX) now shows the pilot's RVNG name from the server's match (main.lua's
  onLink: `match.host` / `match.guest` by role → `Ready.begin(oppName, myName)` → rvng_hangar.lua writes it every frame). The
  opponent's PC shows its own pilot there, and this pilot in its wingman row. Offline tests pass; the in-game check
  (`hangar_p` checks "Test Pilot" / "the stand-in") waits for the user's go-ahead after the interruption.

### Why the hangar still showed the ADF-X02 (the user, 11:3x: "why is it still an ADFX-02 model in the hangar but in game is an F-14?")
- The lobby runs' log: RVNG set the spot once, on the HANGAR MENU (11:22:42, its ApplyGroupDisplay call); then the aircraft,
  weapons, squad and STANDBY pages put Baxter's ADF-X02 back **without ApplyGroupDisplay**, so the detour never fired again
  ("spot set 1 time"). The test checked RVNG's own request (`RVNG_HgInfo(6)`), not what the spot held, so it passed anyway.
- In the match the copy is an F-14A because that path is different: FillOpponent writes slot 1's selector, which the game's
  remote spawn reads.
- Every page's plane on a spot ends in the spot's display group actor: SetGroupAircraft (0x1471ef910: iface+0x1d8 the slots,
  stride 0xe8, +0x58 the slot's plane, the actor through a weak pointer at +0x8) calls the actor's SetPlane 0x1471e42c0, and
  SetGroupSkin its SetSkin 0x1471e44a0. SetGroupAircraft starts with `js rel32` (not detourable); both actor functions are.
- **Fixed (0.4.3, 7 lobby hooks):** the actor's SetPlane and SetSkin detoured. The wingman spot's actor is learned from the
  SetPlane inside any ApplyGroupDisplay for group 1 (reset each session); any page's SetPlane / SetSkin on it then gets the
  opponent's ids. `RVNG_HgInfo(10)` reads the plane the actor holds (+0x348) and `hangar_p` now checks that. In-game check
  pending the user's go-ahead.

### Run 11 (12:21, 24/24) and regressions (12:28-12:40)
- `hangar_p`: **the F-14A stands on the wingman's spot on STANDBY** (the display group holds 10034010; one page's set of the
  ADF-X02 turned into it), the FLIGHT panel "Test Pilot / Su-57 / LACM QAAM" and "the stand-in / F-14A / XMAA LAGB", READY UP,
  SORTIE, the launch, the copy an F-14A in the match. The pictures show the F-14A behind the Su-57 and close up.
- `hangar_p --conf leave=1` 17/17, `ui_pages` 26/26 (the pages' per-frame writes on the one game-thread loop), `prod` 8/8 (a
  normal install with the 7 lobby hooks idle). `dm_p` was not rerun: the auto-mode check refused relaunching the run the user
  had stopped; it waits for the user.

### Run 12 (12:32, `--conf full=1`, 28/28) and run 13 (12:39, 31/31): the whole loop
- The hangar lobby → the match to time-up (15 after 192 s) → D6: the main menu → the result page ("MATCH RESULT | DRAW 0 - 0 |
  PLAY AGAIN", no shots in the test) → PLAY AGAIN: the LOBBY → the next match found → **a second hangar session: STANDBY with
  the opponent's F-14A on the spot again in 24 s**.
- The one-PC pair is made again for the next match once the last launch is over and no match is armed (`ReadyLink`; a
  real match gets a fresh Steam link from RVNG_LinkStart anyway).

### Runs 14-15 (12:48, 12:53; 24/24, 27/27): a faster walk; editing un-readies
- The walk presses each page once, 0.8 s after it becomes the active page (every frame, `Hangar.walkFrame`), instead of on
  the 1 s tick with a 3 s gap: the HANGAR MENU to STANDBY in 16 s (was ~20); the rest is the game's own page loads
  (the aircraft page 3.3 s, STANDBY's camera 4.5 s); 23 s from the main menu including the hangar map's 7 s.
- **The plan's "changing the plane after readying un-readies":** while ready, any hangar page other than STANDBY (SELECT
  AIRCRAFT, the weapons, parts) or a changed LOADOUT (`RVNG_HgInfo(12)`) makes the pilot not ready; not once the launch is
  set. In game: SELECT AIRCRAFT while ready → not ready, SORTIE locked again; confirming the plane there goes straight back
  to STANDBY (3 s); READY UP again → SORTIE open.

### Runs 16-18 (12:56-13:05): B out of the hangar is RVNG's leave
- Pressing B over and over on STANDBY steps back through the squad, weapons and aircraft pages to the HANGAR MENU, whose B
  is the game's quit (0x147aed870: its travel to FREE MISSION, around RVNG's lobby: the link and the session left up).
  **Hooked (8 lobby hooks):** during the session the quit is RVNG's leave (the opponent told; the main menu's top page).
  In game `--conf leave=2`: 5 B to the HANGAR MENU, the 6th → "B on the HANGAR MENU (the game's quit)" → the main menu's
  top page in 3 s, 18/18. A B on an aircraft page opened from STANDBY goes back to STANDBY (run of 12:56).
- `hangar_p` with all 8 hooks: 27/27.

### Runs 19-22 (13:06-13:20): where leaving lands, the opponent gone, the whole loop again
- Leaving the hangar (LEAVE THE HANGAR, QUIT / B on the HANGAR MENU, the opponent gone) now lands on **RVNG's MULTIPLAYER
  page** with the cursor on RANKED 1V1, as LEAVE LOBBY does on the main menu (`Pages.backFromHangar`: the page opens once
  the main menu map is up and its top widget is on screen, in the viewport or parented). The first try checked
  IsInViewport alone, which is false for the game's menu (run of 13:08). `leave=1` 17/17.
- **The opponent gone** (`leave=3`: the stand-in's wire cut on STANDBY, `RVNG_WireCut`, a test only): the link lost 6 s
  later, "the opponent left", out of the hangar, MULTIPLAYER, 18/18.
- The whole loop (`full=1`): 34/34 (13:13).

## 3. Where the lobby stands (2026-11-21 13:20)
**Done and passed in game on one PC (the stand-in opponent):** the match found → the hangar (Mission014) → the walk to
STANDBY → the lobby there (READY UP, SORTIE locked until both are ready, LEAVE THE HANGAR, the HANGAR MENU's campaign rows
refused) → the opponent's own plane on the wingman's spot and in the FLIGHT panel, the pilot's own RVNG name → SORTIE → the
synced launch → the match with the opponent's copy in the opponent's plane. Leaving lands on the main menu's top page.

**Still open:**
- The two-PC run (both PCs' hangars over Steam; the guest's walk and LOADOUT the same way).
- The `dm_p` regression on 0.4.3 (the old main-menu ready-up path) waits for the user (see run 11).
- The walk shows the stock pages for ~25 s; a direct open of STANDBY (`0x147a76c20(top, 11)` with member 0 set) is untried.
- B on STANDBY goes back through the stock pages (the plane can be changed there); B or QUIT on the HANGAR MENU leaves.
- The opponent's emblems and special weapons on the display (the LOADOUT carries them; not applied to the spot yet), and the
  special-weapon icons' colours in the FLIGHT row (still the wingman's).
- In the match: this PC's own scoreboard name is still blank offline (9.12).
