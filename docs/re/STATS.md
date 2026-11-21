# The stats check: where the game keeps plane, part and weapon numbers (ACE COMBAT 8, build 2026-11-02)

[V] = verified in game, [H] = from the header dump (Survival repo, build/liveproject, dumped 2026-10-18), [I] = inferred.

## Where the numbers live

- `ULiveInformationManager` (a plain UObject, `BP_LiveGameInstance_C...LiveInformationManager_...`) holds the game's
  tables as reflected `TMap` UPROPERTYs, filled from the DataTables at boot [V for PlaneDataMap_ (37 planes) and
  PartsDataMap_ (128 parts) at the main menu; H for the rest]. Combat-relevant ones: `PlaneDataMap_`,
  `PlaneDataOnlyCarrierBasedMap_`, `OnlinePlaneDataMap_`, `PartsDataMap_`, `PartsSlotMap_`, `PartsCostDataMap_`,
  `PartsWeaponFilterConditionsMap_`, `WeaponDataMap_`, `WeaponSettingsDataMap_`, `OnlinePlayerCategoryDamageRateDataMap_`,
  `AbilityDataMap_`, `AbilityLevelDataMap_`, `AircraftLevelupDataMap_`, `AircraftLimitBreakDataMap_`,
  `AircraftLevelMaxDataMap_`, `AntiEnemyStealthDataMap_`, `DoubleLockonBuffTable_`, plus the arrays
  `WeaponDurabilityDataTableRows`, `ExplosionDurabilityDataTableRows`.
- A plane (`FPlayerPlaneDataTable`) holds `UDataTable* PlayerParameter` = `/Game/Datatables/Player/Parameter/
  DT_PlayerParameter_<PPxxxx_name>` [V: a UDataTable]. Its rows (`FLivePlayerParameterDataTable`) hold
  `TArray<FLivePlayerLevelParameter> LevelParameter`; each level holds `FAceFlightEnginePlayerParameter` (the flight
  model: SpeedMax, SpeedStall, AcceleR, the rotation vectors, ~400 fields), `MaxHealth`, stealth, gun/missile/flare
  counts and the four special-weapon infos [H].
- A part (`FLivePartsDataTable`) holds `TArray<FPartsData> PartsData`: `{ParameterLabel (EPartsParameterList),
  SpecialConditionLabel, OperationType, ParameterValue}` [V: part 2001802 = label 1 (PA_AccelRate), op 0, 0.35].

## How UE4SS 3.0.1 hands them to Lua [V, run 20261121_180804 stats_probe]

- `FindFirstOf("LiveInformationManager")` works. `im.PartsDataMap_` is a `TMap` with `ForEach(function(k, v))` (no
  `Num`); `k:get()` is the key (a number), `v:get()` the row struct (a `UScriptStruct` value, fields by name; a missing
  field reads `nil`). 128 parts in 0.001 s.
- Numbers, enums (as numbers) and bools read directly; `FString`/`FName` fields are userdata with `ToString()`.
- A `TArray` field has `GetArrayNum()`, `[i]` (1-based) and `ForEach(function(i, e) e:get() end)`.
- A `UDataTable*` field reads as a `UDataTable` userdata.

## Probe 2 [V, run 20261121_181415 stats_probe, 10/10, no crash]

- **Field lists by reflection:** `struct:ForEachProperty(function(p))` works on the row values. `p:GetFName():ToString()`
  gives the name and `p:GetClass():GetFName():ToString()` the class (`IntProperty`, `EnumProperty`, `ArrayProperty`,
  `SoftClassProperty`, ...); an `ArrayProperty`'s `p:GetInner()` gives its element's.
  - A part has 28 fields, `PartsData` is `ArrayProperty<StructProperty>`, and `FPartsData` has its 4 fields.
  - A plane has 46 fields, `Reference` among them as a `SoftClassProperty`.
  - A weapon has 20 fields, with 3 soft object pointers among them.
- **The plane's table:** `DT_PlayerParameter_PP0001_a10c` has one row. `GetRowNames()` hands its names as plain
  strings.
- **Levels:** every plane has 31 levels in `LevelParameter`.
- **The whole read:** rvng_stats.lua's first version read 20 tables, 369,197 values, with these counts:

  | Table | Rows |
  |---|---|
  | PlaneDataMap_ | 37 planes |
  | PlaneDataOnlyCarrierBasedMap_ | 15 |
  | OnlinePlaneDataMap_ | 41 |
  | PartsDataMap_ | 128 parts |
  | PartsSlotMap_ | 44 |
  | PartsCostDataMap_ | 4 |
  | PartsWeaponFilterConditionsMap_ | 70 |
  | WeaponDataMap_ | 48 weapons |
  | WeaponSettingsDataMap_ | 6 |
  | OnlinePlayerCategoryDamageRateDataMap_ | 4 |
  | AbilityDataMap_ | 305 |

  - It skipped what it never reads: 709 arrays of soft object pointers, 456 soft object pointers, 52 soft class
    pointers, and 52 fixed-size Int8 arrays (WeatheringParameterLimit).
  - A second read gave the same 20 fingerprints.
  - Headline example: plane 1010 has SpeedMax 1890, SpeedStall 140, MaxHealth 107.
- **It took 32 s on the game thread.** The causes:
  - a closure in every `pcall`;
  - type guesses that throw (a struct asked for `ToString`, a string asked for `get`);
  - the field lists taken again for each of ~1,100 levels;
  - a byte-at-a-time hash over ~9 MB.
- **Since:**
  - Field lists are cached per field path, and values are dispatched by their property class: no guessing.
  - Reads are `pcall(fn, obj, key)` with no closures, and the hash takes 8 bytes a step.
  - The read is a job run in slices: 40 ms a second, paused while a match is armed, with a fresh pass every 2
    minutes, each written to runtime.json.

## Runs 3 to 6: the background read, and three fixes [V]

- **Run 3 (20261121_182254, `stats`, 10/10):** main.lua's background read finished its first pass about 40 s after
  boot. It took 1.97 s of CPU in 45 slices; the longest slice was 71 ms. runtime.json held the pass, and a read in one
  go agreed on all 20 tables.
- **Two launches (runs 3 and 4):** 2,025 of 2,028 rows matched across the two launches.
  `WeaponSettingsDataMap_`'s `C.STORY` and `EASY` came out as `C.Story` and `Easy` in the other launch. That's
  FName text: an FName compares without case, and `ToString()` gives the case it was first made with, which differs
  between launches.
  - **Fix:** FName keys, values and DataTable row names are lowercased before hashing.
- **The row text (run 5)** showed a weapon settings row with only its own fields (lock-on). FLiveWeaponSettingsDataTable
  inherits FLiveNpcWeaponDataTable, which holds the weapon's damage, life time, load time, homing and fuses, and
  `ForEachProperty` lists a struct's own fields only.
  - **Fix:** `GetSuperStruct()` on the value gives the parent; its fields are read first. In the game it was found
    that way 36 times; the fallback by name wasn't needed.
- **Tables the manager doesn't copy:** the weapon numbers sit in DataTables (`DT_NPC_Weapon`: 105 weapons;
  `DT_NPC_WeaponDurability`, `DT_NPC_ExplosionDurability`, the player damage rates, parts, abilities, the score
  rules).
  - These are read by path through `StaticFindObject`.
  - They're optional: a scan is compared on each table both sides have.
- **Not loaded at the main menu:**
  - the online weapon tables: `DT_NPC_Weapon_ON`, `DT_NPC_WeaponDurability_ON` and `DT_NPC_ExplosionDurability_ON`;
  - `DT_WeaponDurabilityConfig_Plane` and `_Default`;
  - `DT_LiveAircraft` and `DT_WeaponSettings`. These two are copied into the manager's maps, which are read.

  The in-match pass reads the ones the menu pass found missing.
- **Run 6 (20261121_183205 and 183341, 11/11 each):**
  - Every pass read 44 tables, 3,062 rows and 395,398 values, in 3.05 s of CPU over about 70 slices; the longest
    slice was 116 ms (one plane row with its 31 levels, at the menu).
  - All 3,062 rows matched across the two launches.
- **My bug:** 2,344 bools read as nothing. The cause was `ok and v or nil`, which turns `false` into `nil`. It wasn't
  UE4SS: `true` bools read fine. Fixed, with a test.

## The in-match pass

- **When:** while a match is on (a normal install's armed match, or a test's `PL_DM_` map), there's no menu pass.
- **What it reads:** only the optional tables the last menu pass found not loaded.
- **Pace:** in slices of 5 ms a second, once per match.
- **Where it goes:**
  - `runtime_match.json`, which is the baseline's match capture (`aircraft.match`, from a clean match);
  - `result.json`'s `stats`. The server compares each pilot's with the capture. A change disputes the match
    (`aircraft_stat_modified`, with the pilot and `when: "match"`) and flags that pilot.
- **No pass, no capture:** a match too short for the pass, or a baseline without a capture, compares nothing.

## The check end to end

1. **The mod** (rvng_stats.lua, run from main.lua) writes `runtime.json.stats`:
   `{ format: "rvng_stats_1", groups: { <table>: { count, digest, entries: { <row key>: <16 hex> }, missing? } },
   planes: { <PlaneID>: { speedMax, speedStall, maxHealth, levels, digest } }, leaves, skipped, ms, slices,
   maxSliceMs }`.
   - A row's fingerprint is FNV-1a 64 over its text: field names and values in the game's property order, with
     numbers at full precision (`%.17g`).
   - A table's fingerprint is taken over its sorted `key=digest` pairs.
2. **The companion** sends them in the integrity report (`runtime.stats`). The game version is Steam's build id of the
   install (`steam-<buildid>`, from `steamapps/appmanifest_<appid>.acf`).
3. **`rvng baseline`** takes a clean install's `runtime.json` stats as the baseline's reference (its `aircraft` field).
4. **The server** (integrity.js `compareStats`) rejects on these findings:

   | Finding | Severity | What it means |
   |---|---|---|
   | `aircraft_stat_modified` | critical | A row whose fingerprint changed, with the table and row. For a plane it also gives its headline numbers, expected and actual. |
   | `stat_row_added` | critical | A row that the clean tables don't have. |
   | `stat_row_missing` | high | A row of the clean tables that the report lacks. |
   | `stat_table_missing` | high | A whole table missing from the report. |
   | `malformed_report` | critical | The stats don't have the expected shape. |
   | `runtime_stats_missing` | high | No stats were sent. |
   | `no_reference_stats` | high | The baseline was uploaded without stats. |

   `aircraft_stat_modified` and `stat_row_added` in a pilot's own scan also flag the account for review.
   - Bounds: at most 64 tables, 20,000 rows and 64-character keys.
   - At most 50 named findings, then one with the count of the rest.
5. **What it can't see:** a cheat that changes a plane's live copy in memory after the tables (the flight engine's
   working values) and leaves the tables alone, or a modified client that sends a clean runtime.json. Every check
   that runs on the player's PC can be lied to by a modified client. This one catches table edits, pak and Lua mods
   that change numbers, and memory edits of the tables, including after boot (each pass reads them again).

## Crash 1: run 20261121_180804 (stats_probe), 18:09:14

- **What:** EXCEPTION_ACCESS_VIOLATION reading address 0, right after the probe logged a plane row's `PlayerParameter`.
  The minidump's stack is unreadable (one ntdll frame repeated).
- **Next read in the probe:** the same row's `Reference`, a `TSoftClassPtr<ALivePlayerPlane>` [H]. Likely cause: UE4SS
  reading a soft class pointer through a null pointer. Native, so `pcall` can't catch it.
- **Rule since:**
  - The stats reader never reads soft object/class pointers, object pointers (except a plane's `PlayerParameter`
    table) or fixed-size arrays.
  - It takes each struct's field list from reflection first, and reads only plain values.
  - The probe logs before every risky read, so a crash names its read.
