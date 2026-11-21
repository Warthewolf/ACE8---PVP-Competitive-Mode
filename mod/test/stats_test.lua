-- Runs mod/ProjectRVNG/Scripts/rvng_stats.lua against fake UE4SS objects shaped like the stats probe found them
-- (docs/re/STATS.md): TMap/TArray ForEach with get() wrappers, struct values with ForEachProperty and fields by name,
-- a plane's PlayerParameter UDataTable. Usage: lua5.4 stats_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
local Stats = require("rvng_stats")

local touched = {}                        -- fields the reader must never read (crash 1)
local function name(s) return { ToString = function() return s end } end
local function wrap(v) return { get = function() return v end } end
local function prop(n, cls, inner)
  return { GetFName = function() return name(n) end, GetClass = function() return { GetFName = function() return name(cls) end } end,
    GetInner = function() if not inner then error("no inner") end return prop("inner", inner) end }
end
-- a struct value: fields = { {name, cls, value, inner, forbidden} ... }
local function struct(fields)
  local byName = {}
  for _, f in ipairs(fields) do byName[f[1]] = f end
  local s = {}
  s.ForEachProperty = function(_, cb) for _, f in ipairs(fields) do cb(prop(f[1], f[2], f[4])) end end
  return setmetatable(s, { __index = function(_, k)
    local f = byName[k]
    if not f then return nil end
    if f[5] then touched[#touched + 1] = k; error("forbidden read " .. k) end
    return f[3]
  end })
end
local function array(list)
  local a = { GetArrayNum = function() return #list end,
    ForEach = function(_, cb) for i, e in ipairs(list) do cb(i, wrap(e)) end end }
  return setmetatable(a, { __index = function(_, i) return list[i] end })
end
local function map(pairs_)
  return { ForEach = function(_, cb) for _, kv in ipairs(pairs_) do cb(wrap(kv[1]), wrap(kv[2])) end end }
end
local function datatable(rows)
  local names = {}
  for n in pairs(rows) do names[#names + 1] = name(n) end
  return { GetRowNames = function() return names end, FindRow = function(_, n) return rows[n] end }
end

local function vec(x, y, z) return struct({ { "X", "DoubleProperty", x }, { "Y", "DoubleProperty", y }, { "Z", "DoubleProperty", z } }) end
local function level(speedMax, hp)
  return struct({
    { "FlightEnginePlayerParameter", "StructProperty", struct({
      { "SpeedMax", "FloatProperty", speedMax }, { "SpeedStall", "FloatProperty", 160.5 },
      { "AddRotR", "StructProperty", vec(1.25, 2.5, 0.75) }, { "DriftIsEndReleaseThrottle", "BoolProperty", true } }) },
    { "MaxHealth", "IntProperty", hp }, { "FlareLoadCount", "IntProperty", 4 },
  })
end
local function plane(id, speedMax, extra)
  local lv = { level(speedMax, 100), level(speedMax + 50, 120) }
  return struct({
    { "PlaneID", "IntProperty", id }, { "PlaneStringID", "NameProperty", name("PP" .. id) },
    { "Reference", "SoftClassProperty", nil, nil, true },                        -- (crash 1: never read)
    { "WeatheringParameterLimit", "Int8Property", 3, nil, true },                -- (a fixed-size array: never read)
    { "AircraftThumbnail", "SoftObjectProperty", nil, nil, true },
    { "Icons", "ArrayProperty", nil, "SoftObjectProperty", true },               -- (an array of soft pointers)
    { "PlaneNameTextID", "StrProperty", name("PLANE_" .. id) },
    { "PlayerParameter", "ObjectProperty", datatable({ Row_1 = struct({
      { "SpWeaponID1", "EnumProperty", 7 }, { "LevelParameter", "ArrayProperty", array(lv), "StructProperty" } }) }) },
    extra,
  })
end
local function part(id, value)
  return struct({ { "PartsID", "IntProperty", id },
    { "PartsData", "ArrayProperty", array({ struct({ { "ParameterLabel", "EnumProperty", 1 }, { "OperationType", "ByteProperty", 0 },
      { "ParameterValue", "FloatProperty", value } }) }), "StructProperty" },
    { "Filter", "ArrayProperty", array({ 2, 5 }), "EnumProperty" }, { "DLCID", "StrProperty", name("Live") } })
end
local function manager(o)
  o = o or {}
  local im = { IsValid = function() return true end,
    PlaneDataMap_ = map({ { 1010, plane(1010, 900.25) }, { 2041, plane(2041, o.speed2041 or 1200.5) } }),
    PartsDataMap_ = map({ { 2001802, part(2001802, o.part or 0.35) }, { 2001803, part(2001803, 0.5) } }),
    WeaponDurabilityDataTableRows = array({ struct({ { "Rate", "FloatProperty", 1.5 } }) }),
  }
  return im
end

-- 1. FNV-1a 64 against its published vectors
assert(Stats.hash("") == "cbf29ce484222325", "fnv of ''")
assert(Stats.hash("a") == "af63dc4c8601ec8c", "fnv of 'a'")
assert(Stats.hash("foobar") == "85944171f73967e8", "fnv of 'foobar'")

-- 2. a whole collect: every group, the plane's flight model at every level, the parts, never a forbidden field
local r = assert(Stats.collect(manager()))
assert(r.format == "rvng_stats_1")
assert(#touched == 0, "forbidden fields read: " .. table.concat(touched, ","))
local P, Q = r.groups.PlaneDataMap_, r.groups.PartsDataMap_
assert(P.count == 2 and P.entries["1010"] and P.entries["2041"], "both planes")
assert(Q.count == 2 and Q.entries["2001802"], "both parts")
assert(r.groups.WeaponDurabilityDataTableRows.count == 1 and r.groups.WeaponDurabilityDataTableRows.entries["0001"], "an array group")
assert(r.groups.WeaponDataMap_.missing == true and r.groups.WeaponDataMap_.count == 0, "a group the manager lacks")
assert(r.skipped.SoftClassProperty == 2 and r.skipped.SoftObjectProperty == 2 and r.skipped["ArrayProperty<SoftObjectProperty>"] == 2,
  "soft pointers skipped, never read")
-- leaves per plane: PlaneID, PlaneStringID, PlaneNameTextID, SpWeaponID1, 2 levels x (SpeedMax, SpeedStall, X, Y, Z, Drift,
-- MaxHealth, Flares) = 4 + 16 = 20; per part: PartsID, 3 PartsData, 2 Filter, DLCID = 7; the array row: 1
assert(r.leaves == 2 * 20 + 2 * 7 + 1, "every plain value read once: " .. r.leaves)
local h = r.planes["1010"]
assert(h and h.speedMax == 900.25 and h.speedStall == 160.5 and h.maxHealth == 100 and h.levels == 2 and h.digest == P.entries["1010"],
  "the plane's headline numbers")

-- 3. the same tables, the same fingerprints; one changed number changes only its row (and its table)
local r2 = Stats.collect(manager())
for g, v in pairs(r.groups) do assert(r2.groups[g].digest == v.digest, "repeatable: " .. g) end
local r3 = Stats.collect(manager({ part = 0.36 }))
assert(r3.groups.PartsDataMap_.entries["2001802"] ~= Q.entries["2001802"], "a changed part value shows")
assert(r3.groups.PartsDataMap_.entries["2001803"] == Q.entries["2001803"], "the other part unchanged")
assert(r3.groups.PartsDataMap_.digest ~= Q.digest and r3.groups.PlaneDataMap_.digest == P.digest, "only the parts table differs")
-- a flight-model number deep in the plane's level 2 (SpeedMax + 50)
local r4 = Stats.collect(manager({ speed2041 = 1200.75 }))
assert(r4.groups.PlaneDataMap_.entries["2041"] ~= P.entries["2041"] and r4.groups.PlaneDataMap_.entries["1010"] == P.entries["1010"],
  "a changed flight-model number shows on its plane only")
-- a float that differs in its last bits still shows (no rounding)
local r5 = Stats.collect(manager({ part = 0.35 + 2 ^ -40 }))
assert(r5.groups.PartsDataMap_.entries["2001802"] ~= Q.entries["2001802"], "full precision")

-- 4. the job in slices: one row per slice (budget 0) gives the same read as one go, in many slices
local job = assert(Stats.new(manager()))
local slices = 0
repeat slices = slices + 1; assert(slices < 1000, "the job makes progress") until job:step(0)
for g, v in pairs(r.groups) do assert(job.res.groups[g].digest == v.digest and job.res.groups[g].count == v.count, "sliced: " .. g) end
assert(job.res.leaves == r.leaves and job.res.planes["1010"].digest == r.planes["1010"].digest, "sliced: the same values")
assert(slices >= 5 and job.res.slices == slices, "one row per slice: " .. slices .. " slices")
-- a generous budget: one slice
local job2 = assert(Stats.new(manager()))
assert(job2:step(10) == true and job2.res.slices == 1, "a big budget reads it all in one slice")

-- 5. the game's shape (probe 2): GetRowNames hands plain strings
do
  local saved = datatable
  local im = manager()
  local pl = plane(1010, 900.25)
  local dtv = getmetatable(pl).__index(pl, "PlayerParameter")
  dtv.GetRowNames = function() return { "Row_1" } end
  im.PlaneDataMap_ = map({ { 1010, pl }, { 2041, plane(2041, 1200.5) } })
  local rs = assert(Stats.collect(im))
  assert(rs.groups.PlaneDataMap_.entries["1010"] == P.entries["1010"], "row names as strings read the same")
  assert(rs.planes["1010"].speedMax == 900.25, "and the headline")
  datatable = saved
end

-- 6. FName case (2026-11-21: one launch's "EASY" was the next one's "Easy"): keys, values and row names lowercased
do
  local function weaponSettings(key, nameValue)
    local im = manager()
    im.WeaponSettingsDataMap_ = map({ { name(key), struct({ { "Mode", "NameProperty", name(nameValue) }, { "LockonAngle", "FloatProperty", 36.25 } }) } })
    return assert(Stats.collect(im)).groups.WeaponSettingsDataMap_
  end
  local a, b = weaponSettings("EASY", "Missile_A"), weaponSettings("Easy", "MISSILE_a")
  assert(a.entries.easy and b.entries.easy and a.entries.easy == b.entries.easy and a.digest == b.digest,
    "the same table whatever case its FNames came out in")
end

-- 7. a struct's parent's fields (FLiveWeaponSettingsDataTable : FLiveNpcWeaponDataTable: damage is the parent's)
do
  local function weapon(damage)
    local parent = { ForEachProperty = function(_, cb) cb(prop("WeaponID", "EnumProperty")); cb(prop("damage", "FloatProperty")) end }
    local v = struct({ { "LockonAngle", "FloatProperty", 36.25 }, { "WeaponID", "EnumProperty", 12 }, { "damage", "FloatProperty", damage } })
    -- (ForEachProperty lists the struct's own field only; the parent's come from GetSuperStruct)
    v.ForEachProperty = function(_, cb) cb(prop("LockonAngle", "FloatProperty")) end
    v.GetSuperStruct = function() return parent end
    local im = manager()
    im.WeaponSettingsDataMap_ = map({ { name("EASY"), v } })
    Stats.keepText = { WeaponSettingsDataMap_ = true }
    local res = assert(Stats.collect(im))
    Stats.keepText = nil
    return res
  end
  local r1, r2 = weapon(1500), weapon(9999)
  local t = r1.texts["WeaponSettingsDataMap_/easy"]
  assert(t == "{WeaponID=12;damage=1500;LockonAngle=36.25;}", "the parent's fields first, then its own: " .. tostring(t))
  assert(r1.groups.WeaponSettingsDataMap_.entries.easy ~= r2.groups.WeaponSettingsDataMap_.entries.easy, "a changed damage shows")
  assert((Stats.superVia.GetSuperStruct or 0) > 0, "found through GetSuperStruct")
end

-- 8. a DataTable by its path: rows in a fixed order, optional, resumable between slices; absent: missing, optional
do
  local rows = {}
  for i = 1, 7 do rows["Row_" .. i] = struct({ { "damage", "FloatProperty", 100 + i }, { "Name", "NameProperty", name("W" .. i) } }) end
  local dt = datatable(rows)
  dt.IsValid = function() return true end
  local found = {}
  StaticFindObject = function(p)
    found[#found + 1] = p
    if p == "/Game/Datatables/AI/NPC/Weapon/DT_NPC_Weapon.DT_NPC_Weapon" then return dt end
  end
  local one = assert(Stats.collect(manager()))
  local g = one.groups.DT_NPC_Weapon
  assert(g and g.count == 7 and g.optional == true and not g.missing and g.entries.row_1, "the table read, its rows lowercased")
  local absent = one.groups.DT_NPC_Weapon_ON
  assert(absent and absent.missing == true and absent.optional == true and absent.count == 0, "a table not loaded: missing, optional")
  local jb = assert(Stats.new(manager()))
  local n = 0
  repeat n = n + 1 until jb:step(0)
  assert(jb.res.groups.DT_NPC_Weapon.digest == g.digest and n > 7, "sliced row by row: the same table")
  rows.Row_3 = struct({ { "damage", "FloatProperty", 5000 }, { "Name", "NameProperty", name("W3") } })
  local changed = assert(Stats.collect(manager())).groups.DT_NPC_Weapon
  assert(changed.entries.row_3 ~= g.entries.row_3 and changed.entries.row_2 == g.entries.row_2, "a changed weapon row shows on its own")
  StaticFindObject = nil
end

-- 9. a false bool is a value (2026-11-21: `ok and v or nil` read 2,344 of the game's false bools as nothing)
do
  local function flags(b)
    local im = manager()
    im.WeaponSettingsDataMap_ = map({ { 1, struct({ { "bIsAntiShip", "BoolProperty", b }, { "bIsHoming", "BoolProperty", true } }) } })
    return assert(Stats.collect(im))
  end
  local f, t = flags(false), flags(true)
  assert(f.skipped["nil BoolProperty"] == nil, "a false bool isn't counted as nothing")
  assert(f.groups.WeaponSettingsDataMap_.entries["1"] ~= t.groups.WeaponSettingsDataMap_.entries["1"], "false and true differ")
end
-- a field that reads as nothing is counted, by its class
do
  local im = manager()
  im.WeaponSettingsDataMap_ = map({ { 1, struct({ { "bUseCameraLockOn", "BoolProperty", nil } }) } })
  local res = assert(Stats.collect(im))
  assert(res.skipped["nil BoolProperty"] == 1, "a bool read as nothing: counted")
end

-- 10. a read of chosen tables only (the in-match pass): the rest left out, those the same as in a whole read
do
  local only = assert(Stats.new(manager(), { only = { PartsDataMap_ = true } }))
  only:step(nil)
  local names = {}
  for k in pairs(only.res.groups) do names[#names + 1] = k end
  assert(#names == 1 and only.res.groups.PartsDataMap_.digest == Q.digest, "only the parts: " .. table.concat(names, ","))
end

-- 11. no manager yet
FindFirstOf = function() return nil end
local none, why = Stats.collect()
assert(none == nil and why:find("isn't there"), "no manager: nil and why")

print("all stats checks passed")
