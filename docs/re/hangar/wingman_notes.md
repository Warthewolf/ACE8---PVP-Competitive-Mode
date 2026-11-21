# Hangar wingman plane: how it is chosen, built, and how to put the opponent there

Static RE of AceCombat8.exe 2026-11-02 (551,201,904 bytes). [V] = read in code/data, [I] = inferred.
Stock packages extracted to E:/ACE8 PVP/build/stock/ (Datatables/Hangar/*, DT_LiveAircraft, DT_Skin, DT_DLC,
DT_WingmanAircraft, DT_LiveMissionTable, aircraft tree tables, PL_Hangar001..005, BP_HangarDisplayGroup,
BP_DisplayPlane_PP0024_f18f / _Base). Dumps and scripts are in this folder (dumps/*.txt, allowlist.txt, sigs.txt).

## 1. Data

- Mission row (LiveLevelTable, DT_LiveMissionTable) [V]: HangarSelectWingman1st/2nd/3rd at row +0x458/+0x464/+0x470,
  struct LiveHangarWingmanSetting (12 bytes): +0 WingmanType (ELiveHangarSelectWingmanType None/Baxter/Tasha/Coster/Kate),
  +4 ForceSelectedPlaneID, +8 ForceSelectedSkinID (-1 = not forced). Also +0x448 HangarCharacterPlacementCategory,
  +0x450 ...ForAllAircraftHangar, +0x579/+0x57a/+0x57b HangarTravelCondition/TravelHangarMap/TravelHangarMapForSelectAllAircraft,
  +0xc4 NarrativeSkinID. Campaign rows: most missions list 3 wingmen with -1/-1; a few force planes, e.g. M002/M003 all
  7010 (F/A-18C) with skins 7021001/7031001/7041001; M001 3rd = 32010; M028 3rd = 14010/14055001; Training007 7010.
  Main menu/Hangar0x/Transition rows: all None.
- Row builder 0x147389760(row, TArray<FLiveHangarWingmanSetting>& out) copies the three settings [V].
- DA_Hangar00N (LiveHangarLevelData) [V]: PlayerGroupSettings = {DT_HangarCharacterPlacementPattern00N_P,
  DT_HangarCharacterLayoutForPlayer}; WingmanGroupSettings = {..._W, DT_HangarCharacterLayoutForWingman_Hangar00N
  (001-003) or DT_HangarCharacterLayoutForWingman (004/005)}. LevelData +0x140 / +0x150 in native code [V].
  The layout tables are keyed by PlaneStringID (34 rows: the 34 flyable aircraft; Player table adds PP0024_f18f_ms01):
  they only place characters (pilot/mechanics, sockets, anims) around a plane, they don't choose it.
- DT_HangarLevelData: PL_Hangar00N -> DA_Hangar00N [V].
- DA_HangarGlobalSettings [V]: WingmanCharacterMap Baxter->HangarWingman_1, Tasha->_2, Coster->_0, Kate->_3;
  GroupAndWingmanIntroLinkTable 1->WingmanIntro.Slot2, 2->Slot3, 3->Slot4 (intro sequences per group slot).
- Hangar maps [V]: PL_Hangar001..004 hold BP_HangarDisplayGroup actors with GroupIndex 0,1,2,3; PL_Hangar005 0,1,2.
  BP_HangarDisplayGroup imports DT_HangarAircraft and DT_HangarCharacterTable (its HangarAircraftDataTable).
- DT_HangarAircraft (LiveHangarAircraftDataTable), row name = PlaneStringID: BlueprintReference =
  BP_DisplayPlane_<id>_C (LiveDisplayPlane subclass), SequencerCharaLocator, AdditionalSequenceContainer,
  SequenceTagRedirectList, TowingBarLength. 34 rows [V].
- DT_WingmanAircraft (LiveWingmanAircraftListTable), row = PlaneID: AI wingman BP (BP_WOPxxxx), PlayerPlaneReference,
  EquipSpWeapon1st/2nd, PlaneName. Same 34 ids. Not used by the hangar display [V: the display path never reads it].

## 2. Native classes and fields

- LiveHangarManager (TickableWorldSubsystem, size 0xf0): HangarInterface TScriptInterface at +0x78 (object = the
  LiveHangarGameModeBase) / +0x80 (interface pointer = GM+0x350) [V reflection]; +0x94 focused slot; +0x98 per-slot
  cache of the last applied spec [V]. World -> manager: 0x147af4020(world) [V].
- LiveHangarGameModeBase (size 0x730; its ctor is in the protected .sbss copy): GroupSlotList TArray<LiveHangarGroupData>
  at +0x528, element stride 0xe8, GroupActor (the DisplayGroup) at elem+0xd0 [V reflection + code]. elem+0x0 = group
  initialised, elem+0x58 = requested plane id, elem+0x8.. pending-op set, elem+0x5c/+0x64/+0x78/+0x90/+0xa8/+0xaa
  deferred skin/colour/weapons/flags [V]. HangarLevelData +0x728, GM+0x278 map slot -> wingman group info [V].
  0x1471f49e0(GM, DG) registers a DisplayGroup at GroupSlotList[DG.GroupIndex] [V].
- Hangar interface vtable (sub-object GM+0x350) at 0x14c710a80 [V, offsets checked against 3 call sites]:
  +0x38 InitGroup(slot, u8 flags[2]) 0x1471eef90 (sets DG+0x391 chars, DG+0x2f8 = 0 player / 1 wingman layout, elem+0=1)
  +0x68 SetGroupAircraft(slot, planeId) 0x1471ef910 (early-out if same id; deferred when GM+0x5bc busy)
  +0x70 SetGroupSkin(slot, skinId) 0x1471efef0
  +0x78 SetGroupPaint(slot, const int[4]*) 0x1471eff90   +0x80 SetGroupPaintId(slot, int) 0x1471efff0
  +0x88 SetGroupEmblem(slot, pos, emblemId) 0x1471f0050
  +0x90 SetGroupWeapons(slot, const TArray<info 0xc8>*) 0x1471f0100
  +0xa0/+0xa8 flags -> DG+0x38c/+0x38d 0x1471f0240/0x1471f02d0
  +0x1f8 focus slot, +0x220 GetFocusedSlot 0x1471f39e0 (GM+0x5b8).
- LiveHangarDisplayGroup (ALiveHangarDisplayGroup, size 0x588, ctor 0x1471e3560, vtable 0x14c712b90) [V]:
  +0x2c0 GroupIndex, +0x2f8 group kind, +0x300 HangarAircraftDataTable, +0x328 HangarAircraft (ALiveDisplayPlane*),
  +0x330 pending plane id (set while loading), +0x338 pending pattern array, +0x348 current plane id, +0x34c skin,
  +0x350 paint id / +0x354..0x35c paint values, +0x360 TArray<int32> emblems (8), +0x370 emblem flags (0xff),
  +0x378 weapon display struct, +0x38c/+0x38d flags, +0x38f/+0x390/+0x391 enable flags, +0x518 loading,
  +0x51c..+0x530 async load handles, +0x538 LoadedAircraftClassList. GetPlaneID (exec 0x146e40290) returns
  +0x518 ? +0x330 : +0x348.
  0x1471e42c0 SetPlane(DG, planeId, TArray<int32>* charaPattern) - resets skin/emblems/weapons, then Load or queue.
  0x1471e44a0 SetSkin, 0x1471e4510 SetPaint(struct), 0x1471e45a0 SetPaintId, 0x1471e45e0 SetEmblem(pos, id),
  0x1471e4650 SetWeapons, 0x1471e5b70 Load(DG, planeId, pattern), 0x1471e8d30 HangarRow(DG, planeId),
  0x1471e6e50 tick worker (called from Tick override 0x1471e3bc0 while +0x518).
- LiveDisplayPlane (size 0x8a8, ctor 0x1471f7470, vtable 0x14c6b5a90): +0x2a8 HangarPlaneDataHandle, +0x2bc plane id
  (from the row name, 0x14734e480), +0x2c8 EmblemSetter, +0x2d0 SkinComplition [V].
- UserDataManager (GI+0x8e0) member loadouts [V]: 4 x 0x28 bytes at +0xd28 (k=0 player, k=1..3 wingmen):
  +0 planeId (+0xd28/+0xd50/+0xd78/+0xda0), +4/+5 specials, +8 skin (+0xd30/+0xd58/...), +0x10 TArray emblems
  (+0xd38/+0xd60/...), +0x20..+0x22 paint bytes, +0x24 int. Backup copy at +0xe20.. restored by 0x1471ba0bf..
  (with +0xe14 -> +0xf38). UDM+0xe0e = member being edited in the hangar menu.
  0x147992200 UDM::GetWingmanPlaneIds(TArray&): per mission row entry: ForceSelectedPlaneID if != -1 (unless the
  "free choice" flag), else member[i+1].planeId when WingmanType != None, else -1.
  0x1479924f0 same for skins (ForceSelectedSkinID / member skin). 0x147991d60 UDM::GetMemberPlaneId(k),
  0x147992440 GetMemberSkin(k), 0x1479926f0 paint byte getter.

## 3. How the wingman's plane is chosen and built

1. LiveMenuHangarTopWidget (vtable 0x14c800490; virtual +0x4d0 = 0x147aebc00) calls RefreshGroups 0x147aec2b0 [V].
2. RefreshGroups: slot 0 = player; then unless LiveDifficultyManager.CurrentDifficulty (+0x30) == FreeFlight(6),
   it builds the mission row's wingman list (0x147b81150 -> 0x147389760) and for each entry with WingmanType != None
   gives it the next slot (1, 2, 3) [V].
3. Per slot (lambda 0x147aec450): spec ctor 0x147201240 (planeId 7010 placeholder), then the data source:
   a) LiveSaveDataManager: [save+0xa8]+0x1e0+0x2a0 array (stride 0x70) indexed by LiveUILocalDataManager+0x220 lookup:
      planeId +0x18, emblems +0x20, skin +0x30, paint bytes via +0x38; or
   b) LiveUILocalDataManager+0x1b0 member map (key u8 member, value stride 0x50: plane +0x8, skin +0x20, emblems, paint)
   [V for both]. That UI data is built from UDM through GetMemberPlaneId/GetMemberSkin (0x147a7e170 -> 0x147b84a50)
   [V partially; the store into the map not traced]. Skin: when 0x147b831c0 says so or skin <= 0, the character's
   narrative skin replaces it (0x147b81880 type -> 0x147b83330 uses row NarrativeSkinID and InfoMgr skins) [V].
4. LiveHangarManager::ApplyGroupDisplay 0x1472019a0(mgr, slot, spec*, force) [V]:
   iface+0x38 InitGroup(slot, {spec+0x1b, spec+0x1c}); stop if false and !force; stop if planeId == -1;
   spec+0x1a -> focus slot (0x147201da0); +0x68(slot, planeId); +0x70(slot, skin); spec+0x1d ? +0x78(slot, &spec+0x20)
   : +0x80(slot, spec+0x20); for i < emblems.Num: +0x88(slot, i, emblems[i]); +0xa0(slot, spec+0x18); +0xa8(slot,
   spec+0x19). Caches into mgr+0x98.
   Spec: +0 planeId, +4 skinId, +8 TArray<int32> emblems (ctor gives 8 zeros), +0x18/+0x19 flags, +0x1a focus,
   +0x1b chars-enabled, +0x1c re-init, +0x1d paint mode, +0x20 paint (int id or int[4]). Size >= 0x30.
5. SetGroupAircraft (0x1471ef910) -> lambda 0x1471efc60: chooses the character pattern (LevelData Player/Wingman
   settings + row placement category, 0x1471f4b70) and calls DG::SetPlane 0x1471e42c0 [V].
6. DG::Load 0x1471e5b70: sets +0x518 loading, +0x348 = id, destroys the old display plane (0x143fd38e0, +0x328 = 0),
   0x1471e8d30: InfoMgr row 0x14734d490(GI+0x878, id) -> PlaneStringID (row+0x14) -> FindRow in DG+0x300
   (DT_HangarAircraft); null -> return (no plane, stays "loading"); else async-loads BlueprintReference through the
   GI loader 0x1478fc1f0 (callback 0x1471e5880 appends the UClass, even a null one, to +0x538) plus character assets [V].
7. Tick worker 0x1471e6e50: when all handles are done: if +0x330 pending -> reload; else spawn 0x147209ac0(world, class)
   (SpawnActor, returns null unless the class IsA LiveDisplayPlane), then without a null check: set row handle
   0x1471f9dd0, transforms, flags 0x1471fad40, skin 0x1471faf00(plane, -, DG+0x34c) -> LiveSkinMaterialComplition
   0x147d71620(comp, plane, plane+0x2bc, skin) (skin -1 -> first skin of InfoMgr 0x14734f290 list), paint 0x1471fb400 /
   0x1471fb3d0, emblems 0x1471fb300(plane, &DG+0x360, DG+0x370), weapons 0x1471fb8d0(plane, &DG+0x378),
   DG+0x328 = plane [V].
8. Changing the plane while the hangar is up is the normal path (the aircraft select page does it): a new id destroys
   and rebuilds the display plane; skin/emblems sent while it loads are cached in the DG and applied at spawn [V].

Free mission: the same rows and the same RefreshGroups path, so wingmen show unless difficulty is FreeFlight [I: code
path verified, the free-mission difficulty value not]. Characters use the ForAllAircraftHangar category when
UDM+0xf60 != 1 and the two hangar maps differ (0x1471efd83..) [V].

## 4. Putting the opponent there

Recommended: detour ApplyGroupDisplay 0x1472019a0 (rcx mgr, edx slot, r8 spec*, r9b force). When the RVNG lobby is
active and slot == 1: copy the spec, write opponent planeId/skin/emblems (in place into the 8-entry array; don't
reallocate), keep the other fields, call the original. And call it yourself (game thread) once the hangar is up and
whenever the link delivers a new loadout: mgr = 0x147af4020(world) (or FindFirstOf LiveHangarManager), spec from
0x147201240, force = 1, free the emblem array afterwards with the game allocator (callers use 0x1417258e0).
Lower level, equivalent: iface = *(mgr+0x80); vtbl[+0x38] InitGroup(1, {1,0}) then +0x68/+0x70/+0x88.
Works even when the mission row lists no wingman, as long as the hangar map has a GroupIndex 1 actor (all five do).
Alternative data path [I]: write UDM member[1] (+0xd50 plane, +0xd58 skin, +0xd60 emblems) or the row's
HangarSelectWingman1st.ForceSelectedPlaneID/SkinID before the hangar builds. Not recommended: UDM is save data and
feeds in-mission wingmen; the narrative-skin override can replace the skin.
Special weapons on the display: only through iface+0x90 with a weapon-info array (stride 0xc8, built by the
manager 0x1472023a0(mgr, const TArray<int32>& weaponIds) for the focused slot mgr+0x94); stock uses it only in the
weapon pages [V callers]. Untested for slot 1.

Signatures (sigs.txt; unique in code sections):
- ApplyGroupDisplay 0x1472019a0: 40 53 55 56 57 41 55 48 81 EC 80 00 00 00 48 8B 05 ?? ?? ?? ?? 48 33 C4 48 89 44 24 68
- TopRefreshGroups 0x147aec2b0: 40 53 48 83 EC 70 48 8B D9 E8 ?? ?? ?? ?? 48 89 84 24 90 00 00 00
- TopRefreshSlot 0x147aec450: 4C 8B DC 55 49 8D 6B A1 48 81 EC 90 00 00 00 48 8B 05 ?? ?? ?? ?? 48 33 C4 48 89 45 17
- SetGroupAircraft 0x1471ef910: 85 D2 0F 88 ?? ?? ?? ?? 4C 8B DC 55 41 54 41 55
- SetGroupSkin 0x1471efef0: 85 D2 78 6E 53 48 83 EC 20 48 8B D9 3B 91 E0 01 00 00
- SetGroupEmblem 0x1471f0050: 85 D2 78 74 53 48 83 EC 30 48 8B D9 45 8B D8 3B 91 E0 01 00 00
- InitGroup 0x1471eef90: 48 89 5C 24 18 55 56 57 48 83 EC 20 8B EA 49 8B F8
- DG SetPlane 0x1471e42c0: 48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 41 56 41 57 48 83 EC 20 66 C7 81 8C 03 00 00 00 00
- DG SetSkin 0x1471e44a0: 48 83 EC 28 48 8B 81 28 03 00 00 89 91 4C 03 00 00
- DisplaySpec ctor 0x147201240: 48 89 5C 24 08 48 89 6C 24 10 48 89 74 24 18 57 48 83 EC 20 33 ED 48 C7 01 FF FF FF FF
- UDM GetWingmanPlaneIds 0x147992200: 40 53 55 56 57 41 57 48 83 EC 30 33 FF 48 8B DA
(0x147af4020 has no unique short prologue; reach it through a call site or use FindFirstOf.)

## 5. DLC / ownership / allow-list

- No entitlement or DLC call anywhere on the display path (SetPlane, Load, HangarRow, tick spawn) [V: call lists];
  the LiveDLCValidator getter 0x1478c7b40 has 3 callers, all menu pages [V].
- All aircraft and DLC skin content is in the base paks: F-14A (DLC0000) in pakchunk0, DLC0002 skins in pakchunk10;
  there are no DLC-only pak files in this install [V]. So a PC that doesn't own the F-14A still has its packages and
  rows; the hangar would load and show it [I: no runtime test].
- Unknown/absent id: InfoMgr returns its static default row, the DT_HangarAircraft lookup fails, no plane, old plane
  already destroyed, the group stays "loading" [V]. A row whose class can't load (or isn't a LiveDisplayPlane):
  null class appended, spawn returns null, then used without a null check -> likely crash [V no check; I crash].
- Allow-list candidates: aircraft tree DT_LiveMenuAircraftTreeNodeDataTable (NodeType 0: the 32 base ids 1010..32010)
  + DT_LiveMenuAircraftTreeExNodeDataTable (10034010 F-14A, 38010 ADF-X02) = the 34 rows of DT_HangarAircraft and
  DT_WingmanAircraft [V]. DT_LiveAircraft adds two mission-only ids (10013010, 10024010) with no hangar row.
  Full list with display BPs and the stock skin ids per aircraft: allowlist.txt. Compile it into RVNG; don't read the
  tables at run time (mods AddRow into them). Extra run-time check: InfoMgr row Reference (row+0x30) and the
  DT_HangarAircraft BlueprintReference equal the stock paths.
- Skins: DT_Skin (883 rows), SkinID = plane number * 1e6 + skin * 1e3 + variant; PlaneStringID is full or short
  ("PP0024_f18f" / "f18f"). DLCID Live / DLC0000 / DLC0002. Validate skin against the stock per-aircraft list.
- Emblems: validate against stock DT_Emblem ids (not extracted here).

## 6. Open questions for an in-game test

1. Does calling ApplyGroupDisplay(mgr, 1, spec, 1) in the RVNG lobby hangar spawn the plane at group 1 (and with
   the lobby's mission row having no wingmen)? Does the stock RefreshGroups later overwrite slot 1?
2. Which character stands by slot 1 (chars flag +0x1b) and does a wingman intro sequence (Slot2) play?
3. DLC F-14A on a non-owning PC: loads and shows? Any menu or save check reacting to it?
4. Skin from another aircraft: visual result (expect wrong decal) - keep the allow-list.
5. Emblems: 8-slot order and ids from the link match ELiveSelectableEmblemPosition.
6. Swapping the opponent plane twice quickly (pending +0x330 path) - no leak/crash.
7. Meaning of spec+0x18/+0x19 and the paint bytes (+0x20..).
