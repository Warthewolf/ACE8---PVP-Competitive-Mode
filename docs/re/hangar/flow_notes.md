# Pre-sortie hangar flow (ACE COMBAT 8, build 2026-11-02) - static RE notes for RVNG

[V] = verified in code/data here, [I] = inferred, [T] = needs an in-game test. Static only; no game run.
Scratch: this folder (`*.txt` disassembly dumps, `py/` helpers: dt.py, mt.py, dump.py, vt2.py, xr.py, xs.py, dispw.py).
Extracted packages: `E:/ACE8 PVP/build/stock/...` (DT_HangarLevelData, DT_LiveMissionTable, OnlineMode DT_MissionTable,
DA_MenuHangarSettingsData, hangar Top/Standby/Sortie page settings + command tables, WBP pages, BP_LiveHangarGameMode,
PL_Hangar001/002, PL_EditHangar, DA_LiveMenuMainSettings, DT_LiveTransitionSettingsTable).

## 1. Worlds and tables

- The hangar is a separate persistent map, not a streamed level of the main menu [V]:
  DT_LiveMissionTable rows Hangar00..Hangar05: MissionID 8000/8999/8998/8997/8996/8995, LevelId 11..16,
  MapReference /Game/Maps/Hangar/PL_EditHangar, PL_Hangar001..PL_Hangar005 (+ Hanga05_NoEmergency 8990, LevelId 17).
  PL_Hangar00N imports BP_LiveHangarGameMode (LiveHangarGameModeBase < LiveOfflineOutGameMode) and its sub-levels.
- ELiveLevelID: 2 MainMenu, 11 Hangar_00 (EditHangar), 12 Hangar_01=PL_Hangar001, 13 Hangar_02=PL_Hangar002,
  14 PL_Hangar003, 15 "NumTraining"(=PL_Hangar004), 16 PL_Hangar005, 99997 OnlineMission (all DM/TDM rows) [V].
- ELiveHangarID (mission row TravelHangarMap / TravelHangarMapForSelectAllAircraft): 1 Hangar_00 .. 6 Hangar_05 [V].
- DT_HangarLevelData: PL_Hangar001..005, PL_Edithangar -> DA_Hangar00N / DA_EditHangar (LiveHangarLevelData) [V].
- Menu frameworks per world [V]:
  - main menu: DA_LiveMenuMainSettings -> boot WBP_Menu_MainBoot, MenuClassTable DT_LiveMenuMainClassTable (41 rows;
    no hangar pages; DataViewerPreAircraftViewer = WBP_PreAircraftViewer_Menu_000).
  - hangar: DA_MenuHangarSettingsData -> boot WBP_HangarBoot_000, MenuClassTable DT_MenuHangerClassTable (36 rows:
    Top, SelectDifficulty, AircraftSettings(SelectAircraft), SelectAircraftSet, WeaponSettings1/2, PartsSelectionConfirmation,
    Squad, Stadby(Standby), Sortie, AircraftTree, SelectParts, AircraftSet_*, AircraftPreview, WeaponPreview,
    SelectTraining, DataViewer* (the aircraft viewer pages)).
  - So a main-menu page cannot open a hangar MenuID: only a level travel reaches the hangar world [V tables; I runtime].
- Menu page "next" requests: widget+0x3d0 {u8 kind, ..., i16 menu index +0x3e0, i32 level +0x3e4, u8 flag +0x3e8,
  TArray +0x3f0, i64 +0x400}. kind 1 = page by index, kind 3 = level travel [V 0x147a76c20 / 0x147aed870 / 0x147b0ba70].
  Page index = ELiveMenuMainIDs / ELiveMenuHangarIDs + 3 (Top=3, SelectAircraft=5, Standby=11, Sortie=12) [V].
  - 0x147a76c20(widget, i16 idx): open page idx [V].
  - 0x147a76cc0(widget, i32 levelId, u8): level travel (0x147a75a00 fills +0x3d0, then vf+0x600, vf+0x5f0) [V].
  - 0x147a76d00(widget, i32 missionId, u8): LevelRow(GI+0x878, id) then level travel to row.LevelId [V].
  - Menu tick 0x147a7637e..: pending level (+0x3b0) -> UDM+0xf3c = level; 0x147ec9e40(GI, level) [V].
  - 0x147ec9e40(GI, level) = LevelRowByLevelId 0x14734ca30 + RequestChangeMap 0x147901bf0(GI+0x888, &row+0x48) [V].
    (Survival/RVNG doc: the main menu comes from 0x147ec9e40, consistent.)
- Menu ctx object = 0x147a56940(widget) (UI/menu context; fields +0x18c return page, +0x190 mission id for the
  hangar/training, +0x36e "from menu" flag, +0x380 mode) [V writes; I meaning]. UDM = 0x147a75c10(widget) [V].
- UDM fields: +0xf38 MissionID (current mission context), +0xf3c LevelId of the travel, +0xf60 mode byte
  (ELiveCampaignMissionMode: 1 Campaign, 2 FreeMission [I from code: ==1 branches are campaign-only]),
  +0xe0e selected squad slot [V].

## 2. Stock flows into the hangar

- Main menu decide 0x147b3fa10: cmd = vf+0x7a0 (slot 0xF4); cmd+0x108 LevelId != -1 -> 0x147a76cc0(menu, LevelId, 0)
  (0x147b3ff28); else MenuID (cmd+0xf8) -> index -> 0x147a76c20(menu, idx+3) [V].
- FREE FLIGHT page (vt 0x14c7dc970) after fade -> slot 0x11C 0x147b009b0 -> next tick 0x147b00840 [V].
- 0x147b00840(widget) TravelToHangar: level = 0x147b80f80(widget); top page (world+0x108); level travel [V].
- 0x147b80f80 GetTravelHangarLevel: row = LevelRow(UDM+0xf38 or 0x14734cb50 default); hangarId = campaign?
  row+0x57a TravelHangarMap : row+0x57b ...ForSelectAllAircraft (0 -> +0x57a); 2..6 -> level 12..16, else 0
  (= TransitionMap) [V]. DM/TDM rows have both 0 -> returns 0: never use it with a DM mission id.
- Free mission: CampaignTop -> CampaignFreeMission -> CampaignFreeMissionDifficulty -> hangar (Stonehenge sig5 =
  go-to-level(page, 13); Survival in game: difficulty -> hangar -> mission) [V by the sibling RE; the difficulty
  decide 0x147b00a90 queues a fade delegate 0x147b31b38 -> page vf+0x8e0].
- Aircraft viewer (main menu -> hangar -> main menu, stock precedent): WBP_PreAircraftViewer_Menu_000
  (LiveMenuPreAircraftViewerWidget, vt 0x14c827090): slot 0x9a 0x147b0b8e0 sets ctx+0x36e=1, ctx+0x190 =
  row(level 11).MissionID (8000), UDM+0xf60=1; slot 0xaa 0x147b0ba70 = level travel kind 3 to 11 (PL_EditHangar),
  flag 1 [V].
- Mission row fields that drive the hangar [V offsets by usage]: +0x574 OpeningMinigameLevel, +0x57a TravelHangarMap,
  +0x57b TravelHangarMapForSelectAllAircraft, +0x57c bIsSkipHangarTopMenu (only in campaign: 0x147aed7d0).
- Free-mission context candidates (no exclusive plane, not carrier-only) [V data]: Mission006 (id 6, hangar 3 =
  PL_Hangar002 = level 13, lighting Hangar002_Morning03), 7..10, 16..25. DM rows 160010.. have no hangar data
  (TravelHangarMap 0, no lighting, no sub-levels, no BGM).

## 3. Inside the hangar

- Hangar boot WBP_HangarBoot_000 (LiveMenuHangarBootWidget, vt 0x14c802230): slot 0x98 0x147ae48b0 marks the row's
  TravelHangarMap as unlocked in the campaign save data (0x14787cc80(saveMgr, id): adds to the hangar-ID list at
  save+0x1e0+0x2d0 if missing) [V]; then 0x147ae4b50 -> 0x147a76c20(top, 3) = Top [V].
- Top "HANGAR MENU" (LiveMenuHangarTopWidget, vt 0x14c800490, decide 0x147aec740, cancel 0x147aed790):
  tabs DT_LiveMenuHangarTopCommandsData (START MISSION->SelectAircraft, AIRCRAFT SET, AIRCRAFT TREE, BRIEFING LevelId 4,
  DIFFICULTY, TRAINING, QUIT LevelId 2), _FreeFlight, _NotBriefing [V].
  Decide: LevelId 2 -> 0x147aed870 (quit); LevelId 4 -> ctx+0x385=1 then travel; other LevelId -> travel [V].
  Cancel (B/Esc) = 0x147aed870 too [V].
- Quit 0x147aed870: ctx+0x18c = 2 if UDM+0xf60==1 else (6 if mode==6 else 4); page+0x720=1; request kind 3 level 2
  (MainMenu), vf+0x600, vf+0x5f0 [V]. (2/4/6 = ELiveMenuMainIDs CampaignTop/FreeMission/FreeFlight [I].)
- Aircraft/weapons pages write the UDM loadout live, per squad slot s (0 = player), stride 0x28 at UDM+0xd28+0x28*s:
  {+0 aircraft id, +4/+5 special weapons, +8 skin, +0x10 emblems TArray, +0x20..22 bytes, +0x24 aircraft-set no.} [V]
  writers: 0x147b83820 (SetSlotAircraft, after reset 0x147992970), 0x147ae350c (+0xd4c set no.), 0x147ae3b57 (from the
  group data via 0x147a31c60/cf0/d80), defaults 0x147b84e5b (7010). UDM+0xdd8 / +0xde8 are not per-slot.
- UDM+0xdd8 (21 max, AddWeapon 0x147992850) / +0xde8: offline writer not found; only the online set apply 0x1476088b0
  (called from the online screen 0x148189e1d) fills them [V]. The main menu Top's init (vt 0x14c816720 slot 0x98,
  0x147b3f7a0) EMPTIES both arrays every time the main menu builds [V].
- Standby "STANDBY" (LiveMenuHangarStandbyWidget, WBP_Menu_Hangar_StandbySetting_000, vt 0x14c800e98):
  DA_HangerMenuStandbyPageSettingData: tab0 DT_LiveMenuHangarStandbyCommandsData_1 {Sortie: CommandID
  Hangar_Standby_Sortie, TitleTextID HangarConfirmation_Select_Sortie, HelpTextID HangarConfirmation_Description_Sortie,
  MenuID Sortie; LeaveTheHangar: Hangar_Standby_LeaveTheHangar, MenuID Top}, tab1 _2 {Sortie only} [V].
  Widgets: WBP_MenuCommon_Header_000, WBP_MenuCommon_HelpText_000, CommandList, WBP_MenuCommon_HangarSquadron_000 [V].
  Slots: 0xE4 can-decide = base 0x147a7a160, 0xE5 = 0x1416bb960 (mov al,1), 0xEE decide 0x147aeaf50,
  0xEF cancel 0x147aeb650, 0xF4 = base 0x147a7a260 [V].
  Decide: cmd = vf+0x7a0; idx = 0x147ae7d60(cmd+0xf8 MenuID); jump table @0x147aeb614:
  9 Sortie -> page+0x6f8=0x1b, 0x147a56cd0/0x147a56f90(ctx), 0x147b8c880(page,0x1c), ctx+0x348=0,
  0x147a76c20(page, 12) = open Sortie page; 0 Top (LeaveTheHangar) -> campaign: dialog
  "Campaign_Hangar_LeaveTheHangar_NoSave", else 0x147b84240 + 0x147aeb8b0 [V].
  Cancel: back to WeaponSettings1/2 (idx 7/8) or Squad (10) [V].
- Sortie page (LiveMenuHangarSortieWidget, vt 0x14c7ffb20, no decide): slot 0x98 0x147ae7fb0 init (campaign only:
  save+0x1e0+0x30 = MissionID-1 for levels 19..49) [V]; slot 0xA1 tick 0x147ae8560: when +0x6e0 && +0x6e1 && !+0x6e2:
  fade 0x1478ce310(.., 5 or 3), then 0x147a76d00(top page, row(UDM+0xf38).MissionID, 0) at 0x147ae8647, +0x6e2=1 [V].
  => SORTIE travels to the mission in UDM+0xf38 by its LevelId.
- Save: LiveCampaignSaveData has LastSortiedPlaneIDs / ...AircraftSetSlotIDs (+ByCampaignMission), AircraftSets,
  UnlockedHangarIDs [V usmap]; when they are written to disk is not traced [I: mission start/end].

## 4. Menu row mechanics (all LiveMenu pages)

- Runtime rows: page+0x690 array, stride 0x1b8, count i32 page+0x698; 0x147a7a230(page, i16) -> row [V].
  Row (LiveMenuCommandsDataTable copy): +0x8 CommandID FName, +0x18 TitleTextID, +0x88 HelpTextID, +0xf8 MenuID,
  +0x108 LevelId, +0x130 StringArgs, +0x140 bIsInvalid, +0x141 RefFeature, +0x142 InvalidAppearance (1 Grayout,
  2 Invisible), +0x144 platform settings, +0x1b4 runtime "decide even if invalid" [V offsets by use; names I].
- 0x147aac250(cmd, page) IsCommandInvalid: +0x140, feature lock, platform flags [V].
- Menu tick 0x147a797b0: if IsCommandInvalid(selected) && !cmd+0x1b4 && accept pressed -> PlaySound(page, 4 Reject)
  0x147b8c6b0 and no decide; else can-decide (vf+0x720 = slot 0xE4) -> confirm input (0xDF) -> decide (0xEE) -> sound
  vf+0x840 [V].

## 5. Hook points for RVNG

| What | Address | Signature (masked) |
|---|---|---|
| Standby decide (vt 0x14c800e98 slot 0xEE) | 0x147aeaf50 | 48 89 5C 24 18 48 89 74 24 20 55 57 41 54 41 56 41 57 48 8D 6C 24 C9 48 81 EC D0 00 00 00 48 8B 05 ?? ?? ?? ?? 48 33 C4 48 89 45 27 48 8B 01 (47 B, unique) |
| Standby cancel (slot 0xEF) | 0x147aeb650 | 40 56 57 48 83 EC 38 48 8B F9 E8 ?? ?? ?? ?? 48 8B F0 48 85 C0 (unique) |
| Hangar quit to main menu | 0x147aed870 | 40 55 53 56 57 48 8B EC 48 83 EC 58 48 8B 01 48 8B F9 (unique) |
| Hangar Top decide (vt 0x14c800490 0xEE) | 0x147aec740 | 40 55 53 41 54 48 8D 6C 24 B9 48 81 EC B0 00 00 00 (unique) |
| Sortie page tick (vt 0x14c7ffb20 0xA1) | 0x147ae8560 | 40 53 48 83 EC 20 48 8B D9 E8 ?? ?? ?? ?? 80 BB E2 06 00 00 00 (unique) |
| Sortie travel call site | 0x147ae8636 (call 0x147a76d00 at 0x147ae8647) | 17 B unique (mksig) |
| GoToMission (safety net) | 0x147a76d00 | 48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 48 83 EC 20 48 8B F9 41 0F B6 F0 48 8B 49 20 (unique) |
| GoToLevel (call: main menu -> hangar) | 0x147a76cc0 | 48 89 5C 24 08 57 48 83 EC 20 48 8B F9 8B DA 48 81 C1 D0 03 00 00 (unique) |
| TravelToHangar (by mission row) | 0x147b00840 | 48 89 5C 24 08 48 89 74 24 10 57 48 83 EC 20 48 8B F9 E8 ?? ?? ?? ?? 33 DB (unique) |
| GI TravelToLevel | 0x147ec9e40 | 48 89 5C 24 10 48 89 6C 24 18 56 57 41 56 48 83 EC 60 48 8B 99 D8 01 00 00 (unique) |
| PlaySound(page, id) | 0x147b8c6b0 | 40 57 48 83 EC 40 8B 05 ?? ?? ?? ?? 48 8B F9 3B 05 ?? ?? ?? ?? 44 0F B6 CA 74 4C (unique) |
| IsCommandInvalid | 0x147aac250 | 48 89 5C 24 08 57 48 83 EC 20 80 B9 40 01 00 00 00 (unique) |
Vtables: find like the main menu (pointer arrays with [0xDF] == menu base 0x147a79a30) and match [0xEE].

## 6. Plan sketch

1. Lobby HANGAR row (or the lobby itself): UDM+0xf38 = context free mission (e.g. 6), UDM+0xf60 = 2, then
   0x147a76cc0(mainMenuWidget, 13, 0) from RVNG's decide hook (same call the stock decide makes for LevelId rows).
2. In the hangar: Top opens first (boot). Hide BRIEFING/TRAINING/DIFFICULTY (+0x140 and +0x142=2) or block them in
   the Top decide hook; optionally jump Top -> SelectAircraft (0x147a76c20(top, 5)) [T].
3. Standby: Sortie row = READY. Decide hook: Sortie press -> RVNG ready toggle, never call the original; not ready ->
   PlaySound(page, 4) or set +0x140/+0x142 so the game refuses it itself. Help/header text: per-frame writes as on
   the main menu.
4. LAUNCH: RVNG_TravelDM from the hangar world (it rewrites UDM+0xf38). Keep a GoToMission hook that refuses
   0x147a76d00 while the RVNG hangar session is up (it would fly campaign mission 6).
5. Back without a match: Top QUIT / B -> 0x147aed870 -> main menu; post-hook ctx+0x18c to 1 (Top) [I] and reopen
   RVNG's lobby page; snapshot UDM+0xd28..+0xd50, +0xdcc, +0xdd0, +0xdd8, +0xde8 before leaving (the main menu
   Top init clears +0xdd8/+0xde8).

## 7. Risks

- UDM+0xf60 = 1 (campaign) makes the Sortie page write campaign progress and Standby show the NoSave dialog: keep 2.
- A DM mission as context: GetTravelHangarLevel -> 0 (TransitionMap); hangar has no lighting/sub-level data [I].
- Stock SORTIE reaching 0x147a76d00 = a real campaign/free mission (save writes on clear, Strix none offline).
- Hangar boot adds the hangar ID to the campaign save data (in memory) [V]; flushed with the next save [I].
- AIRCRAFT TREE purchases (MRP) and AIRCRAFT SET edits change Campaign.sav (user actions) [I].
- Web: this route does not pass 0x147570da0's campaign branch (0x147956d00 is a GeneralAPI call behind gate B) [V];
  the rest of the hangar not audited for web calls - D9 wall covers it [I].
- Weapons/parts arrays (+0xdd8/+0xde8): offline source unknown; main menu clears them [V].
