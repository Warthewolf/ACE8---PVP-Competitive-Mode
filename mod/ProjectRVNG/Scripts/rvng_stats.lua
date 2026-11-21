--[[
  rvng_stats.lua : the stats check's in-game half (docs/re/STATS.md). It reads the game's own combat tables from
  ULiveInformationManager (planes with their flight model at every level, parts, weapons, damage rates, abilities,
  level-ups, stealth) and fingerprints them: one 64-bit FNV-1a hash per row over every plain value, in the game's own
  property order, and one per table over its rows. The server compares them with the same fingerprints taken on a
  clean install (the baseline), so a changed number anywhere in those tables shows, and names its plane or part.

  Only plain values are read: numbers, enums, bools, names and strings, nested structs, arrays of those, and a plane's
  PlayerParameter DataTable. Soft pointers, other object pointers, maps, texts, delegates and fixed-size arrays are
  never read: reading a plane row's soft class pointer crashed the game through UE4SS (crash 1, STATS.md). The field
  list comes from reflection (ForEachProperty), so a patch that adds or renames fields changes the fingerprint (a new
  baseline) and can't make the reader touch a field it doesn't know.

  The whole read is ~370,000 values. It runs as a job in slices (Stats.new(im), job:step(seconds)) so the game thread
  is never held for long; Stats.collect runs one to its end (tests, tools). Field lists are taken once per field path
  (all values at one path share one struct type), and every read is a plain pcall(fn, obj, key): no closures, no
  error-throwing type guesses (probe 2 took 32 s that way).
]]
local Stats = {}

-- The manager's tables, in a fixed order. name = the UPROPERTY; a TMap unless array = true.
Stats.GROUPS = {
  { name = "PlaneDataMap_" }, { name = "PlaneDataOnlyCarrierBasedMap_" }, { name = "OnlinePlaneDataMap_" },
  { name = "PartsDataMap_" }, { name = "PartsSlotMap_" }, { name = "PartsCostDataMap_" },
  { name = "PartsWeaponFilterConditionsMap_" }, { name = "WeaponDataMap_" }, { name = "WeaponSettingsDataMap_" },
  { name = "OnlinePlayerCategoryDamageRateDataMap_" }, { name = "AbilityDataMap_" }, { name = "AbilityLevelDataMap_" },
  { name = "AbilityWeaponFilterConditionsMap_" }, { name = "AircraftLevelupDataMap_" },
  { name = "AircraftLimitBreakDataMap_" }, { name = "AircraftLevelMaxDataMap_" }, { name = "AntiEnemyStealthDataMap_" },
  { name = "DoubleLockonBuffTable_" }, { name = "CampaignPlayerCategoryDamageRateDataMap_" },
  { name = "WeaponDurabilityDataTableRows", array = true }, { name = "ExplosionDurabilityDataTableRows", array = true },
  { name = "NpcWeaponDataTableRows", array = true },
}
-- The DataTables themselves (path = the asset): the weapons' numbers (damage, homing, fuses), durability per target
-- class, the damage rates, parts, abilities, the score rules. optional: some load only in some modes, so each is
-- compared when the baseline and the scan both have it (both are taken at the main menu).
for _, p in ipairs({
  "/Game/Datatables/AI/NPC/Weapon/DT_NPC_Weapon", "/Game/OnlineMode/DataTables/AI/NPC/DT_NPC_Weapon_ON",
  "/Game/Datatables/AI/NPC/WeaponDurability/DT_NPC_WeaponDurability", "/Game/OnlineMode/DataTables/AI/NPC/DT_NPC_WeaponDurability_ON",
  "/Game/Datatables/AI/NPC/ExplosionDurability/DT_NPC_ExplosionDurability",
  "/Game/OnlineMode/DataTables/AI/NPC/DT_NPC_ExplosionDurability_ON",
  "/Game/OnlineMode/DataTables/AI/Difficulty/WeaponDurabilityConfig/DT_WeaponDurabilityConfig_Plane",
  "/Game/OnlineMode/DataTables/AI/Difficulty/WeaponDurabilityConfig/DT_WeaponDurabilityConfig_Default",
  "/Game/Datatables/Information/DT_CategoryDamageRateForPlayerDataTable",
  "/Game/OnlineMode/DataTables/Information/DT_CategoryDamageRateForPlayerDataTable_ON",
  "/Game/Datatables/Information/DT_DoubleLockonDataTable", "/Game/Datatables/Information/DT_GlobalIntValues",
  "/Game/Datatables/Information/DT_LiveParts", "/Game/Datatables/Information/DT_LivePartsSlotSettings",
  "/Game/Datatables/Information/DT_LiveWeapon", "/Game/Datatables/PLAYER/DT_LiveAircraft", "/Game/Datatables/PLAYER/DT_WeaponSettings",
  "/Game/Datatables/Information/Score/DT_GameModeScoreCalculationTable", "/Game/OnlineMode/DataTables/Information/DT_Ability",
  "/Game/OnlineMode/DataTables/Information/DT_AbilityWeaponFilterConditions",
  "/Game/OnlineMode/DataTables/Information/DT_OnlineAircraftParam",
  "/Game/OnlineMode/DataTables/Information/DT_PartsWeaponFilterConditions",
}) do
  local name = p:match("([^/]+)$")
  Stats.GROUPS[#Stats.GROUPS + 1] = { name = name, path = p .. "." .. name, optional = true }
end

-- Property classes read as plain values: numbers (and enums), bools, names and strings.
local NUMBER = {
  IntProperty = true, Int8Property = true, Int16Property = true, Int64Property = true, UInt16Property = true,
  UInt32Property = true, UInt64Property = true, FloatProperty = true, DoubleProperty = true, ByteProperty = true,
  EnumProperty = true,
}
local TEXTLIKE = { NameProperty = true, StrProperty = true }
local function plain(cls) return NUMBER[cls] or cls == "BoolProperty" or TEXTLIKE[cls] end
-- Object pointers walked: only a plane's flight-model table (a UDataTable), by name.
local TABLE_FIELDS = { PlayerParameter = true }
-- Fixed-size arrays (C arrays in the header dump): never read (UE4SS's static-array reads are untested here).
local STATIC_ARRAYS = { WeatheringParameterLimit = true }

-- ---- FNV-1a 64 (Lua 5.4 integers wrap mod 2^64) ----------------------------------------------------------------
local FNV_OFFSET, FNV_PRIME = -3750763034362895579, 1099511628211   -- 0xcbf29ce484222325, 0x100000001b3
local byte = string.byte
function Stats.hash(s)
  local h, n, i = FNV_OFFSET, #s, 1
  while i + 7 <= n do
    local a, b, c, d, e, f, g, k = byte(s, i, i + 7)
    h = (h ~ a) * FNV_PRIME; h = (h ~ b) * FNV_PRIME; h = (h ~ c) * FNV_PRIME; h = (h ~ d) * FNV_PRIME
    h = (h ~ e) * FNV_PRIME; h = (h ~ f) * FNV_PRIME; h = (h ~ g) * FNV_PRIME; h = (h ~ k) * FNV_PRIME
    i = i + 8
  end
  while i <= n do h = (h ~ byte(s, i)) * FNV_PRIME; i = i + 1 end
  return string.format("%016x", h)
end

-- ---- reads: plain functions for pcall (no closure per read) -----------------------------------------------------
local function getField(o, k) return o[k] end
local function getValue(o) return o:get() end
local function toStr(o) return o:ToString() end
local function rowNames(dt) return dt:GetRowNames() end
local function findRow(dt, n) return dt:FindRow(n) end
local function arrayNum(a) return a:GetArrayNum() end
local function isValid(o) return o:IsValid() end
local fmt, mtype, concat = string.format, math.type, table.concat

local function num(v)
  if mtype(v) == "integer" then return fmt("%d", v) end
  if v ~= v then return "nan" end
  return fmt("%.17g", v)
end
local function unwrap(v)                               -- (a map or array element comes in a get() wrapper)
  if type(v) == "userdata" or type(v) == "table" then
    local ok, g = pcall(getValue, v)
    if ok and g ~= nil then return g end
  end
  return v
end
local function text(v)                                 -- an FName/FString (or an FName already a string)
  if type(v) == "string" then return v end
  local ok, s = pcall(toStr, v)
  if ok and type(s) == "string" then return s end
end

-- A struct's field list by reflection: { {name, cls, inner} }, its parents' fields first (ForEachProperty lists a
-- struct's own fields only: FLiveWeaponSettingsDataTable's damage, homing and fuses are its parent's). Taken once per
-- field path (cache). superVia: how the parent was found (logged by the in-game test).
Stats.superVia = {}
local function superOf(sv)
  local ok, sup = pcall(function() return sv:GetSuperStruct() end)
  if ok and sup ~= nil and pcall(function() return sup.ForEachProperty end) then
    local okV, valid = pcall(isValid, sup)
    if not okV or valid then Stats.superVia.GetSuperStruct = (Stats.superVia.GetSuperStruct or 0) + 1; return sup end
  end
end
local function ownProps(sv, list)
  pcall(function()
    sv:ForEachProperty(function(p)
      local okN, name = pcall(function() return p:GetFName():ToString() end)
      local okC, cls = pcall(function() return p:GetClass():GetFName():ToString() end)
      local inner
      if okC and cls == "ArrayProperty" then
        local okI, i = pcall(function() return p:GetInner():GetClass():GetFName():ToString() end)
        inner = okI and i or nil
      end
      if okN and name then list[#list + 1] = { name, okC and cls or "?", inner } end
    end)
  end)
  return list
end
-- (the fallback: the struct's own object by its name, then its parent)
local MODULES = { "/Script/Live.", "/Script/AceFlightEngine.", "/Script/CoreUObject.", "/Script/Engine." }
local function superByName(sv)
  local okN, n = pcall(function() return sv:GetFName():ToString() end)
  if not okN or type(n) ~= "string" or n == "" or type(StaticFindObject) ~= "function" then return end
  for _, m in ipairs(MODULES) do
    local okS, so = pcall(StaticFindObject, m .. n)
    if okS and so ~= nil then
      local sup = superOf(so)
      if sup then Stats.superVia.byName = (Stats.superVia.byName or 0) + 1; return sup end
      return
    end
  end
end
local function listProps(sv)
  local chain, cur = {}, sv
  for _ = 1, 8 do                                        -- (the parents, nearest first; FTableRowBase has no fields)
    local sup = superOf(cur) or (cur == sv and superByName(sv)) or nil
    if not sup then break end
    chain[#chain + 1] = sup
    cur = sup
  end
  local list = {}
  for i = #chain, 1, -1 do ownProps(chain[i], list) end
  return ownProps(sv, list)
end

-- ---- the walk: out = the text parts; st = { leaves, skipped, props cache } ---------------------------------------
local walkStruct

local function skip(st, what) st.skipped[what] = (st.skipped[what] or 0) + 1 end

-- one value of property class cls (an array element: its inner class), at field path `path`
local function walkValue(v, cls, out, st, path, fieldName)
  if v == nil then skip(st, "nil " .. tostring(cls)); out[#out + 1] = "~"; return end
  if NUMBER[cls] then
    if type(v) == "number" then st.leaves = st.leaves + 1; out[#out + 1] = num(v); return end
  elseif cls == "BoolProperty" then
    if type(v) == "boolean" then st.leaves = st.leaves + 1; out[#out + 1] = v and "T" or "F"; return end
  elseif TEXTLIKE[cls] then
    local s = text(v)
    -- (an FName's text is the case it was first made with, which differs between launches: "EASY", then "Easy")
    if s then st.leaves = st.leaves + 1; out[#out + 1] = "'" .. (cls == "NameProperty" and s:lower() or s) .. "'"; return end
  elseif cls == "StructProperty" then
    out[#out + 1] = "{"; walkStruct(v, out, st, path); out[#out + 1] = "}"
    return
  elseif cls == "ObjectProperty" and TABLE_FIELDS[fieldName] then
    local ok, names = pcall(rowNames, v)
    if ok and type(names) == "table" then
      local rows = {}
      for _, n in ipairs(names) do rows[#rows + 1] = text(n) or tostring(n) end
      table.sort(rows, function(x, y) return x:lower() < y:lower() end)
      out[#out + 1] = "<"
      for _, rn in ipairs(rows) do
        local okR, row = pcall(findRow, v, rn)
        out[#out + 1] = rn:lower() .. "{"
        if okR and row ~= nil then walkStruct(unwrap(row), out, st, path .. "<>") else skip(st, "row unreadable") end
        out[#out + 1] = "}"
      end
      out[#out + 1] = ">"
      return
    end
  end
  skip(st, "unexpected " .. tostring(cls) .. " value")
  out[#out + 1] = "?"
end

function walkStruct(sv, out, st, path)
  local props = st.props[path]
  if not props then props = listProps(sv); st.props[path] = props end
  for i = 1, #props do
    local p = props[i]
    local name, cls, inner = p[1], p[2], p[3]
    if STATIC_ARRAYS[name] then
      skip(st, cls)
    elseif plain(cls) or cls == "StructProperty" or (cls == "ObjectProperty" and TABLE_FIELDS[name]) then
      out[#out + 1] = name; out[#out + 1] = "="
      local ok, v = pcall(getField, sv, name)
      if not ok then v = nil end                         -- (not `ok and v or nil`: that turns every false bool into nil)
      walkValue(v, cls, out, st, path .. "." .. name, name)
      out[#out + 1] = ";"
    elseif cls == "ArrayProperty" and (plain(inner) or inner == "StructProperty") then
      -- (an array only when its element type is known to be plain: an array of soft pointers would be crash 1 again)
      out[#out + 1] = name; out[#out + 1] = "=["
      local ok, a = pcall(getField, sv, name)
      if ok and a ~= nil then
        local okN, n = pcall(arrayNum, a)
        out[#out + 1] = tostring(okN and n or "?"); out[#out + 1] = ":"
        local epath = path .. "." .. name .. "[]"
        pcall(function() a:ForEach(function(_, e) walkValue(unwrap(e), inner, out, st, epath); out[#out + 1] = "," end) end)
      end
      out[#out + 1] = "];"
    else
      skip(st, cls .. (inner and ("<" .. inner .. ">") or (cls == "ArrayProperty" and "<?>" or "")))
    end
  end
end

local function keyText(k)                              -- (an FName key: lowercased, as FName values)
  k = unwrap(k)
  if type(k) == "number" then return num(k) end
  local s = text(k)
  return s and s:lower() or tostring(k)
end

-- A plane's headline numbers (level 1 of its first PlayerParameter row), for a readable finding.
local function headline(plane)
  local h = {}
  pcall(function()
    local dt = plane.PlayerParameter
    local names = dt:GetRowNames()
    local rows = {}
    for _, n in ipairs(names) do rows[#rows + 1] = text(n) or tostring(n) end
    table.sort(rows)
    local row = unwrap(dt:FindRow(rows[1]))
    local lp = row.LevelParameter
    local l1 = unwrap(lp[1])
    local fe = l1.FlightEnginePlayerParameter
    h.speedMax, h.speedStall, h.maxHealth = fe.SpeedMax, fe.SpeedStall, l1.MaxHealth
    h.levels = lp:GetArrayNum()
  end)
  return h
end

-- ---- the job ----------------------------------------------------------------------------------------------------
local Job = {}
Job.__index = Job

--- A read of every group, to be run in slices. im: the ULiveInformationManager (found when nil). opts.only: a set of
-- group names to read (the in-match pass: the tables the menu didn't have loaded), the rest left out.
-- Returns the job, or nil, why.
function Stats.new(im, opts)
  if im == nil then
    local ok, found = pcall(FindFirstOf, "LiveInformationManager")
    im = ok and found or nil
  end
  local okV, valid = pcall(isValid, im)
  if not (im and okV and valid) then return nil, "the information manager isn't there yet" end
  local job = setmetatable({ im = im, only = opts and opts.only, gi = 1, done = 0, entries = {}, count = 0, cpu = 0, slices = 0, maxSlice = 0,
    st = { leaves = 0, skipped = {}, props = {} },
    res = { format = "rvng_stats_1", groups = {}, planes = {}, leaves = 0, skipped = {} } }, Job)
  job.res.skipped = job.st.skipped
  return job
end

local function finishGroup(job, g, missing)
  local keys = {}
  for k in pairs(job.entries) do keys[#keys + 1] = k end
  table.sort(keys)
  local all = {}
  for i, k in ipairs(keys) do all[i] = k .. "=" .. job.entries[k] end
  job.res.groups[g.name] = { count = job.count, digest = Stats.hash(concat(all, ";")), entries = job.entries,
    missing = missing or nil, optional = g.optional or nil }
  job.gi, job.done, job.entries, job.count, job.rows = job.gi + 1, 0, {}, 0, nil
end

-- one row: its text, its fingerprint, (a plane) its headline numbers
local function oneRow(job, g, key, value, idx)
  local out = {}
  walkValue(value, "StructProperty", out, job.st, g.name)
  local textOut = concat(out)
  local digest = Stats.hash(textOut)
  if Stats.keepText and Stats.keepText[g.name] then       -- (tests: a row's whole text, to find what differs)
    job.res.texts = job.res.texts or {}
    job.res.texts[g.name .. "/" .. key] = textOut
  end
  if job.entries[key] then key = key .. "#" .. idx end    -- (an array's rows keep their order)
  job.entries[key] = digest
  job.count = job.count + 1
  if g.name == "PlaneDataMap_" then
    local h = headline(value)
    h.digest = digest
    job.res.planes[key] = h
  end
end

local function findObject(path)
  if type(StaticFindObject) ~= "function" then return nil end
  local ok, o = pcall(StaticFindObject, path)
  if not ok or o == nil then return nil end
  local okV, valid = pcall(isValid, o)
  if okV and not valid then return nil end
  return o
end

--- Runs the job for about `budget` seconds of CPU (at least one row). Returns true once every group is read
-- (the result: job.res).
function Job:step(budget)
  local t0 = os.clock()
  local deadline = t0 + (budget or math.huge)
  self.slices = self.slices + 1
  while self.gi <= #Stats.GROUPS do
    local g = Stats.GROUPS[self.gi]
    if Stats.trace and self.done == 0 then Stats.trace(g.name) end   -- (the in-game probe: a crash names its table)
    if self.only and not self.only[g.name] then
      self.gi = self.gi + 1                                 -- (not asked for: left out of this read)
    elseif g.path then
      -- a DataTable: its rows by name, in a fixed (lowercased) order, resumed by index
      local dt = findObject(g.path)
      if not self.rows and dt then
        local ok, names = pcall(rowNames, dt)
        if ok and type(names) == "table" then
          local rows = {}
          for _, n in ipairs(names) do rows[#rows + 1] = text(n) or tostring(n) end
          table.sort(rows, function(x, y) return x:lower() < y:lower() end)
          self.rows = rows
        end
      end
      if not dt or not self.rows then
        finishGroup(self, g, true)
      else
        local did = 0
        while self.done < #self.rows do
          if did > 0 and os.clock() >= deadline then break end
          local i = self.done + 1
          local rn = self.rows[i]
          local ok, row = pcall(findRow, dt, rn)
          if ok and row ~= nil then oneRow(self, g, rn:lower(), unwrap(row), i) else skip(self.st, "row unreadable") end
          self.done, did = i, did + 1
        end
        if self.done >= #self.rows then finishGroup(self, g) end
      end
    else
      local okF, field = pcall(getField, self.im, g.name)
      if not okF or field == nil then
        finishGroup(self, g, true)
      else
        -- (a TMap/TArray can't be stopped or resumed mid-ForEach: each slice walks it again and reads only the rows
        -- after the last one done; walking past rows is cheap, reading them is not)
        local idx, stopped, did = 0, false, 0
        pcall(function()
          field:ForEach(function(k, v)
            idx = idx + 1
            if stopped or idx <= self.done then return end
            if did > 0 and os.clock() >= deadline then stopped = true; return end   -- (one row per slice at least)
            local key
            if g.array then key = fmt("%04d", k) else key = keyText(k) end
            oneRow(self, g, key, unwrap(v), idx)
            self.done, did = idx, did + 1
          end)
        end)
        if not stopped then finishGroup(self, g) end
      end
    end
    if os.clock() >= deadline and self.gi <= #Stats.GROUPS then
      local took = os.clock() - t0
      self.cpu, self.maxSlice = self.cpu + took, math.max(self.maxSlice, took)
      return false
    end
  end
  local took = os.clock() - t0
  self.cpu, self.maxSlice = self.cpu + took, math.max(self.maxSlice, took)
  self.res.leaves = self.st.leaves
  self.res.maxSliceMs = math.floor(self.maxSlice * 1000 + 0.5)
  self.res.ms = math.floor(self.cpu * 1000 + 0.5)
  self.res.slices = self.slices
  return true
end

--- Reads and fingerprints every group in one go. Returns { format, groups = { name = { count, digest, entries =
-- { key = hex }, missing? } }, planes = { id = { speedMax, speedStall, maxHealth, levels, digest } }, leaves, skipped,
-- ms, slices } or nil, why.
function Stats.collect(im)
  local job, why = Stats.new(im)
  if not job then return nil, why end
  job:step(nil)
  return job.res
end

return Stats
