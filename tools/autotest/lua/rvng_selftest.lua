--[[
  rvng_selftest.lua : RVNG's in-game self-test. tools/autotest/kit.py installs it (and requires it from the installed
  main.lua's copy) for a gated test run only; it is in no build.

  It reads Scripts/selftest.txt (suite=, max_s=, menu_timeout_s=, menu_wait_s=, watch_s=), runs the suite's steps on
  RVNG's game-thread tick (rvng_tick.lua, once a second: never a coroutine, never on UE4SS's async thread), and writes
  `selftest: PASS <what>` / `selftest: FAIL <what>` / `selftest: INFO ...` and finally `selftest: RESULT <passed>/<total>`
  into RVNG's log (RVNG_Log). tools/autotest/job.py follows that log and closes the game on RESULT: the deathmatch fast
  path skips the menu's mission setup, so the game's own end flow must never run into QuitGame.

  Suites (docs/IN_GAME_TESTS.md):
    smoke   the runtime's Lua functions and hooks, the main menu reached, offline there
    menu    smoke, then STORE off and ONLINE turned into COMPETITIVE 1V1 (rvng_menu.lua + the DLL), pressed by the job
    flags   test 1: smoke, then watch_s more seconds at the main menu, offline the whole time
    dm_a    test 2 run A (d2=0 w1=0): the game's own travel to PL_DM_001, the online states up to 12, held there
    dm_b    test 2 run B (d2=1): through 12 and the 210 s match (14) to time-up, held at 15
    dm_c    test 2 run C (d2=1 w1=1 d6=1): on through 16..19 (Ended), then the main menu instead of the Result map
    dm_f    test 6: dm_c with faction=2: the local user's faction entry (NM+0x4d0) written as Bravo, the plane Bravo,
            its start at a Bravo start point, the end pictures (the scoreboard's label)
    dm_s    test 3: dm_c with opponent=1: a fake second member in the room tables, the game's own remote spawn makes the
            opponent's copy (role 2, netId 2), the tables emptied after the match
    dm_l3   test 5: dm_l with the local plane role 3 (lb_role3=1), as online
    dm_g    D3/D4: dm_h with guest=1: this PC the guest; its hits become DamageClients for the host (stood in for here),
            its score function off
    dm_h    test 7: dm_l3 with hit=1: the local plane hits the copy through the game's own damage path, kills it, the copy
            respawns
    dm_l    test 4: dm_s with loopback=1: the local plane's Physics messages captured at Send (replaced), encoded and
            decoded with the game's MessagePack code, re-keyed and routed to the copy, which flies 150 m ahead
    dm_x    the lost link: 120 s into the match the game mode's forced end (Finished), then W1, D6, the main menu
    prod    a normal install (probe=0): the web gates shut, the boot login ended (D7), the main menu's rows, pictures
    net     prod with the network log (netlog=1); net_dm: dm_c with it. Every suite checks D9's wall is in and ends
            with what it refused
]]
local Tick = require("rvng_tick")
local Probe = require("rvng_probe")

local ST = { pass = 0, fail = 0, conf = { suite = "smoke", max_s = 900, menu_timeout_s = 240, menu_wait_s = 20, watch_s = 60 } }
do
  local dir = debug.getinfo(1, "S").source:match("^@(.*[/\\])") or ""
  local f = io.open(dir .. "selftest.txt", "r")
  if f then
    for line in f:lines() do
      local k, v = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
      if k then ST.conf[k] = tonumber(v) or v end
    end
    f:close()
  end
end
for k, v in pairs(rawget(_G, "RVNG_SELFTEST_CONF") or {}) do ST.conf[k] = v end   -- (the Lua tests only)
local C = ST.conf
-- dm_p: a normal install's match (probe=0, no test logger): the match hooks idle until the launch arms the match.
-- (Defined here, before the shared steps that read it: a later `local` is a nil global to them; run of 21:54)
local prodMatch = tostring(C.suite) == "dm_p"

local function say(msg)
  if type(rawget(_G, "RVNG_Log")) == "function" then RVNG_Log("selftest: " .. msg) end
  print("[ProjectRVNG] selftest: " .. msg .. "\n")
end
local function check(ok, what, detail)
  if ok then ST.pass = ST.pass + 1 else ST.fail = ST.fail + 1 end
  say((ok and "PASS " or "FAIL ") .. what .. (detail ~= nil and (" (" .. tostring(detail) .. ")") or ""))
  return ok
end
local function info(msg) say("INFO " .. msg) end

if type(rawget(_G, "RVNG_Version")) ~= "function" then
  print("[ProjectRVNG] selftest: the native runtime isn't loaded: nothing to test\n")
  return ST
end

-- ---- steps: fn(elapsed s in the step) returns "next", "abort" or nil (again next tick) ----------------------------
local steps = {}
local function step(name, timeout, fn) steps[#steps + 1] = { name = name, timeout = timeout, fn = fn } end
local function wait(name, s) step(name, nil, function(e) if e >= s then return "next" end end) end

-- The main menu: the game's own RequestChangeMap to its map (the runtime logs every one; RVNG_LastMap). A widget lookup
-- doesn't work: FindFirstOf matches the exact class only, and the menu's widgets are blueprint subclasses (run of
-- 2026-11-18 18:14).
local function mainMenu()
  local m = RVNG_LastMap()
  return type(m) == "string" and m:find("PL_MainMenu", 1, true) ~= nil
end

-- D9 (0.3.6): the network wall, in every install. RVNG_WallInfo: (0)/(1) send points hooked of how many, (2)/(3) the
-- nine more gates; (4..9) refused: LiveWebAPI requests, Cosmos calls, engine HTTP requests, WebSocket connects, Strix
-- starts, Messenger set-ups; (10)/(11) the more gates' calls and how many the game would have answered true; (12) queued
local function wallStep()
  step("D9: the network wall", 5, function()
    if type(rawget(_G, "RVNG_WallInfo")) ~= "function" then check(false, "D9: the runtime has the network wall"); return "next" end
    local W = RVNG_WallInfo
    check(W(0) == W(1) and W(2) == W(3) and W(1) > 0, "D9: every send point and the nine more web gates hooked",
      string.format("send points %d of %d, more gates %d of %d", W(0), W(1), W(2), W(3)))
    return "next"
  end)
end

local function prefix(expectHooks)
  step("the runtime's Lua functions", 5, function()
    local v = RVNG_Version()
    check(type(v) == "string" and v ~= "", "the native runtime answers", "version " .. tostring(v))
    return "next"
  end)
  step("the runtime's hooks", 90, function()
    local n = RVNG_Hooks()
    if n < 0 then return nil end                      -- (the install thread is still scanning)
    check(n == expectHooks, "the runtime hooked the game", string.format("%d of %d hooks", n, expectHooks))
    return "next"
  end)
  wallStep()
  step("the main menu", C.menu_timeout_s, function(e)
    if mainMenu() then
      check(true, "the main menu's map requested", string.format("%s, %d s into the step", RVNG_LastMap(), e))
      return "next"
    end
  end)
  wait("settling at the main menu", C.menu_wait_s)
  step("a picture of the main menu", 5, function() say("SHOT main_menu_20s"); return "next" end)
  wait("the main menu's rows", 20)
  step("a second picture of the main menu", 5, function() say("SHOT main_menu_40s"); return "next" end)
  step("offline at the main menu", 5, function()
    if prodMatch then
      check(RVNG_ProbeOn() == 0 and RVNG_MatchInfo(0) == 1 and RVNG_MatchInfo(2) == 0,
        "a normal install: test logger off, the match hooks in and idle (no match armed)",
        string.format("probe %d, match hooks %d, armed %d", RVNG_ProbeOn(), RVNG_MatchInfo(0), RVNG_MatchInfo(2)))
      return "next"
    end
    check(Probe.watched > 0 and Probe.offlineBad == 0, "offline at the main menu",
      string.format("%d watch samples, %d not offline", Probe.watched, Probe.offlineBad))
    return "next"
  end)
end

-- the deathmatch steps (test 2) --------------------------------------------------------------------------------------
local maxState, lastState, reqsAtEnd = -1, -1, nil
-- the main menu's cursor row (0 = top), read through the runtime the way a press reports it; -2 when no menu
local function menuRow()
  local okF, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
  for _, w in ipairs(okF and type(tops) == "table" and tops or {}) do
    local okA, a = pcall(function() return w:GetAddress() end)
    if okA and type(a) == "number" then
      local r = RVNG_MenuRow(a)
      if r >= 0 then return r end
    end
  end
  return -2
end
local resultFrames
local hookState = type(rawget(_G, "RVNG_LastState")) == "function" and RVNG_LastState or function() return -1 end
local SHOT_STATES = { [10] = "opening", [12] = "sync_start", [14] = "match_start", [15] = "time_up", [17] = "ending" }
local shotStates = {}
local function stateNow()
  local s = RVNG_State()
  -- (the hooks' last state too: 18 -> 19 and Ended's travel come in one frame, and the game mode is gone by the next
  -- tick: run of 2026-11-18 18:45)
  local h = hookState()
  if h > maxState then maxState = h end
  if s ~= lastState then
    if s >= 0 then info(string.format("game mode state %d", s)) else info("no online game mode") end
    lastState = s
    if SHOT_STATES[s] and not shotStates[s] then        -- (a picture the first time a key state is seen)
      shotStates[s] = true
      say(string.format("SHOT state_%02d_%s", s, SHOT_STATES[s]))
    end
  end
  if s > maxState then maxState = s end
  return s
end

local function travel()
  step("travel to the deathmatch", 5, function()
    local r = RVNG_TravelDM()
    if not check(r == 1, "the game's own mission-by-ID travel requested", "RVNG_TravelDM " .. tostring(r)) then return "abort" end
    return "next"
  end)
  step("the deathmatch map", 30, function()
    local m = RVNG_LastMap()
    if type(m) == "string" and m:find("PL_DM_", 1, true) then
      check(true, "RequestChangeMap to a deathmatch map", m)
      return "next"
    end
  end)
  step("the online game mode", 240, function()
    if stateNow() >= 1 then
      check(true, "the online game mode's state machine runs offline", "state " .. lastState)
      return "next"
    end
  end)
end

local function untilState(name, want, timeout)
  step(name, timeout, function(e)
    local s = stateNow()
    if s >= want then
      check(true, name, string.format("state %d after %d s", s, e))
      return "next"
    end
  end)
end

local function heldAt(want, s)
  step(string.format("held at %d for %d s", want, s), nil, function(e)
    local now = stateNow()
    if now ~= want then
      check(false, string.format("held at state %d", want), string.format("now %d after %d s", now, e))
      return "next"
    end
    if e >= s then
      check(true, string.format("held at state %d (as expected without RVNG's next change)", want), string.format("%d s", s))
      return "next"
    end
  end)
end

local function offlineThrough(what)
  step("offline " .. what, 5, function()
    if prodMatch then                                  -- (no test logger, so no flags watch: the prod suite's D9 checks)
      say(string.format("INFO offline %s: no flags watch in a normal install (D9 refused %d web API requests)", what,
        RVNG_WallInfo(4)))
      return "next"
    end
    check(Probe.offlineBad == 0, "offline " .. what, string.format("%d watch samples, %d not offline", Probe.watched, Probe.offlineBad))
    return "next"
  end)
end

-- ---- the suites ----------------------------------------------------------------------------------------------------
local suite = tostring(C.suite)
local lb = suite == "dm_l" or suite == "dm_l3" or suite == "dm_h" or suite == "dm_g" or suite == "dm_k" or suite == "dm_r" or
  suite == "dm_p"
local wire1 = suite == "dm_k" or suite == "dm_kx" or suite == "dm_r" or suite == "dm_p"
local readyUp = suite == "dm_r" or suite == "pvp" or suite == "dm_p"   -- the ready-up screen before the travel (rvng_ready.lua)
-- (dm_p's prodMatch: at the top)
local pvp = suite == "pvp"                            -- the two-PC test (wire 2: Steam to the other PC)
local opp = suite == "dm_s" or lb or pvp
local hooks = (C.hooks and tonumber(C.hooks)) or (prodMatch and 11) or (opp and 13) or 12
-- (0.4.1: the 2 web gates, D8's ReportCheat and the 8 match hooks every install has (the phaseIndex gate, SetState,
-- NextState, RequestChangeMap, Send, the slot pump, the score function, AuthoritativeApply), + the logger's menu
-- transition; the opponent suites (opponent=1): + the remote spawn's log hook)
-- the opponent's shown name in the match (the copy's name; production: the server's match, main.lua)
local OPP_NAME = pvp and "the other PC" or "the stand-in"
if opp and type(rawget(_G, "RVNG_OppName")) == "function" then RVNG_OppName(OPP_NAME) end
if suite == "smoke" then
  prefix(hooks)
elseif suite == "menu" then
  -- the main menu: ACE COMBAT STORE off, ACE COMBAT ONLINE turned into RVNG's COMPETITIVE 1V1 (rvng_menu.lua + the DLL's
  -- text and decide hooks, 0.2.8); the job presses it (KEYS, posted to the game's window)
  prefix(hooks)
  local Menu = package.loaded["rvng_menu"]
  step("the menu's rows", 60, function()
    if type(Menu) ~= "table" then check(false, "rvng_menu.lua is loaded"); return "abort" end
    if (Menu.removed.Shop or 0) > 0 and (Menu.repurposed > 0 or (Menu.removed.Online or 0) > 0) then
      check(Menu.repurposed > 0, "ACE COMBAT STORE off, ACE COMBAT ONLINE turned into MULTIPLAYER",
        string.format("row hooks %s, repurposed %d, Online removed %d, Shop removed %d, pinned %s", tostring(RVNG_MenuReady()),
          Menu.repurposed, Menu.removed.Online or 0, Menu.removed.Shop, tostring(Menu.pinned)))
      return "next"
    end
  end)
  step("the row's label", 30, function()
    if RVNG_MenuInfo(1) > 0 then
      check(true, "the row's texts answered by RVNG (COMPETITIVE 1V1)", RVNG_MenuInfo(1) .. " lookup(s)")
      return "next"
    end
  end)
  wait("the main menu's rows on screen", 5)
  step("a picture of the row", 5, function() say("SHOT menu_row"); return "next" end)
  step("press it", 5, function() say("KEYS down,down,enter"); return "next" end)
  -- (keys posted to an unfocused window don't reach the game's menu (run of 2026-11-19 02:08): a press seen here passes;
  -- none is only noted, and the press is checked by hand)
  step("the press taken", 20, function(e)
    if Menu.picks >= 1 then
      check(true, "COMPETITIVE 1V1 pressed: taken by RVNG, the queue requested",
        string.format("%d press(es); other rows passed on %d", Menu.picks, RVNG_MenuInfo(0)))
      return "next"
    end
    if e >= 18 then
      info(string.format("no press seen (posted keys don't reach an unfocused game; presses passed on %d): check by hand",
        RVNG_MenuInfo(0)))
      return "next"
    end
  end)
  wait("after the press", 3)
  step("a picture after the press", 5, function() say("SHOT menu_after_press"); return "next" end)
  wait("the main menu's rows on screen", 30)
  step("the rows still right", 5, function()
    local dt = StaticFindObject("/Game/Datatables/UI/Menu/MainMenu/Top/DT_LiveMenuMainTopCommands.DT_LiveMenuMainTopCommands")
    local okS, sh = pcall(function() return dt:FindRow("Shop") end)
    local okO, args = pcall(function() return dt:FindRow("Online").StringArgs:ToString() end)
    check(okS and sh == nil and okO and args == "RVNG_1v1", "STORE still off and COMPETITIVE 1V1 still in place",
      string.format("Online args %s", tostring(args)))
    return "next"
  end)
elseif suite == "stats" then
  -- the stats check (2026-11-21, docs/re/STATS.md): main.lua's own background read (rvng_stats.lua in 40 ms slices a
  -- second), its pass in runtime.json, the same fingerprints as a read in one go, and no slice holding the game long
  prefix(hooks)
  local Stats = require("rvng_stats")
  -- (2026-11-21: two launches gave different WeaponSettingsDataMap_ rows C.STORY and EASY: their whole texts logged)
  Stats.keepText = { WeaponSettingsDataMap_ = true }
  local S = rawget(_G, "RVNG_STATS_STATE")
  local t0
  step("the background read's first pass", 240, function(e)
    if type(S) ~= "table" then check(false, "main.lua's stats state (RVNG_STATS_STATE)"); return "abort" end
    t0 = t0 or e
    if S.passes >= 1 and S.last then
      local r = S.last
      check(r.groups.PlaneDataMap_.count > 30 and r.groups.PartsDataMap_.count > 100 and r.leaves > 300000,
        "a whole pass in the background: every plane's flight model, every part, every table",
        string.format("%d planes, %d parts, %d values; %d ms of CPU in %d slices over %d s; the longest slice %d ms",
          r.groups.PlaneDataMap_.count, r.groups.PartsDataMap_.count, r.leaves, r.ms, r.slices, e, r.maxSliceMs))
      check(r.maxSliceMs <= 150, "no slice held the game thread long", r.maxSliceMs .. " ms (budget 40 ms + one row)")
      local sk = {}
      for k, v in pairs(r.skipped) do sk[#sk + 1] = k .. " " .. v end
      table.sort(sk)
      info("stats: skipped (never read): " .. table.concat(sk, ", "))
      local via = {}
      for k, v in pairs(Stats.superVia or {}) do via[#via + 1] = k .. " " .. v end
      local loaded, absent = {}, {}
      for _, g in ipairs(Stats.GROUPS) do
        if g.path then
          local x = r.groups[g.name]
          if x.missing then absent[#absent + 1] = g.name else loaded[#loaded + 1] = g.name .. " " .. x.count end
        end
      end
      info("stats: parents found by " .. (#via > 0 and table.concat(via, ", ") or "nothing") .. "; DataTables read: "
        .. table.concat(loaded, ", ") .. "; not loaded: " .. (#absent > 0 and table.concat(absent, ", ") or "none"))
      local ws = r.texts and (r.texts["WeaponSettingsDataMap_/easy"] or "") or ""
      check(ws:find("damage=", 1, true) ~= nil, "a struct's parent fields read too (the weapon settings' damage)",
        ws:sub(1, 160))
      return "next"
    end
  end)
  step("runtime.json holds the pass", 10, function()
    local bridge = rawget(_G, "RVNG_BRIDGE") or "../../../ProjectRVNG/bridge/"
    local f = io.open(bridge .. "runtime.json", "r")
    local j = f and require("json").decode(f:read("a"))
    if f then f:close() end
    local st = j and j.stats
    check(type(st) == "table" and st.format == "rvng_stats_1" and st.groups.PlaneDataMap_.digest == S.last.groups.PlaneDataMap_.digest
      and st.groups.PartsDataMap_.digest == S.last.groups.PartsDataMap_.digest, "runtime.json holds the pass (for the companion)",
      st and string.format("planes %s, parts %s", st.groups.PlaneDataMap_.digest, st.groups.PartsDataMap_.digest) or "no stats in it")
    return "next"
  end)
  step("the same fingerprints read in one go", 60, function()
    local one = Stats.collect()
    local diff = {}
    for name, g in pairs(S.last.groups) do if not one or one.groups[name].digest ~= g.digest then diff[#diff + 1] = name end end
    table.sort(diff)
    check(one ~= nil and #diff == 0, "the sliced pass and a read in one go agree on every table",
      one and string.format("one go: %d ms; %s", one.ms, #diff > 0 and ("differ: " .. table.concat(diff, ",")) or "all 20 the same") or "no read")
    local gs = {}
    for _, g in ipairs(Stats.GROUPS) do
      local x = S.last.groups[g.name]
      gs[#gs + 1] = g.name .. " " .. (x.missing and "MISSING" or tostring(x.count)) .. " " .. x.digest
    end
    info("stats: " .. table.concat(gs, "; "))
    local keys = {}
    for k in pairs(S.last.texts or {}) do keys[#keys + 1] = k end
    table.sort(keys)
    for _, k in ipairs(keys) do info("stats text " .. k .. " " .. S.last.texts[k]) end
    if one and one.texts then
      for _, k in ipairs(keys) do
        if one.texts[k] ~= S.last.texts[k] then info("stats text (one go, differs) " .. k .. " " .. tostring(one.texts[k])) end
      end
    end
    return "next"
  end)
elseif suite == "stats_probe" then
  -- 2026-11-21, probe 2 (docs/re/STATS.md; probe 1 crashed reading a plane row's soft class pointer, crash 1): the field
  -- lists by reflection (no values), then rvng_stats.lua's whole read twice. A line is logged before every risky call.
  prefix(hooks)
  local Stats = require("rvng_stats")
  local function pc(f, ...) local ok, r = pcall(f, ...); if ok then return r end return nil, r end
  local function unwrap(v) local g = pc(function() return v:get() end); if g ~= nil then return g end return v end
  local function plist(label, sv)
    info("probe: about to list " .. label)
    local out, n = {}, 0
    local ok, e = pcall(function()
      sv:ForEachProperty(function(p)
        n = n + 1
        local nm = pc(function() return p:GetFName():ToString() end)
        local cls = pc(function() return p:GetClass():GetFName():ToString() end)
        local inner = cls == "ArrayProperty" and pc(function() return p:GetInner():GetClass():GetFName():ToString() end)
        out[#out + 1] = tostring(nm) .. ":" .. tostring(cls) .. (inner and ("<" .. inner .. ">") or "")
      end)
    end)
    info(string.format("probe: %s: %d fields (ok %s %s): %s", label, n, tostring(ok), tostring(e or ""),
      table.concat(out, " "):sub(1, 3500)))
  end
  local im
  step("probe: the information manager", 30, function()
    im = pc(FindFirstOf, "LiveInformationManager")
    local valid = im and pc(function() return im:IsValid() end)
    check(valid == true, "probe: the information manager found")
    return valid and "next" or "abort"
  end)
  local function firstOf(name)
    local fv
    pcall(function() im[name]:ForEach(function(_, v) if not fv then fv = unwrap(v) end end) end)
    return fv
  end
  step("probe: the field lists", 30, function()
    local part = firstOf("PartsDataMap_")
    if part then plist("a part (FLivePartsDataTable)", part) end
    local pd = part and unwrap(pc(function() return part.PartsData[1] end))
    if pd then plist("a part's PartsData[1] (FPartsData)", pd) end
    local plane = firstOf("PlaneDataMap_")
    if plane then plist("a plane (FPlayerPlaneDataTable)", plane) end
    info("probe: about to read the plane's PlayerParameter")
    local dt = plane and pc(function() return plane.PlayerParameter end)
    info("probe: about to read its row names")
    local names = dt and pc(function() return dt:GetRowNames() end)
    local list = {}
    for _, n in ipairs(type(names) == "table" and names or {}) do list[#list + 1] = tostring(pc(function() return n:ToString() end)) end
    info("probe: " .. tostring(pc(function() return dt:GetFullName() end)) .. " rows: " .. table.concat(list, ","))
    info("probe: about to FindRow " .. tostring(list[1]))
    local row = list[1] and unwrap(pc(function() return dt:FindRow(list[1]) end))
    if row then plist("its row (FLivePlayerParameterDataTable)", row) end
    info("probe: about to read LevelParameter")
    local lp = row and pc(function() return row.LevelParameter end)
    info("probe: LevelParameter count " .. tostring(lp and pc(function() return lp:GetArrayNum() end)))
    local l1 = lp and unwrap(pc(function() return lp[1] end))
    if l1 then plist("level 1 (FLivePlayerLevelParameter)", l1) end
    local fe = l1 and pc(function() return l1.FlightEnginePlayerParameter end)
    if fe then plist("its flight model (FAceFlightEnginePlayerParameter)", fe) end
    local sp = l1 and pc(function() return l1.SPWeaponInfo1 end)
    if sp then plist("its SPWeaponInfo1", sp) end
    local w = firstOf("WeaponDataMap_")
    if w then plist("a weapon (FPlayerWeaponDataTable)", w) end
    check(plane ~= nil and part ~= nil, "probe: field lists logged")
    return "next"
  end)
  local first
  step("probe: rvng_stats.lua's whole read", 60, function()
    info("probe: about to Stats.collect")
    Stats.trace = function(g) info("probe: reading " .. g) end
    local r, why = Stats.collect(im)
    Stats.trace = nil
    if not r then check(false, "Stats.collect", why); return "next" end
    first = r
    local gs = {}
    for _, g in ipairs(Stats.GROUPS) do
      local x = r.groups[g.name]
      gs[#gs + 1] = string.format("%s %s%d %s", g.name, x.missing and "MISSING " or "", x.count, x.digest)
    end
    info("probe: groups: " .. table.concat(gs, "; "))
    local sk = {}
    for k, v in pairs(r.skipped) do sk[#sk + 1] = k .. " " .. v end
    table.sort(sk)
    info(string.format("probe: %d values in %d ms; skipped: %s", r.leaves, r.ms, table.concat(sk, ", ")))
    local ps, np = {}, 0
    for id, h in pairs(r.planes) do
      np = np + 1
      if np <= 40 then ps[#ps + 1] = string.format("%s:%s/%s/%s/L%s", id, tostring(h.speedMax), tostring(h.speedStall), tostring(h.maxHealth), tostring(h.levels)) end
    end
    table.sort(ps)
    info("probe: planes (speedMax/speedStall/maxHealth/levels): " .. table.concat(ps, " "))
    local P, Q = r.groups.PlaneDataMap_, r.groups.PartsDataMap_
    check(P.count > 30 and Q.count > 100 and r.leaves > P.count * 300, "probe: every plane's flight model and every part read",
      string.format("%d planes, %d parts, %d values", P.count, Q.count, r.leaves))
    return "next"
  end)
  step("probe: the same read again", 60, function()
    local r = Stats.collect(im)
    local same, diff = 0, {}
    for name, g in pairs(first.groups) do
      if r and r.groups[name].digest == g.digest then same = same + 1 else diff[#diff + 1] = name end
    end
    check(#diff == 0, "probe: the fingerprints repeat exactly", same .. " tables the same" .. (#diff > 0 and ("; differ: " .. table.concat(diff, ",")) or ""))
    return "next"
  end)
elseif suite == "flags" then
  prefix(hooks)
  wait("watching at the main menu", C.watch_s)
  offlineThrough(string.format("for %d s more at the main menu", C.watch_s))
elseif suite == "dm_a" then
  prefix(hooks)
  travel()
  untilState("SyncStartMatch (12) reached", 12, 240)
  heldAt(12, 60)
  offlineThrough("through the deathmatch")
elseif suite == "dm_b" then
  prefix(hooks)
  travel()
  untilState("GamePlaying (14) reached through RVNG's start", 14, 240)
  wait("in flight", 10)
  step("a picture in flight", 5, function() say("SHOT in_flight_10s"); return "next" end)
  wait("in flight", 80)
  step("a picture in flight", 5, function() say("SHOT in_flight_90s"); return "next" end)
  untilState("time-up: GameTerminating (15) reached", 15, 330)
  heldAt(15, 30)
  offlineThrough("through the deathmatch")
elseif suite == "dm_c" or suite == "dm_f" or suite == "net_dm" or suite == "dm_stats" or opp then
  prefix(hooks)
  if readyUp then
    -- the ready-up screen: the row shows the opponent and both ready states; this PC readies (a press on the row; the
    -- job's keys don't reach an unfocused game, so the self-test presses for it); on one PC the stand-in peer readies
    -- with it; the host sends LAUNCH and both launch into the match at the agreed time, then the travel below runs
    -- RVNG's pages first (rvng_pages.lua): MULTIPLAYER > RANKED 1V1 > the LOBBY; the self-test presses for the pilot
    -- (Pages.press: the row the DLL would report), the queue is stood in for (no companion: the opponent comes at once)
    local Ready = package.loaded["rvng_ready"]
    local Pages = package.loaded["rvng_pages"]
    local launchedAt, sets0, answers0, queuedMode
    step("the MULTIPLAYER page", 15, function(e)
      if type(Pages) ~= "table" then check(false, "rvng_pages.lua is loaded"); return "abort" end
      if e == 0 then
        Pages.onQueue = function(mode) queuedMode = mode end
        Pages.openMultiplayer()
        return nil
      end
      if Pages.shown then
        local shown = Pages.screen() or "?"
        check(Pages.page == "multiplayer" and shown == "MULTIPLAYER | RANKED 1V1 | CASUAL 1V1 |  |  | BACK",
          "the MULTIPLAYER page on screen (RANKED 1V1, CASUAL 1V1, BACK)", shown)
        -- the game's cursor, read the way a press is (the row index from the game's own getter, 0 = the top row)
        local row = menuRow()
        check(row == 0, "the game's cursor on the page's first row (what a press would report: row 0)", "row " .. tostring(row))
        say("SHOT page_multiplayer")
        return "next"
      end
    end)
    wait("the MULTIPLAYER page", 3)
    step("RANKED 1V1", 10, function(e)
      if e == 0 then Pages.press(1); return nil end
      check(queuedMode == "ranked" and Pages.page == "lobby" and Pages.shown, "RANKED 1V1 queues ranked and opens the LOBBY",
        "mode " .. tostring(queuedMode) .. "; " .. tostring(Pages.screen()))
      check(Pages.frames > 0, "the pages written every frame too", Pages.frames .. " frames")
      local row = menuRow()
      check(row == 1, "the cursor moved to the LOBBY's second row (READY UP) by the menu's own SetSelectedIndex", "row " .. tostring(row))
      say("SHOT page_lobby_searching")
      return "next"
    end)
    wait("the lobby", 3)
    step("the ready-up screen", 120, function(e)
      if type(Ready) ~= "table" then check(false, "rvng_ready.lua is loaded"); return "abort" end
      if e == 0 then
        Ready.onLaunch = function() launchedAt = os.time() end
        sets0, answers0 = RVNG_ReadyInfo(8), RVNG_MenuInfo(1)
        Ready.begin(pvp and "the other PC" or "the stand-in")
      end
      if RVNG_ReadyInfo(0) == 2 and Ready.phase == "ready" then
        check(true, "the ready-up screen: the link to the opponent up", string.format("%d s; row: %s", e, tostring(Ready.lastTitle)))
        return "next"
      end
    end)
    step("a picture of the ready-up screen", 5, function() say("SHOT ready_up_0of2"); return "next" end)
    wait("the ready-up screen", 3)
    step("ready", 10, function()
      Pages.press(2)
      check(RVNG_ReadyInfo(2) == 1, "this pilot ready (READY UP on the LOBBY page)")
      return "next"
    end)
    step("the launch agreed", 60, function(e)
      if RVNG_ReadyInfo(5) ~= 0 and RVNG_ReadyInfo(6) >= 0 then
        check(RVNG_ReadyInfo(3) == 1, "both pilots ready: the host's LAUNCH set on this PC",
          string.format("%d s; %d ms to the launch; row: %s", e, RVNG_ReadyInfo(6), tostring(Ready.lastTitle)))
        check(Pages.shown == true and Pages.page == "lobby", "the LOBBY shown in the main menu's own header, rows and description",
          tostring(Pages.screen()))
        say("SHOT ready_up_countdown")
        return "next"
      end
    end)
    step("the launch", 15, function(e)
      if launchedAt then
        check(Ready.phase == "launched", "launched into the match at the agreed time", string.format("%d s into the countdown", e))
        check(Ready.phase == "launched" and Pages.page == "main", "the pages stepped aside for the travel",
          string.format("the game read the row's texts %d times meanwhile", RVNG_MenuInfo(1) - answers0))
        return "next"
      end
    end)
  end
  if suite == "dm_stats" then
    -- (the stats check's in-match pass reads the tables the menu pass found not loaded: the menu pass first)
    step("the stats check's menu pass before the travel", 150, function(e)
      local S = rawget(_G, "RVNG_STATS_STATE")
      if type(S) == "table" and S.last then
        local absent = {}
        for name, g in pairs(S.last.groups) do if g.missing and g.optional then absent[#absent + 1] = name end end
        table.sort(absent)
        check(true, "the menu pass done before the travel", string.format("%d s; not loaded at the menu: %s", e, table.concat(absent, ", ")))
        return "next"
      end
    end)
  end
  travel()
  if prodMatch then
    step("the match armed", 5, function()
      check(RVNG_MatchInfo(2) == 1 and RVNG_ProbeOn() == 0, "a normal install's own launch armed the match (no test logger)",
        string.format("armed %d, probe %d, wire %d", RVNG_MatchInfo(2), RVNG_ProbeOn(), RVNG_WireInfo(0)))
      return "next"
    end)
  end
  if opp then
    -- test 3 (opponent=1): the room tables get a fake second member before state 3; state 4's remote loop spawns its copy
    step("the room tables filled", 60, function()
      if RVNG_OppInfo(0) == 1 then
        check(true, "test 3: the room tables filled with a second member (RVNG_TEST_2)")
        if type(rawget(_G, "RVNG_OppShown")) == "function" then
          local shown = RVNG_OppShown()
          check(shown == OPP_NAME, "the opponent's name in the game's own selector (RVNG_OppName; the user id stays RVNG_TEST_2)",
            tostring(shown))
        end
        return "next"
      end
    end)
  end
  if suite == "dm_f" then
    -- test 6 (faction=2): the local user's NM+0x4d0 entry written as BRAVO1 right after the travel's prepare step
    step("the faction entry written", 30, function()
      if RVNG_FacInfo(0) >= 1 then
        check(true, "test 6: the local user's faction entry written (Bravo)", string.format("%d write(s)", RVNG_FacInfo(0)))
        return "next"
      end
    end)
  end
  if pvp then
    -- the two-PC test: the link to the other PC must be up before the start gate can open on both
    step("the link to the other PC", 180, function(e)
      local W, L = RVNG_WireInfo, RVNG_LinkInfo
      if W(1) == 2 then
        check(L(19) == 1, "the link is relay-only (no direct connection, no IP addresses)")
        check(true, "the link to the other PC is up (Steam, relay-only)",
          string.format("player %d; %d s; clock offset %d ms, round trip %d ms", L(1), e, L(3), L(4)))
        return "next"
      end
      if e >= 179 then check(false, "the link to the other PC is up", string.format("state %d, relay %d", W(1), L(20))) end
    end)
  end
  untilState("GamePlaying (14) reached through RVNG's start", 14, 240)
  if pvp then
    step("the start agreed", 5, function()
      local W, L = RVNG_WireInfo, RVNG_LinkInfo
      check(W(7) == 1, "D2's start gate opened at the GO time the two PCs agreed on",
        string.format("GO state %d; clock offset %d ms, round trip %d ms, %d samples", L(8), L(3), L(4), L(5)))
      if L(1) == 2 then
        check(W(12) ~= -1, "this PC (the guest) runs the host's game clock (c[0x20] set, as RealTime does online)",
          string.format("%d ms added", W(12)))
      end
      return "next"
    end)
    wait("both planes flying", 60)
    step("a picture of the other PC's plane", 5, function() say("SHOT pvp_60s"); return "next" end)
    step("each plane flown by its own PC", 5, function()
      local W = RVNG_WireInfo
      check(W(3) >= 300 and W(10) == 0, "this PC's messages sent to the other PC", string.format("%d sent, %d send failures", W(3), W(10)))
      check(W(4) >= 300 and W(5) >= W(4) - W(6) - 5 and W(11) == 0,
        "the other PC's messages received and routed into this game (D1's receive rule)",
        string.format("%d received, %d routed, %d dropped by the rule, %d bad", W(4), W(5), W(6), W(11)))
      check(RVNG_LbInfo(6) >= 1000, "the other PC's plane moves here (its copy, flown by its own Physics)", RVNG_LbInfo(6) .. " m")
      return "next"
    end)
  end
  if opp then
    step("the opponent's copy", 5, function()
      if not prodMatch then                          -- (the remote spawn's log hook is the test logger's)
        check(RVNG_OppInfo(1) == 1 and RVNG_OppInfo(2) == 1, "test 3: the game's remote spawn ran once, for slot 1",
          string.format("%d call(s), last slot %d", RVNG_OppInfo(1), RVNG_OppInfo(2)))
      end
      check(RVNG_OppInfo(3) == 2, "test 3: two planes in the match", string.format("%d plane(s)", RVNG_OppInfo(3)))
      local copyId = suite == "dm_g" and 1 or 2               -- (dm_g: this PC is the guest, the copy the host)
      check(RVNG_OppInfo(4) == 2 and RVNG_OppInfo(5) == copyId, "test 3: the copy is role 2 with the peer's netId",
        string.format("role %d, netId %d", RVNG_OppInfo(4), RVNG_OppInfo(5)))
      return "next"
    end)
  end
  if lb then
    -- test 4 (loopback=1; dm_l3: test 5, the local plane role 3 and the game refreshing its Physics itself): the local plane's Physics messages, through RVNG's Send, the game's MessagePack code and its
    -- router, fly the copy 150 m ahead of the local plane
    step("the mirror armed", 20, function()
      if RVNG_LbInfo(0) == 1 then check(true, "test 4: both planes registered, the loopback mirror armed"); return "next" end
    end)
    wait("the mirror flying", 15)
    step("a picture of the mirror", 5, function() say("SHOT mirror_15s"); return "next" end)
    wait("the mirror flying", 5)
    step("the mirror flies", 5, function()
      local cap, inj, app = RVNG_LbInfo(2), RVNG_LbInfo(3), RVNG_LbInfo(4)
      check(cap >= 100 and RVNG_LbInfo(7) == 0, "test 4: the local plane's Physics captured at Send and encoded",
        string.format("%d captured, %d sends in all, %d encode/decode failures", cap, RVNG_LbInfo(1), RVNG_LbInfo(7)))
      check(inj >= cap - 5 and app >= inj - 5, "test 4: decoded, re-keyed and delivered to the copy by the game's router",
        string.format("%d injected, %d applied", inj, app))
      check(RVNG_LbInfo(6) >= 1000, "test 4: the copy flies (moved from its start)", RVNG_LbInfo(6) .. " m")
      check(RVNG_LbInfo(5) >= 0 and RVNG_LbInfo(5) <= 300, "test 4: the copy keeps to the mirror point",
        RVNG_LbInfo(5) .. " m off")
      check(RVNG_LbInfo(8) >= 0 and RVNG_LbInfo(8) <= 200, "the game's synced clock, read by RVNG, matches the Physics TriggerTimes",
        "largest difference " .. RVNG_LbInfo(8) .. " ms")
      if wire1 then
        -- the link (link.h) carried it: this PC's link A sent DATA, the stand-in peer's link B received it
        local W = RVNG_WireInfo
        check(W(0) == 1 and W(1) == 2 and W(2) == 2, "wire 1: both links of the pair up", string.format("A %d, B %d", W(1), W(2)))
        check(W(7) == 1 and W(8) == 2, "wire 1: D2's start gate opened at the GO time the host link sent and the peer acknowledged",
          string.format("released %d, GO state %d", W(7), W(8)))
        check(W(3) >= 100 and W(4) >= W(3) - 5 and W(5) >= W(4) - 5 and W(10) == 0 and W(11) == 0,
          "wire 1: the game's messages through the link: sent, received, mirrored, none lost or bad",
          string.format("%d sent, %d received, %d mirrored, %d send failures, %d bad", W(3), W(4), W(5), W(10), W(11)))
      end
      return "next"
    end)
  end
  if suite == "dm_h" then
    -- test 7 (hit=1): the local plane (role 3, the host) hits the copy through the copy's own TakeDamage: 30 %, then a
    -- lethal hit, then the copy is respawned through its own respawn slot (the DLL runs it 20 s after the mirror is armed)
    step("the lethal hit", 60, function()
      if RVNG_HitInfo(0) >= 3 then say("SHOT copy_killed"); return "next" end
    end)
    step("the hits", 30, function()
      if RVNG_HitInfo(0) < 5 then return nil end
      local i = function(k) return RVNG_HitInfo(k) end
      check(i(1) > 0 and i(4) < i(3), "test 7: the copy took the hit through the game's own TakeDamage (role 3 on role 2)",
        string.format("returned %d, health %d -> %d (x10)", i(1), i(3), i(4)))
      check(i(8) > i(7), "test 7: the score function ran for the attacker", string.format("score %d -> %d (x10)", i(7), i(8)))
      check(i(10) >= 2 and i(11) >= 1, "test 7: Damage results and ScoreAddition reached RVNG's Send",
        string.format("%d Damage, %d ScoreAddition", i(10), i(11)))
      check(i(5) == 0 and i(9) > i(8), "test 7: the lethal hit killed the copy and scored",
        string.format("health %d, score %d (x10)", i(5), i(9)))
      check(i(6) > 0, "test 7: the copy respawned through its own respawn slot", string.format("health %d (x10)", i(6)))
      return "next"
    end)
    -- 7b: the guest's hit on the host, as the DamageClient the guest's D3 will send, injected through the router as
    -- player 2: the host's own DamageClient handler applies it to the local plane and scores it for the copy
    step("the guest's hit on the host (7b)", 20, function()
      if RVNG_HitInfo(0) < 7 then return nil end
      local i = function(k) return RVNG_HitInfo(k) end
      say("SHOT local_hit")
      check(i(12) == 1, "test 7b: a DamageClient built, encoded, decoded and injected as player 2")
      check(i(14) >= 0 and i(14) < i(13), "test 7b: the host's DamageClient handler applied it to the local plane",
        string.format("health %d -> %d (x10)", i(13), i(14)))
      check(i(16) > i(15), "test 7b: and scored it for the attacker (the copy)", string.format("score %d -> %d (x10)", i(15), i(16)))
      check(i(10) >= 3, "test 7b: the host broadcast its Damage result", string.format("%d Damage messages", i(10)))
      return "next"
    end)
    -- the host's ScoreUpdate: built after every score run; one, keyed to the copy, applied by the game's own handler
    step("the host's ScoreUpdate", 15, function()
      if RVNG_HitInfo(0) < 9 then return nil end
      local i = function(k) return RVNG_HitInfo(k) end
      check(i(21) >= 3, "ScoreUpdate: built by the host after each score run", i(21) .. " built")
      check(i(22) == 1 and i(24) == i(23) and i(23) > 0, "ScoreUpdate: the game's handler set the copy's score to the sent one",
        string.format("%d bytes; local %d, copy %d (x10)", i(25), i(23), i(24)))
      return "next"
    end)
    -- death and respawn relayed: the local plane crashes (type 7); its DestroyedLocation and, after the game's auto
    -- sortie, its Respawn go through the loopback to the copy
    step("the local crash", 20, function()
      if RVNG_HitInfo(0) >= 10 then say("SHOT local_crash"); return "next" end
    end)
    step("death and respawn relayed", 50, function()
      if RVNG_HitInfo(0) < 12 then return nil end
      local i = function(k) return RVNG_HitInfo(k) end
      say("SHOT after_respawn")
      check(i(28) == 0, "the local plane crashed and died (type 7, no attacker)", string.format("health %d (x10)", i(28)))
      check(i(26) >= 1 and i(29) == 1, "its DestroyedLocation, mirrored to the copy, marked the copy destroyed",
        string.format("%d mirrored, copy +0x3c2e %d", i(26), i(29)))
      check(i(31) > 0 and i(27) >= 1 and i(30) > 0, "after the game's auto sortie its Respawn, mirrored, brought the copy back",
        string.format("local health %d, %d Respawn mirrored, copy health %d (x10)", i(31), i(27), i(30)))
      return "next"
    end)
  end
  if suite == "dm_g" then
    -- D3 / D4 (guest=1): this PC is the guest (player 2, Bravo); the copy is the host's plane (2/1). The guest's hits on it
    -- become DamageClients (D3), handed here to this PC's own DamageClient handler standing in for the host; the guest's
    -- score function never runs (D4)
    step("the lethal hit", 60, function()
      if RVNG_HitInfo(0) >= 3 then say("SHOT guest_kill"); return "next" end
    end)
    step("the hits", 30, function()
      if RVNG_HitInfo(0) < 5 then return nil end
      local i = function(k) return RVNG_HitInfo(k) end
      check(i(17) >= 2 and i(20) >= 2, "D3: the guest's hits on the host's plane became DamageClients for the host",
        string.format("%d taken, %d delivered, %d swallowed", i(17), i(20), i(18)))
      check(i(4) < i(3), "D3: the host's handler (standing in) applied the first hit", string.format("health %d -> %d (x10)", i(3), i(4)))
      check(i(19) >= 1 and i(8) == i(7) and i(9) == i(7), "D4: the guest's score function never ran, its score did not move",
        string.format("%d blocked, score %d -> %d -> %d (x10)", i(19), i(7), i(8), i(9)))
      check(i(10) >= 2, "D3: the host's Damage results were broadcast", string.format("%d Damage messages", i(10)))
      check(i(5) == 0, "D3: the lethal hit, through the host, killed the host's plane", string.format("health %d (x10)", i(5)))
      check(i(6) > 0, "the host's plane respawned through its own respawn slot", string.format("health %d (x10)", i(6)))
      return "next"
    end)
  end
  if suite == "dm_f" then
    step("the local plane's faction", 5, function()
      check(RVNG_FacInfo(1) == 2, "test 6: the local plane is Bravo (plane+0x3b2)", "faction " .. RVNG_FacInfo(1))
      check(RVNG_FacInfo(2) == 2, "test 6: it started at a Bravo start point",
        string.format("nearest start point's faction %d, %d m away", RVNG_FacInfo(2), RVNG_FacInfo(3)))
      return "next"
    end)
  end
  wait("in flight", 10)
  step("a picture in flight", 5, function() say("SHOT in_flight_10s"); return "next" end)
  wait("in flight", 80)
  step("a picture in flight", 5, function() say("SHOT in_flight_90s"); return "next" end)
  untilState("time-up: GameTerminating (15) reached", 15, 330)
  if suite == "dm_stats" then
    step("the stats check's in-match pass", 20, function(e)
      local S = rawget(_G, "RVNG_STATS_STATE")
      if not (type(S) == "table" and S.match) then
        if e < 18 then return nil end
        check(false, "the in-match pass finished during the match", type(S) == "table" and S.matchJob and "still reading" or "never started")
        return "next"
      end
      local read, absent = {}, {}
      for name, g in pairs(S.match.groups) do
        if g.missing then absent[#absent + 1] = name else read[#read + 1] = name .. " " .. g.count end
      end
      table.sort(read); table.sort(absent)
      check(#read > 0, "the in-match pass read the tables the match loaded",
        string.format("read: %s; still not loaded: %s; %d ms of CPU in %d slices, the longest %d ms", table.concat(read, ", "),
          #absent > 0 and table.concat(absent, ", ") or "none", S.match.ms, S.match.slices, S.match.maxSliceMs))
      check(S.match.maxSliceMs <= 40, "no in-match slice held the game long", S.match.maxSliceMs .. " ms (budget 5 ms + one row)")
      local bridge = rawget(_G, "RVNG_BRIDGE") or "../../../ProjectRVNG/bridge/"
      local f = io.open(bridge .. "runtime_match.json", "r")
      check(f ~= nil, "runtime_match.json written (the baseline's match capture)")
      if f then f:close() end
      return "next"
    end)
  end
  -- the match's stats for the leaderboard (0.4.4, matchstats.h): its length, how it ended, and with the crash (dm_h,
  -- dm_g) this pilot's death and its relayed copy
  -- (only with an opponent: the result (ResultCapture) needs both planes, so a suite without one (dm_c, dm_f, net_dm,
  -- dm_stats) has no match stats to check: run 20261121_190250)
  if type(rawget(_G, "RVNG_MatchStat")) == "function" and not opp then
    step("the match's stats (for the leaderboard)", 5, function()
      info(string.format("no opponent in this suite: no result to count (%d match(es) with stats)", RVNG_MatchStat(0)))
      return "next"
    end)
  elseif type(rawget(_G, "RVNG_MatchStat")) == "function" then
    step("the match's stats (for the leaderboard)", 10, function(e)
      if RVNG_MatchStat(0) < 1 and e < 8 then return nil end
      check(RVNG_MatchStat(0) >= 1 and RVNG_MatchStat(3) >= 150 and RVNG_MatchStat(4) == 0,
        "the match's stats: its length from GamePlaying, ended by time-up",
        string.format("%d match(es), %d s, end %d; deaths: this pilot %d, the opponent %d, %d event(s)", RVNG_MatchStat(0),
          RVNG_MatchStat(3), RVNG_MatchStat(4), RVNG_MatchStat(1), RVNG_MatchStat(2), RVNG_MatchStat(5)))
      if suite == "dm_h" or suite == "dm_g" then
        check(RVNG_MatchStat(1) >= 1 and RVNG_MatchStat(2) >= 1 and RVNG_MatchEvent(0) ~= "",
          "the crash counted: this pilot's death (its DestroyedLocation sent) and the copy's (relayed)",
          string.format("%d / %d, first event %s", RVNG_MatchStat(1), RVNG_MatchStat(2), tostring(RVNG_MatchEvent(0))))
      end
      return "next"
    end)
  end
  step("note the map requests", 5, function() reqsAtEnd = RVNG_MapReqs(); return "next" end)
  step("Ended (19) reached", 180, function(e)
    stateNow()
    if maxState >= 19 then
      check(true, "Ended (19) reached through W1", string.format("%d s after 15", e))
      return "next"
    end
  end)
  -- D6: Ended's travel to the online Result map crashes offline (run of 2026-11-18 18:35), so it goes to the main menu
  step("the travel after Ended", 60, function()
    stateNow()
    if reqsAtEnd and RVNG_MapReqs() > reqsAtEnd then
      local m = RVNG_LastMap()
      check(m:find("PL_MainMenu", 1, true) ~= nil, "D6: after Ended the game goes to the main menu, not the Result map", m)
      return "next"
    end
  end)
  -- D8 (0.3.5): the game's own cheat reports are switched off at the source. In the loopback suites RVNG's Send sees
  -- every message, so no Cheat may reach it; dm_l and dm_l3 fly out of the combat zone, so the combat-zone check
  -- (type 9) must have reported and been switched off
  step("the game's cheat reports (D8)", 5, function()
    local off, t9, sent = RVNG_CheatInfo(10), RVNG_CheatInfo(9), RVNG_CheatInfo(13)
    check(RVNG_CheatInfo(12) == 1, "D8: the game's ReportCheat hooked",
      string.format("%d reports switched off, %d of type 1 left to the game", off, RVNG_CheatInfo(11)))
    if lb then
      check(sent == 0, "D8: no Cheat message reached Send", string.format("%d Cheat sent", sent))
    end
    if suite == "dm_l" or suite == "dm_l3" then
      check(off >= 1 and t9 >= 1, "D8: the combat-zone check's reports switched off at the source",
        string.format("%d switched off, %d of them combat zone (type 9)", off, t9))
    end
    return "next"
  end)
  if readyUp then
    step("the result screen", 40, function(e)
      local Ready = package.loaded["rvng_ready"]
      local Pages = package.loaded["rvng_pages"]
      if Ready.phase == "result" and Pages.page == "result" and Pages.shown then
        check(true, "the result page in the main menu after the match", string.format("%d s; %s", e, tostring(Pages.screen())))
        resultFrames = Pages.frames
        return "next"
      end
      if e >= 39 then check(false, "the result page in the main menu after the match", "phase " .. tostring(Ready.phase)) end
    end)
  end
  if readyUp then
    wait("the result page", 2)
    step("a picture of the result page", 5, function()
      local Pages = package.loaded["rvng_pages"]
      local h = Pages.helpText() or "?"
      -- which text widgets show the description now (the one drawn may not be the one RVNG writes). Only text widget
      -- classes are asked (calling GetText on every UObject crashed the game, run of 18:26)
      for _, cls in ipairs({ "LiveLocalizeTextBlock", "TextBlock", "LiveNUITextBlock", "RichTextBlock", "LiveNUIRichTextBlock" }) do
        local okF, all = pcall(FindAllOf, cls)
        for _, o in ipairs(okF and type(all) == "table" and all or {}) do
          local okT, t = pcall(function() return o:GetText():ToString() end)
          if okT and type(t) == "string" and (t:find("storyline", 1, true) or t:find("Final score", 1, true)) then
            local okN, n = pcall(function() return o:GetFullName() end)
            local okV, vis = pcall(function() return o:GetVisibility() end)
            say(string.format("INFO description text (%s) \"%s\" vis %s: %s", cls, t:sub(1, 30), tostring(okV and vis), okN and n or "?"))
          end
        end
      end
      check(h:find("Final score", 1, true) ~= nil, "the result page's description held (the game's own for the row under the cursor is written over)", h)
      check(Pages.frames > (resultFrames or 0), "the pages still written every frame after the match",
        string.format("%d frames since the result page opened", Pages.frames - (resultFrames or 0)))
      say("SHOT result_screen")
      return "next"
    end)
  end
  wait("at the main menu after the match", 10)
  step("a picture of the main menu after the match", 5, function() say("SHOT main_menu_after_match_10s"); return "next" end)
  wait("at the main menu after the match", 20)
  step("still running after the match", 5, function()
    check(true, "the game runs on at the main menu after the match", "30 s")
    say("SHOT main_menu_after_match_30s")            -- (job.py captures the game's window)
    return "next"
  end)
  wait("the picture", 3)
  if opp then
    step("the room tables emptied", 30, function()
      if RVNG_OppInfo(6) == 1 then
        check(RVNG_OppInfo(7) == 0, "test 3: the room tables emptied after the match", string.format("%d left", RVNG_OppInfo(7)))
        return "next"
      end
    end)
  end
  if prodMatch then
    step("the match disarmed", 30, function(e)
      if RVNG_MatchInfo(2) == 0 then
        check(RVNG_WireInfo(0) == 1, "the match disarmed after the travel back: the match hooks idle again",
          string.format("%d s into the step; wire %d (the rehearsal's pair)", e, RVNG_WireInfo(0)))
        return "next"
      end
      if e >= 29 then check(false, "the match disarmed after the travel back", "still armed") end
    end)
  end
  offlineThrough("through the deathmatch and back")
elseif suite == "dm_x" or suite == "dm_kx" then
  -- the lost link (linkloss=120): 120 s into GamePlaying RVNG ends the match as Bandai's server would on a lost peer
  -- (the game mode's forced end, Finished: >= 105 s played); the end then runs as usual: W1, Ended, D6, the main menu
  prefix(hooks)
  travel()
  untilState("GamePlaying (14) reached through RVNG's start", 14, 240)
  step("the lost link", 150, function()
    if RVNG_LinkLoss(0) == 1 then
      if wire1 then
        check(RVNG_WireInfo(9) == 1 and RVNG_WireInfo(1) == 3, "wire 1: the wire was cut and the link found itself lost",
          string.format("cut %d, link state %d (3 lost)", RVNG_WireInfo(9), RVNG_WireInfo(1)))
        check(RVNG_WireInfo(7) == 1, "wire 1: the match had started at the link's GO time")
      end
      check(RVNG_LinkLoss(1) == 2 and RVNG_LinkLoss(2) == 4, "the lost link: the game mode's forced end, Finished",
        string.format("at %d s; +0x804 %d (2 Finished), +0x538 %d (4 forced)", RVNG_LinkLoss(3), RVNG_LinkLoss(1), RVNG_LinkLoss(2)))
      return "next"
    end
  end)
  untilState("GameTerminating (15) reached through the forced end, before time-up", 15, 30)
  step("note the map requests", 5, function() reqsAtEnd = RVNG_MapReqs(); return "next" end)
  step("Ended (19) reached", 180, function(e)
    stateNow()
    if maxState >= 19 then check(true, "Ended (19) reached through W1 after the forced end", string.format("%d s after 15", e)); return "next" end
  end)
  step("the travel after Ended", 60, function()
    stateNow()
    if reqsAtEnd and RVNG_MapReqs() > reqsAtEnd then
      local m = RVNG_LastMap()
      check(m:find("PL_MainMenu", 1, true) ~= nil, "D6: after the forced end the game goes to the main menu", m)
      return "next"
    end
  end)
  wait("at the main menu after the match", 10)
  step("a picture of the main menu after the match", 5, function() say("SHOT main_menu_after_lost_link"); return "next" end)
  offlineThrough("through the deathmatch and back")
elseif suite == "prod" or suite == "net" or suite == "link" or suite == "ui_scan" or suite == "ui_pages" then
  -- a normal install (probe=0, 0.2.4): only the always-on half runs. The web gates are hooked and answer false, the boot
  -- login they refuse is ended (D7, through rvng_native.lua's RVNG_Tick), the main menu shows its rows without ACE COMBAT
  -- ONLINE and ACE COMBAT STORE, and no gate is asked again afterwards. (No map log without the logger: the boot login's
  -- end marks the main menu.)
  local Native = package.loaded["rvng_native"]
  local gatesAt
  step("the runtime's Lua functions", 5, function()
    check(type(RVNG_Version()) == "string" and RVNG_ProbeOn() == 0, "the native runtime answers, test logger off",
      "version " .. tostring(RVNG_Version()) .. ", probe " .. tostring(RVNG_ProbeOn()))
    return "next"
  end)
  step("the runtime's hooks", 90, function()
    local n = RVNG_Hooks()
    if n < 0 then return nil end
    check(n == 11, "the always-on hooks: the two web gates (always answer false), D8 (cheat reports off) and the 8 match hooks",
      string.format("%d hooks, ReportCheat %s", n, RVNG_CheatInfo(12) == 1 and "hooked" or "NOT hooked"))
    if type(rawget(_G, "RVNG_MatchInfo")) == "function" then
      check(RVNG_MatchInfo(0) == 1 and RVNG_MatchInfo(1) == 1 and RVNG_MatchInfo(2) == 0,
        "the match hooks all in (the guest's D3/D4 too), no match armed: they pass the game's calls on",
        string.format("all %d, guest %d, armed %d", RVNG_MatchInfo(0), RVNG_MatchInfo(1), RVNG_MatchInfo(2)))
    end
    return "next"
  end)
  wallStep()
  step("the boot login ended (D7)", C.menu_timeout_s, function(e)
    if type(Native) ~= "table" then check(false, "rvng_native.lua is loaded"); return "abort" end
    if Native.ended >= 1 then
      check(true, "the refused boot login ended through the game's own failure exit",
        string.format("%d s into the step, %d tick(s), %d gate call(s)", e, Native.ticks, RVNG_GateCalls()))
      gatesAt = RVNG_GateCalls()
      return "next"
    end
  end)
  wait("settling at the main menu", C.menu_wait_s)
  step("a picture of the main menu", 5, function() say("SHOT prod_main_menu_20s"); return "next" end)
  wait("the main menu's rows", 20)
  step("a second picture of the main menu", 5, function() say("SHOT prod_main_menu_40s"); return "next" end)
  step("the menu's rows", 30, function()
    local Menu = package.loaded["rvng_menu"]
    if type(Menu) == "table" and (Menu.removed.Shop or 0) > 0 and ((Menu.repurposed or 0) > 0 or (Menu.removed.Online or 0) > 0) then
      check((Menu.repurposed or 0) > 0, "ACE COMBAT STORE off, ACE COMBAT ONLINE turned into MULTIPLAYER")
      return "next"
    end
  end)
  wait("at the main menu", 30)
  step("no gate asked again", 5, function()
    check(RVNG_GateCalls() == gatesAt, "no web gate asked again after the login ended",
      string.format("%d then %d", gatesAt or -1, RVNG_GateCalls()))
    return "next"
  end)
elseif suite == "hangar_p" then
  -- RVNG's lobby in the hangar, on one PC (2026-11-21, runtime 0.4.3, rvng_hangar.lua + lobby.h; docs/re/HANGAR.md):
  -- a normal install (probe=0) with rehearse=1 (the in-process link pair: a stand-in opponent who readies with this PC
  -- and flies an F-14A). RVNG's pages, RANKED 1V1, the match found: both into the hangar (Mission014: one wingman spot),
  -- the walk to STANDBY, the lobby there (READY UP, SORTIE locked, the opponent's plane on the wingman's spot, this
  -- pilot's loadout sent), SORTIE refused before both are ready, READY UP, SORTIE, the synced launch, the travel into the
  -- deathmatch, the opponent's copy in its own plane (the F-14A)
  local Native = package.loaded["rvng_native"]
  local Pages = package.loaded["rvng_pages"]
  local Hangar = package.loaded["rvng_hangar"]
  local Ready = package.loaded["rvng_ready"]
  local shots, launchedAt = 0, nil
  local function shot(name)
    shots = shots + 1
    say(string.format("SHOT hp_%02d_%s", shots, name))
  end
  local function standbyPage()
    local a, name = Hangar.pageNow()
    if name == "WBP_Menu_Hangar_StandbySetting_000_C" then return a end
  end
  local function standbyRows(a)
    local t = {}
    for i = 0, (RVNG_PageRows(a) or 0) - 1 do
      local s = RVNG_PageRow(a, i) or ""
      t[#t + 1] = s:match("^[^|]*|([^|]*)|") or "?"
    end
    return t
  end
  step("the runtime's Lua functions", 5, function()
    check(type(RVNG_Version()) == "string" and RVNG_ProbeOn() == 0, "the native runtime answers, test logger off",
      "version " .. tostring(RVNG_Version()) .. ", probe " .. tostring(RVNG_ProbeOn()))
    check(type(Hangar) == "table" and type(Pages) == "table" and type(Ready) == "table", "rvng_hangar, rvng_pages, rvng_ready loaded")
    if type(Hangar) ~= "table" then return "abort" end
    return "next"
  end)
  step("the runtime's hooks", 90, function()
    local n = RVNG_Hooks()
    if n < 0 then return nil end
    check(n == 11 and RVNG_HgInfo(0) == 8, "a normal install's 11 hooks, and the hangar lobby's 8 (idle until a match opens the hangar)",
      string.format("%d hooks, %d of the lobby's", n, RVNG_HgInfo(0)))
    return "next"
  end)
  wallStep()
  step("the boot login ended (D7)", C.menu_timeout_s, function(e)
    if type(Native) ~= "table" then check(false, "rvng_native.lua is loaded"); return "abort" end
    if Native.ended >= 1 then check(true, "the boot login ended", string.format("%d s into the step", e)); return "next" end
  end)
  wait("settling at the main menu", 15)
  step("MULTIPLAYER", 10, function(e)
    if e == 0 then
      Pages.onQueue = function() end
      Pages.onCancel = function() end
      Pages.openMultiplayer()
      return nil
    end
    if e < 2 then return nil end
    shot("multiplayer")
    return "next"
  end)
  step("RANKED 1V1", 10, function(e)
    if e == 0 then Pages.press(1); return nil end
    if e < 2 then return nil end
    check(Pages.page == "lobby", "RANKED 1V1 opens the LOBBY (SEARCHING)", tostring(Pages.screen()))
    shot("lobby_searching")
    return "next"
  end)
  step("the match found: into the hangar", 10, function()
    -- (as main.lua's onLink: the link started (here the in-process pair), the ready-up begun, the hangar opened)
    Ready.onLaunch = function()
      launchedAt = os.time()
      Hangar.stop()                                   -- (first: the hangar's mission context back, then the travel)
      RVNG_TravelDM()
    end
    Pages.onLeave = function() end
    Hangar.onStart = function() Pages.stepAside() end
    Hangar.onLeave = function() Ready.reset(); Pages.backFromHangar() end   -- (as main.lua)
    Ready.begin("the stand-in", "Test Pilot")
    check(Hangar.start() == true and RVNG_HgInfo(1) == 1, "Hangar.start: the main menu's own travel into the hangar, the session up")
    return "next"
  end)
  step("STANDBY reached (the walk)", 150, function(e)
    if Hangar.phase == "standby" then
      check(true, "the hangar, then the walk to STANDBY, each page pressed by its own decide",
        string.format("%d s, %d walk presses, map %s", e, Hangar.walkPresses, tostring(RVNG_LastMap())))
      return "next"
    end
    if e >= 145 then
      local _, name = Hangar.pageNow()
      check(false, "STANDBY reached", string.format("phase %s, on %s", Hangar.phase, tostring(name)))
      return "abort"
    end
  end)
  wait("STANDBY settles", 4)
  step("the lobby on STANDBY", 15, function(e)
    local s = Hangar.shown or {}
    if (not s.ready or not s.ready:find("READY UP", 1, true)) and e < 12 then return nil end
    check(s.ready ~= nil and s.ready:find("READY UP (0/2)", 1, true) ~= nil, "STANDBY's SELECT WINGMEN AIRCRAFT reads READY UP (0/2)", tostring(s.ready))
    check(s.sortie ~= nil and s.sortie:find("LOCKED", 1, true) ~= nil, "SORTIE reads locked", tostring(s.sortie))
    check(s.me == "Test Pilot" and s.opp == "the stand-in", "the FLIGHT panel: this pilot's RVNG name over the game's callsign, the opponent's in the wingman's row",
      string.format("%s / %s", tostring(s.me), tostring(s.opp)))
    info("the description line: " .. tostring(s.help) .. "; " .. Hangar.frames .. " frames written")
    shot("standby_lobby")
    return "next"
  end)
  step("the opponent's plane on the wingman's spot", 30, function(e)
    -- (what the hangar shows: the plane the wingman spot's display group actor holds, not RVNG's own request; the run of
    -- 11:21 passed on RVNG's request while the pages had put the ADF-X02 back)
    if RVNG_LoPeer(0) >= 1 and RVNG_HgInfo(6) == 10034010 and RVNG_HgInfo(10) == 10034010 then
      check(true, "the stand-in's LOADOUT came (an F-14A) and the wingman spot's display group holds it on STANDBY",
        string.format("%d s; the pages' sets turned into the opponent's %d, ApplyGroupDisplay's %d", e, RVNG_HgInfo(11), RVNG_HgInfo(5)))
      return "next"
    end
    if e >= 28 then check(false, "the opponent's plane on the spot", string.format("LOADOUTs %d, asked %d, the spot holds %d", RVNG_LoPeer(0), RVNG_HgInfo(6), RVNG_HgInfo(10))); return "next" end
  end)
  step("pictures of the two planes", 20, function(e)
    if e == 4 then shot("standby_opponent_a") end
    if e < 12 then return nil end
    shot("standby_opponent_b")
    check(RVNG_HgInfo(9) >= 1, "this pilot's loadout sent to the opponent", RVNG_HgInfo(9) .. " LOADOUT(s)")
    check(Hangar.peerNames == "F-14A|XMAA|LAGB" and (Hangar.myNames or ""):match("^[^|]+|[^|]*|[^|]*$") ~= nil,
      "the FLIGHT panel: this pilot's plane and weapons sent, the opponent's shown in the wingman's row",
      string.format("mine %s, theirs %s", tostring(Hangar.myNames), tostring(Hangar.peerNames)))
    return "next"
  end)
  local sortieRow, readyRow
  step("SORTIE refused before both are ready", 10, function(e)
    local a = standbyPage()
    if e == 0 then
      if not a then check(false, "on STANDBY for the presses"); return "next" end
      for i, m in ipairs(standbyRows(a)) do
        if m == "Sortie" and not sortieRow then sortieRow = i - 1 end
        if m == "SelectAircraft" then readyRow = i - 1 end              -- (the last one: SELECT WINGMEN AIRCRAFT)
      end
      Hangar.rej0 = RVNG_HgInfo(4)
      RVNG_PagePress(a, sortieRow or 0)
      return nil
    end
    if e < 3 then return nil end
    check(RVNG_HgInfo(4) == Hangar.rej0 + 1 and RVNG_ReadyInfo(5) == 0 and Ready.phase == "ready",
      "SORTIE before both pilots are ready: refused (the menu's reject sound), no launch",
      string.format("row %s, %d refused, launch state %d", tostring(sortieRow), RVNG_HgInfo(4), RVNG_ReadyInfo(5)))
    return "next"
  end)
  local leaveMode = tostring(C.leave or 0)
  if leaveMode == "1" or leaveMode == "2" or leaveMode == "3" then
    -- (job.py --conf leave=1) LEAVE THE HANGAR instead of the launch: back to the main menu, the lobby over. leave=2: B, B
    -- from SELECT AIRCRAFT instead (the aircraft page's B to the HANGAR MENU, its B the game's quit: RVNG's leave)
    local leave2 = leaveMode == "2"
    if leaveMode == "3" then
      -- (leave=3) the opponent gone: the stand-in's link cut while this pilot is on STANDBY; the link's loss (6 s) ends
      -- the lobby on this PC too
      step("the opponent's link lost", 5, function()
        check(RVNG_WireCut() == 1, "the stand-in's wire cut (the opponent gone)")
        return "next"
      end)
    end
    local L2 = {}
    if leave2 then
      -- (B on STANDBY steps back through the squad, weapons and aircraft pages to the HANGAR MENU; B there is the game's
      -- quit, RVNG's leave since 0.4.3. A B on an aircraft page opened from STANDBY goes back to STANDBY: run of 12:56)
      step("B from STANDBY to the HANGAR MENU, then B", 60, function(e)
        local a, name = Hangar.pageNow()
        if name == "WBP_Menu_Hangar_Top_000_C" then
          if e - (L2.t or 0) < 2 then return nil end
          RVNG_PageBack(a)
          check(true, "B from STANDBY back to the HANGAR MENU, then B there (the game's quit)", string.format("%d back(s), %d s", L2.n or 0, e))
          return "next"
        end
        if L2.at and a == L2.at and e - L2.t < 5 then return nil end
        if (L2.n or 0) >= 8 then check(false, "B back to the HANGAR MENU", "on " .. tostring(name)); return "next" end
        L2.n, L2.at, L2.t = (L2.n or 0) + 1, a, e
        if a then RVNG_PageBack(a) end
      end)
    end
    local L = {}
    step("LEAVE THE HANGAR", 70, function(e)
      if e == 0 and leaveMode ~= "1" then return nil end
      if e == 0 then
        local a = standbyPage()
        local row
        for i, m in ipairs(a and standbyRows(a) or {}) do if m == "Top" then row = i - 1 end end
        if not (a and row) then check(false, "STANDBY's LEAVE THE HANGAR row"); return "next" end
        RVNG_PagePress(a, row)
        return nil
      end
      local m = RVNG_LastMap() or ""
      local _, name = Hangar.pageNow()
      if m:find("PL_MainMenu", 1, true) and name == "WBP_Menu_MainTop_000_C" and Pages.page == "multiplayer" and Pages.shown and menuRow() == 0 then
        check(Hangar.phase == "off" and RVNG_HgInfo(1) == 0 and Ready.phase == "off" and Pages.page == "multiplayer",
          "leaving the hangar: back on RVNG's MULTIPLAYER page (the cursor on RANKED 1V1), the lobby and the session over",
          string.format("%d s; %s; hangar %s, ready %s", e, tostring(Pages.screen()), Hangar.phase, Ready.phase))
        return "next"
      end
      if e >= 65 then check(false, "back on the main menu's top page", string.format("map %s, page %s", m, tostring(name))); return "next" end
    end)
    wait("the main menu", 6)
    step("a picture of the main menu", 5, function() shot("after_leave"); return "next" end)
  else
  step("READY UP", 15, function(e)
    local a = standbyPage()
    if e == 0 then
      if not (a and readyRow) then check(false, "STANDBY's READY UP row"); return "next" end
      RVNG_PagePress(a, readyRow)
      return nil
    end
    if RVNG_ReadyInfo(2) >= 1 and RVNG_ReadyInfo(3) >= 1 and RVNG_HgInfo(7) == 1 then
      check(true, "READY UP: this pilot ready, the stand-in with it: SORTIE open",
        string.format("row %d; %s / %s", readyRow, tostring((Hangar.shown or {}).ready), tostring((Hangar.shown or {}).sortie)))
      shot("both_ready")
      return "next"
    end
    if e >= 12 then
      check(false, "both ready, SORTIE open", string.format("mine %d theirs %d open %d", RVNG_ReadyInfo(2), RVNG_ReadyInfo(3), RVNG_HgInfo(7)))
      return "next"
    end
  end)
  -- (the plan: changing the plane after readying un-readies): SELECT AIRCRAFT while ready, then back to STANDBY with B
  step("off STANDBY un-readies", 20, function(e)
    if e == 0 then
      local a = standbyPage()
      local row
      for i, m in ipairs(a and standbyRows(a) or {}) do if m == "SelectAircraft" and not row then row = i - 1 end end
      if not (a and row) then check(false, "STANDBY's SELECT AIRCRAFT row"); return "next" end
      RVNG_PagePress(a, row)
      return nil
    end
    local _, name = Hangar.pageNow()
    if name ~= "WBP_Menu_Hangar_StandbySetting_000_C" and RVNG_ReadyInfo(2) == 0 and RVNG_HgInfo(7) == 0 then
      check(true, "SELECT AIRCRAFT while ready: not ready any more, SORTIE locked again", string.format("on %s", name))
      shot("editing_unready")
      return "next"
    end
    if e >= 18 then check(false, "un-ready off STANDBY", string.format("on %s, ready %d, open %d", name, RVNG_ReadyInfo(2), RVNG_HgInfo(7))); return "next" end
  end)
  -- (back the way a pilot would: confirm the aircraft, the weapons and the squad page; B on the aircraft page goes to the
  -- HANGAR MENU, whose own B quits the hangar. The lobby's walk does the confirming)
  step("confirmed back to STANDBY", 40, function(e)
    if e == 0 then Hangar.phase = "walk"; return nil end
    if Hangar.phase == "standby" then check(true, "confirmed through the aircraft, weapons and squad pages back to STANDBY", string.format("%d s", e)); return "next" end
    if e >= 38 then local _, name = Hangar.pageNow(); check(false, "back to STANDBY", "on " .. tostring(name)); return "next" end
  end)
  wait("STANDBY again", 3)
  step("READY UP again", 15, function(e)
    local a = standbyPage()
    if e == 0 then
      if not (a and readyRow) then check(false, "STANDBY's READY UP row"); return "next" end
      RVNG_PagePress(a, readyRow)
      return nil
    end
    if RVNG_ReadyInfo(2) >= 1 and RVNG_ReadyInfo(3) >= 1 and RVNG_HgInfo(7) == 1 then check(true, "ready again: SORTIE open"); return "next" end
    if e >= 12 then check(false, "ready again", string.format("mine %d open %d", RVNG_ReadyInfo(2), RVNG_HgInfo(7))); return "next" end
  end)
  wait("both ready", 2)
  step("SORTIE launches both", 20, function(e)
    local a = standbyPage()
    if e == 0 then
      if not (a and sortieRow) then check(false, "STANDBY's SORTIE row"); return "next" end
      RVNG_PagePress(a, sortieRow)
      return nil
    end
    if RVNG_ReadyInfo(5) ~= 0 and RVNG_ReadyInfo(6) >= 0 then
      check(true, "SORTIE: the host's LAUNCH set (ready 2 on the link)",
        string.format("%d s; %d ms to the launch; %s", e, RVNG_ReadyInfo(6), tostring((Hangar.shown or {}).sortie)))
      shot("countdown")
      return "next"
    end
    if e >= 18 then check(false, "the launch set", string.format("ready %d/%d, launch %d", RVNG_ReadyInfo(2), RVNG_ReadyInfo(3), RVNG_ReadyInfo(5))); return "abort" end
  end)
  step("the launch", 15, function()
    if launchedAt then
      check(Ready.phase == "launched" and RVNG_HgInfo(1) == 0, "launched at the agreed time; the hangar session over first",
        string.format("session %d", RVNG_HgInfo(1)))
      return "next"
    end
  end)
  step("the deathmatch map", 60, function(e)
    local m = RVNG_LastMap() or ""
    if m:find("PL_DM_", 1, true) then check(true, "from the hangar into the deathmatch", m .. string.format(", %d s", e)); return "next" end
  end)
  step("the match armed", 5, function()
    check(RVNG_MatchInfo(2) == 1, "a normal install's own launch armed the match", string.format("armed %d", RVNG_MatchInfo(2)))
    return "next"
  end)
  untilState("GamePlaying (14) reached through RVNG's start", 14, 240)
  step("the opponent in its own plane", 5, function()
    check(RVNG_HgInfo(8) == 10034010, "the opponent's copy flies the stand-in's F-14A (its LOADOUT in slot 1's selector)",
      "aircraft " .. RVNG_HgInfo(8))
    check(RVNG_OppInfo(3) == 2, "two planes in the match", RVNG_OppInfo(3) .. " plane(s)")
    return "next"
  end)
  wait("in flight", 8)
  step("a picture in flight", 5, function() shot("in_flight"); return "next" end)
  wait("in flight", 8)
  step("a second picture in flight", 5, function() shot("in_flight_2"); return "next" end)
  if tostring(C.full or 0) == "1" then
    -- (job.py --conf full=1) the match to its end, then the main menu and RVNG's result page after a hangar launch
    untilState("time-up: GameTerminating (15) reached", 15, 330)
    step("the match's stats (for the leaderboard)", 10, function(e)
      if RVNG_MatchStat(0) < 1 and e < 8 then return nil end
      check(RVNG_MatchStat(0) >= 1 and RVNG_MatchStat(3) >= 150 and RVNG_MatchStat(4) == 0,
        "the match's stats in a normal install: its length, ended by time-up",
        string.format("%d s, end %d; deaths %d / %d", RVNG_MatchStat(3), RVNG_MatchStat(4), RVNG_MatchStat(1), RVNG_MatchStat(2)))
      return "next"
    end)
    step("the main menu after the match", 120, function(e)
      local m = RVNG_LastMap() or ""
      if m:find("PL_MainMenu", 1, true) then
        check(true, "D6: after the match the game goes to the main menu", string.format("%s, %d s", m, e))
        return "next"
      end
    end)
    step("the result page", 60, function(e)
      if Ready.phase == "result" and Pages.page == "result" and Pages.shown then
        check(true, "the result page in the main menu after a hangar match", string.format("%d s; %s", e, tostring(Pages.screen())))
        return "next"
      end
      if e >= 58 then
        check(false, "the result page after a hangar match", string.format("ready %s, page %s, hangar %s, session %d",
          tostring(Ready.phase), tostring(Pages.page), tostring(Hangar.phase), RVNG_HgInfo(1)))
        return "next"
      end
    end)
    wait("the result page", 3)
    step("a picture of the result page", 5, function()
      check(RVNG_HgInfo(1) == 0 and Hangar.phase == "off", "the hangar session stayed over after the match",
        string.format("session %d, hangar %s", RVNG_HgInfo(1), Hangar.phase))
      shot("result_page")
      return "next"
    end)
    -- PLAY AGAIN, and the next match found: back into the hangar, the opponent's plane on the spot again
    step("PLAY AGAIN", 10, function(e)
      if e == 0 then Pages.press(2); return nil end
      check(Pages.page == "lobby", "PLAY AGAIN queues again (the LOBBY)", tostring(Pages.screen()))
      return "next"
    end)
    step("the next match found: into the hangar again", 10, function()
      Ready.begin("the stand-in", "Test Pilot")
      check(Hangar.start() == true and RVNG_HgInfo(1) == 1, "a second hangar session started")
      return "next"
    end)
    step("STANDBY again", 150, function(e)
      if Hangar.phase == "standby" and RVNG_HgInfo(10) == 10034010 then
        check(true, "STANDBY again with the opponent's F-14A on the wingman's spot (a second session)", string.format("%d s", e))
        return "next"
      end
      if e >= 145 then
        check(false, "STANDBY again", string.format("phase %s, the spot holds %d, ready %s", Hangar.phase, RVNG_HgInfo(10), tostring(Ready.phase)))
        return "next"
      end
    end)
    wait("STANDBY again", 6)
    step("a picture of the second STANDBY", 5, function() shot("standby_second"); return "next" end)
  end
  end
elseif suite == "hangar" then
  -- The stock pre-sortie hangar from the main menu (2026-11-21, native/hangar.h, docs/re/hangar/; the user: "launch
  -- straight into the hangar", the opponent's plane where the wingman's stands, "send screenshots of every menu"). A
  -- normal install's settings plus hangar=1: RVNG's pages, the travel into PL_Hangar002 with a free-mission context, a
  -- picture of every hangar page on the way to STANDBY (SORTIE is never pressed; the runtime refuses any mission travel
  -- while its hangar session is up), the opponent's plane on the wingman's spot (stock ids only), the loadout fields,
  -- B back out, the other HANGAR MENU pages, and QUIT back to the main menu. Each press runs the page's own decide in its
  -- own tick (the runtime's confirm-input hook), each B its own pending-cancel byte: posted keys don't reach the game.
  local Native = package.loaded["rvng_native"]
  local Pages = package.loaded["rvng_pages"]
  local function addrOf(o)
    local ok, a = pcall(function() return o:GetAddress() end)
    return ok and type(a) == "number" and a or nil
  end
  local function liveOf(cls)
    local okF, all = pcall(FindAllOf, cls)
    local any
    for _, o in ipairs(okF and type(all) == "table" and all or {}) do
      local okV, v = pcall(function() return o:IsValid() end)
      if okV and v then
        local okI, inVp = pcall(function() return o:IsInViewport() end)
        if okI and inVp then return o end
        any = any or o
      end
    end
    return any
  end
  local function pageNow()
    local a = RVNG_PageNow()
    if type(a) ~= "number" or a == 0 then return nil, "" end
    return a, RVNG_PageName(a) or ""
  end
  local function short(name)
    local s = tostring(name or "?"):gsub("_C$", ""):gsub("^WBP_Menu_Hangar_", ""):gsub("^WBP_Menu_", ""):gsub("^WBP_", "")
    return s
  end
  local function rows(a)
    local t = {}
    local n = a and RVNG_PageRows(a) or -1
    for i = 0, (n or 0) - 1 do
      local s = RVNG_PageRow(a, i) or ""
      local cmd, menu, lv, inv, look = s:match("^([^|]*)|([^|]*)|([^|]*)|(%d)|(%d)$")
      t[#t + 1] = { i = i, cmd = cmd or "?", menu = menu or "?", level = tonumber(lv) or -9, invalid = inv == "1",
                    look = tonumber(look) or 0 }
    end
    return t
  end
  local function rowsText(t)
    local s = {}
    for _, r in ipairs(t) do
      s[#s + 1] = string.format("%d %s>%s%s%s", r.i, r.cmd, r.menu, r.level ~= -1 and ("@L" .. r.level) or "",
        r.invalid and " (off)" or "")
    end
    return #s > 0 and table.concat(s, ", ") or "(no rows)"
  end
  local shots = 0
  local function shot(name)
    shots = shots + 1
    say(string.format("SHOT hangar_%02d_%s", shots, (tostring(name):gsub("[^%w_]", "_"))))
  end
  local function describe(a, name, why)
    info(string.format("page %s (%s): rows %s", short(name), why, rowsText(rows(a))))
  end

  step("the runtime's Lua functions", 5, function()
    check(type(RVNG_Version()) == "string" and RVNG_ProbeOn() == 0, "the native runtime answers, test logger off",
      "version " .. tostring(RVNG_Version()) .. ", probe " .. tostring(RVNG_ProbeOn()))
    check(type(rawget(_G, "RVNG_HangarGo")) == "function" and RVNG_PageInfo(4) == 0,
      "the runtime has the hangar test's functions, no hangar session yet")
    return "next"
  end)
  step("the runtime's hooks", 90, function()
    local n = RVNG_Hooks()
    if n < 0 then return nil end
    check(n == 11 and RVNG_HgInfo(0) == 8, "the always-on hooks, the 8 match hooks, and the hangar's 8 (counted apart since 0.4.3)",
      string.format("%d hooks, %d of the hangar's", n, RVNG_HgInfo(0)))
    return "next"
  end)
  wallStep()
  step("the boot login ended (D7)", C.menu_timeout_s, function(e)
    if type(Native) ~= "table" then check(false, "rvng_native.lua is loaded"); return "abort" end
    if Native.ended >= 1 then
      check(true, "the refused boot login ended through the game's own failure exit", string.format("%d s into the step", e))
      return "next"
    end
  end)
  wait("settling at the main menu", 15)
  step("the main menu", 5, function(e)
    local _, name = pageNow()
    info("the active menu page: " .. short(name))
    shot("main_menu")
    RVNG_UdmDump("main menu")
    return "next"
  end)
  -- RVNG's own pages (pictures), then back to the stock main menu
  step("RVNG's MULTIPLAYER page", 10, function(e)
    if type(Pages) ~= "table" then check(false, "rvng_pages.lua is loaded"); return "abort" end
    if e == 0 then
      Pages.onQueue = function() end
      Pages.onCancel = function() end
      Pages.openMultiplayer()
      return nil
    end
    if e < 2 then return nil end
    info("RVNG's page: " .. tostring(Pages.screen()))
    shot("rvng_multiplayer")
    return "next"
  end)
  step("RVNG's LOBBY page", 10, function(e)
    if e == 0 then Pages.press(1); return nil end
    if e < 2 then return nil end
    info("RVNG's page: " .. tostring(Pages.screen()))
    shot("rvng_lobby")
    return "next"
  end)
  step("back to the stock main menu", 10, function(e)
    if e == 0 then Pages.press(5); return nil end        -- LEAVE LOBBY: MULTIPLAYER
    if e == 1 then Pages.press(5); return nil end        -- BACK: the main menu
    if e < 3 then return nil end
    check(Pages.page == "main", "RVNG's pages closed", tostring(Pages.screen()))
    return "next"
  end)
  -- into the hangar
  step("into the hangar", 100, function(e)
    if e == 0 then
      local top = liveOf("WBP_Menu_MainTop_000_C")
      local a = top and addrOf(top)
      check(a ~= nil and RVNG_HangarGo(a) == 1,
        "RVNG_HangarGo: the main menu's own travel request to the hangar (level 14, Mission014's context: one wingman spot, free mission)")
      if not a then return "abort" end
      return nil
    end
    local m = RVNG_LastMap() or ""
    local _, name = pageNow()
    if m:find("PL_Hangar", 1, true) and name == "WBP_Menu_Hangar_Top_000_C" then
      check(true, "in the hangar: its map requested and its HANGAR MENU page active", string.format("%s, %d s", m, e))
      return "next"
    end
    if e >= 95 then
      check(false, "in the hangar", string.format("last map %s, active page %s", m, short(name)))
      return "abort"
    end
  end)
  wait("the hangar settles", 6)
  local top
  step("the HANGAR MENU", 5, function()
    local a, name = pageNow()
    top = a
    local t = rows(a)
    describe(a, name, "the first page")
    check(#t > 0, "the HANGAR MENU's rows read through the game's row data", #t .. " rows")
    RVNG_UdmDump("the hangar's first page")
    shot("top")
    return "next"
  end)
  -- the opponent's plane on the wingman's spot (display group 1), stock aircraft only
  local mgr
  local function showOpp(id, label)
    step("the opponent's plane: " .. label, 20, function(e)
      if e == 0 then
        mgr = nil
        local okF, all = pcall(FindAllOf, "LiveHangarManager")
        local n = 0
        for _, o in ipairs(okF and type(all) == "table" and all or {}) do
          local a = addrOf(o)
          if a and not mgr then
            n = n + 1
            if RVNG_HangarShow(a, id, -1) == 1 then mgr = a end
          end
        end
        check(mgr ~= nil, "aircraft " .. id .. " (" .. label .. ") asked for on the wingman's spot",
          n .. " hangar manager(s) tried")
        if not mgr then return "next" end
        return nil
      end
      if e < 10 then return nil end                     -- (its blueprint loads asynchronously)
      shot("opponent_" .. label)
      return "next"
    end)
  end
  showOpp(21010, "su57")
  showOpp(10034010, "f14a_dlc")
  step("an aircraft outside the stock list is refused", 5, function()
    check(mgr ~= nil and RVNG_HangarShow(mgr, 99999, -1) == 0 and RVNG_HangarShow(mgr, 10013010, -1) == 0,
      "RVNG_HangarShow refuses ids outside the 34 stock aircraft (99999; the mission-only 10013010)")
    return "next"
  end)
  -- START MISSION and on, a picture of every page, to STANDBY (never SORTIE)
  local walk = { phase = "press", n = 0, standby = false }
  step("the pages to STANDBY", 200, function(e)
    local W = walk
    if W.phase == "press" then
      local a, name = pageNow()
      local row = -1
      if W.n == 0 then
        for _, r in ipairs(rows(top)) do
          if row < 0 and (r.menu == "AircraftSettings" or r.cmd:find("Start", 1, true)) then row = r.i end
        end
        check(row >= 0, "the HANGAR MENU has START MISSION (to the aircraft page)", row >= 0 and ("row " .. row) or "not found")
        if row < 0 then return "next" end
        a = top
      else
        -- (the Squad page: its row to STANDBY, not SELECT WINGMAN, which opens the wingman's aircraft page; run 2)
        for _, r in ipairs(rows(a)) do if row < 0 and (r.menu == "Standby" or r.menu == "Stadby") then row = r.i end end
      end
      W.from, W.pressed, W.t = a, RVNG_PageInfo(0), e
      RVNG_PagePress(a, row)
      W.phase = "wait"
      return nil
    elseif W.phase == "wait" then
      local a, name = pageNow()
      if a and a ~= W.from and RVNG_PageInfo(0) > W.pressed then W.phase, W.t = "settle", e; return nil end
      if e - W.t > 15 then
        info(string.format("no new page within 15 s after a press on %s (press run %s)", short(RVNG_PageName(W.from or 0)),
          RVNG_PageInfo(0) > (W.pressed or 0) and "yes" or "no"))
        return "next"
      end
      return nil
    elseif W.phase == "settle" then
      if e - W.t < 3 then return nil end
      local a, name = pageNow()
      W.n = W.n + 1
      describe(a, name, "page " .. W.n .. " after START MISSION")
      RVNG_UdmDump(short(name))
      shot(short(name))
      if name == "WBP_Menu_Hangar_StandbySetting_000_C" then
        W.standby, W.standbyPage = true, a
        return "next"
      end
      if W.n >= 10 then info("10 pages without STANDBY: stopping the walk"); return "next" end
      W.phase = "press"
      return nil
    end
  end)
  step("STANDBY: SORTIE is there (not pressed)", 5, function()
    if not walk.standby then check(false, "the walk reached STANDBY", walk.n .. " page(s)"); return "next" end
    local has
    for _, r in ipairs(rows(walk.standbyPage)) do if r.menu == "Sortie" or r.cmd:find("Sortie", 1, true) then has = r end end
    check(has ~= nil, "STANDBY's SORTIE row found (the one RVNG turns into READY UP / blocks)",
      has and string.format("row %d %s%s", has.i, has.cmd, has.invalid and " (off)" or "") or rowsText(rows(walk.standbyPage)))
    return "next"
  end)
  -- the opponent's plane again on STANDBY (the stock pages may have put the wingman's back on group 1 since the HANGAR
  -- MENU; the picture before shows which plane stood there)
  step("STANDBY: the opponent's plane again", 20, function(e)
    if not walk.standby then return "next" end
    if e == 0 then
      check(mgr ~= nil and RVNG_HangarShow(mgr, 10034010, -1) == 1, "the F-14A asked for on the wingman's spot on STANDBY")
      return nil
    end
    -- (STANDBY's camera pans slowly along the flight: three pictures, 6 s apart, catch the lineup; run 5)
    if e == 8 then shot("standby_opponent_f14a_a") end
    if e == 14 then shot("standby_opponent_f14a_b") end
    if e < 20 then return nil end
    shot("standby_opponent_f14a_c")
    return "next"
  end)
  -- the wingman's spot framed: STANDBY's SELECT WINGMEN AIRCRAFT (its second SelectAircraft row) opens the wingman's
  -- aircraft page, whose camera looks at display group 1. Only a picture: sending a plane while this page is up broke its
  -- view in run 4 (the page owns group 1 there), and RVNG's lobby never opens it
  local WG = { phase = "open" }
  step("the wingman's spot framed", 60, function(e)
    if not walk.standby then return "next" end
    if WG.phase == "open" then
      local row
      for _, r in ipairs(rows(walk.standbyPage)) do if r.menu == "SelectAircraft" then row = r.i end end   -- (the last one)
      if not row then info("STANDBY has no SELECT WINGMEN AIRCRAFT row"); return "next" end
      WG.pressed, WG.t, WG.phase = RVNG_PageInfo(0), e, "wait"
      RVNG_PagePress(walk.standbyPage, row)
      return nil
    elseif WG.phase == "wait" then
      local a = pageNow()
      if a and a ~= walk.standbyPage and RVNG_PageInfo(0) > WG.pressed then WG.phase, WG.t = "stock", e; return nil end
      if e - WG.t > 12 then info("no wingman aircraft page within 12 s"); return "next" end
      return nil
    elseif WG.phase == "stock" then
      if e - WG.t < 5 then return nil end
      local a, name = pageNow()
      describe(a, name, "the wingman's aircraft page")
      shot("wingman_page")
      return "next"
    end
  end)
  -- B back out to the HANGAR MENU
  local function backToTop(label)
    local B = { tries = 0 }
    step("B back to the HANGAR MENU (" .. label .. ")", 80, function(e)
      local a, name = pageNow()
      if name == "WBP_Menu_Hangar_Top_000_C" then
        check(true, "B / Esc (the page's own cancel) back to the HANGAR MENU (" .. label .. ")", B.tries .. " back(s)")
        top = a
        return "next"
      end
      if B.at and a == B.at and e - B.t < 8 then return nil end
      if B.tries >= 10 then check(false, "back to the HANGAR MENU (" .. label .. ")", "still on " .. short(name)); return "next" end
      B.tries, B.at, B.t = B.tries + 1, a, e
      if a then RVNG_PageBack(a) end
      return nil
    end)
  end
  backToTop("from STANDBY")
  wait("the HANGAR MENU again", 3)
  step("the HANGAR MENU after the walk", 5, function()
    shot("top_after_walk")
    RVNG_UdmDump("after the walk")
    return "next"
  end)
  -- the HANGAR MENU's other pages (never BRIEFING: a map travel; never QUIT here)
  local function visit(menuId, label)
    local V = { phase = "press" }
    step("the HANGAR MENU's " .. label, 30, function(e)
      if V.phase == "press" then
        local row
        for _, r in ipairs(rows(top)) do if not row and r.menu == menuId and r.level == -1 then row = r.i end end
        if not row then info("the HANGAR MENU has no " .. label .. " row (" .. menuId .. ")"); return "next" end
        V.pressed, V.t, V.phase = RVNG_PageInfo(0), e, "wait"
        RVNG_PagePress(top, row)
        return nil
      elseif V.phase == "wait" then
        local a = pageNow()
        if a and a ~= top and RVNG_PageInfo(0) > V.pressed then V.phase, V.t = "settle", e; return nil end
        if e - V.t > 12 then info("no page for " .. label .. " within 12 s"); return "next" end
        return nil
      else
        if e - V.t < 3 then return nil end
        local a, name = pageNow()
        describe(a, name, label)
        shot(short(name))
        return "next"
      end
    end)
    backToTop("from " .. label)
  end
  if tostring(C.visits or 1) ~= "0" then           -- (job.py --conf visits=0 skips them: pictures of them exist, run 4)
    visit("AircraftSet_SelectSlot", "AIRCRAFT SET")
    visit("AircraftTree", "AIRCRAFT TREE")
    visit("SelectDifficulty", "DIFFICULTY")
    visit("SelectTraining", "TRAINING")
  end
  wait("the HANGAR MENU at the end", 3)
  step("the opponent's spot at the end", 5, function() shot("top_end"); return "next" end)
  -- QUIT: the HANGAR MENU's own row (LevelId 2, the game's quit to the main menu), B as the fallback
  local Q = {}
  step("QUIT to the main menu", 70, function(e)
    if e == 0 then
      local row
      for _, r in ipairs(rows(top)) do if not row and r.level == 2 then row = r.i end end
      Q.row = row
      if row then RVNG_PagePress(top, row) else RVNG_PageBack(top) end
      return nil
    end
    -- (the game's quit returns to the page it came from: FREE MISSION here, its menu context's return page; run 2)
    local m = RVNG_LastMap() or ""
    local a, name = pageNow()
    if m:find("PL_MainMenu", 1, true) and a and not name:find("Hangar", 1, true) and name ~= "" then
      check(true, "QUIT: back in the main menu's world", string.format("%s, %d s, %s, on %s", m, e,
        Q.row and ("the QUIT row " .. Q.row) or "B", short(name)))
      RVNG_HangarEnd()
      return "next"
    end
    if e == 20 and top then RVNG_PageBack(top) end    -- (a dialog or no row: B, the Top page's own cancel = quit)
    if e >= 65 then check(false, "back at the main menu", "last map " .. m); RVNG_HangarEnd(); return "next" end
  end)
  wait("the page the quit returned to", 6)
  step("the page the quit returned to", 5, function()
    local _, name = pageNow()
    shot("after_quit_" .. short(name))
    return "next"
  end)
  local M = { tries = 0 }
  step("B back to the main menu's top", 60, function(e)
    local a, name = pageNow()
    if name == "WBP_Menu_MainTop_000_C" then
      check(true, "B back to the main menu's top page", M.tries .. " back(s)")
      return "next"
    end
    if M.at and a == M.at and e - M.t < 8 then return nil end
    if M.tries >= 5 then check(false, "back to the main menu's top page", "still on " .. short(name)); return "next" end
    M.tries, M.at, M.t = M.tries + 1, a, e
    if a then RVNG_PageBack(a) end
    return nil
  end)
  wait("settling at the main menu again", 8)
  step("the main menu after the hangar", 5, function()
    shot("main_menu_after")
    RVNG_UdmDump("main menu after the hangar")
    check(RVNG_PageInfo(2) == 0, "no campaign or free mission travel was tried from the hangar",
      RVNG_PageInfo(2) .. " refused")
    info(string.format("%d presses run, %d active-page changes, %d pictures", RVNG_PageInfo(0), RVNG_PageInfo(3), shots))
    return "next"
  end)
else
  check(false, "a known suite", suite)
end
if suite == "ui_pages" then
  -- RVNG's pages at the main menu, no match: MULTIPLAYER > RANKED 1V1 > the LOBBY > LEAVE LOBBY > BACK. The self-test
  -- presses for the pilot (Pages.press: the row the DLL reports on a real press); the cursor is read the way a press is
  local Pages = package.loaded["rvng_pages"]
  local queued, cancelled
  step("MULTIPLAYER", 15, function(e)
    if type(Pages) ~= "table" then check(false, "rvng_pages.lua is loaded"); return "abort" end
    if e == 0 then
      Pages.onQueue = function(mode) queued = mode end
      Pages.onCancel = function() cancelled = true end
      Pages.openMultiplayer()
      return nil
    end
    local shown = Pages.screen() or "?"
    check(shown == "MULTIPLAYER | RANKED 1V1 | CASUAL 1V1 |  |  | BACK", "the MULTIPLAYER page on screen", shown)
    check(menuRow() == 0, "the cursor on RANKED 1V1", "row " .. menuRow())
    say("SHOT ui_multiplayer")
    return "next"
  end)
  -- the cursor move itself: RVNG_MenuSelect straight on the menu (two arguments: UE4SS's getters pop each one), read
  -- back at once and a tick later
  local probeAfter
  step("cursor move", 5, function(e)
    if e == 0 then
      local okF, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
      local addr
      for _, w in ipairs(okF and type(tops) == "table" and tops or {}) do
        local okA, a = pcall(function() return w:GetAddress() end)
        if okA and type(a) == "number" and RVNG_MenuRow(a) >= 0 then addr = a end
      end
      local ok = addr and RVNG_MenuSelect(addr, 3) or -1
      probeAfter = menuRow()
      check(ok == 1 and probeAfter == 3, "RVNG_MenuSelect(menu, 3) moves the cursor to row 3 (both arguments read)", "row " .. probeAfter)
      Pages.select(1)
      return nil
    end
    check(menuRow() == 0, "the cursor stays where it was put a tick later (Pages.select(1): row 0)", "row " .. menuRow())
    return "next"
  end)
  wait("the page", 2)
  step("RANKED 1V1", 10, function(e)
    if e == 0 then Pages.press(1); return nil end
    check(queued == "ranked" and Pages.page == "lobby", "RANKED 1V1 opens the LOBBY (queued ranked)", tostring(Pages.screen()))
    check(menuRow() == 1, "the cursor moved to the LOBBY's second row (the menu's own SetSelectedIndex)", "row " .. menuRow())
    say("SHOT ui_lobby")
    return "next"
  end)
  wait("the lobby", 2)
  step("LEAVE LOBBY", 10, function(e)
    if e == 0 then Pages.press(5); return nil end
    check(Pages.page == "multiplayer" and menuRow() == 0, "LEAVE LOBBY: back on MULTIPLAYER, cursor on RANKED 1V1",
      "row " .. menuRow() .. (cancelled and "; queue cancelled" or "; no queue to cancel (no companion in the test)"))
    return "next"
  end)
  step("CASUAL 1V1", 10, function(e)
    if e == 0 then Pages.press(2); return nil end
    local shown = Pages.screen() or "?"
    check(queued == "casual" and Pages.page == "lobby" and shown:find("LOBBY | CASUAL 1V1 |", 1, true) == 1,
      "CASUAL 1V1 opens the LOBBY (queued casual)", shown)
    check(menuRow() == 1, "the cursor on the LOBBY's second row", "row " .. menuRow())
    say("SHOT ui_lobby_casual")
    return "next"
  end)
  wait("the casual lobby", 2)
  step("LEAVE the casual lobby", 10, function(e)
    if e == 0 then Pages.press(5); return nil end
    check(Pages.page == "multiplayer" and menuRow() == 0, "LEAVE LOBBY: back on MULTIPLAYER again", "row " .. menuRow())
    return "next"
  end)
  step("BACK", 10, function(e)
    if e == 0 then Pages.press(5); return nil end
    local shown = Pages.screen() or "?"
    check(Pages.page == "main" and RVNG_MenuPress(0) >= 0 and shown:find("MAIN MENU | CAMPAIGN", 1, true) ~= nil and shown:find("| MULTIPLAYER |", 1, true) ~= nil,
      "BACK: the stock main menu's texts back", shown)
    check(menuRow() == 2, "the cursor back on MULTIPLAYER (not on QUIT GAME)", "row " .. menuRow())
    say("SHOT ui_main_after")
    return "next"
  end)
  -- B / Esc on the pages (the user's choice, 2026-11-19): the page's BACK. The menu's own pending-cancel byte is set
  -- (RVNG_MenuBack), so the menu's next tick runs its cancel path as a press does: posted keys don't reach an unfocused game
  local function menuAddr()
    local okF, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
    for _, w in ipairs(okF and type(tops) == "table" and tops or {}) do
      local okA, a = pcall(function() return w:GetAddress() end)
      if okA and type(a) == "number" and RVNG_MenuRow(a) >= 0 then return a end
    end
  end
  local backs0, stage = nil, 0
  step("B/Esc: the lobby again", 10, function()
    if stage == 0 then stage = 1; Pages.openMultiplayer(); return nil end
    if stage == 1 then stage = 2; Pages.press(1); return nil end
    check(Pages.page == "lobby" and RVNG_MenuPress(3) == 1, "the LOBBY again; the main menu's cancel hooked",
      "cancel hooked " .. tostring(RVNG_MenuPress(3)))
    backs0 = RVNG_MenuPress(2)
    return "next"
  end)
  step("B/Esc in the lobby", 10, function(e)
    if e == 0 then
      local a = menuAddr()
      check((a and RVNG_MenuBack(a) or -9) == 1, "B/Esc in the lobby: the menu's pending cancel set")
      return nil
    end
    if Pages.page ~= "multiplayer" and e < 5 then return nil end   -- (the menu's tick, then the pages' own 1 s tick)
    check(RVNG_MenuPress(2) == backs0 + 1, "B/Esc in the lobby: the menu's tick ran its cancel path into RVNG's",
      string.format("%d taken", RVNG_MenuPress(2) - backs0))
    check(Pages.page == "multiplayer" and menuRow() == 0, "B/Esc in the lobby: LEAVE LOBBY, back on MULTIPLAYER", "row " .. menuRow())
    return "next"
  end)
  wait("the page", 2)
  step("B/Esc on MULTIPLAYER", 10, function(e)
    if e == 0 then
      local a = menuAddr()
      check((a and RVNG_MenuBack(a) or -9) == 1, "B/Esc on MULTIPLAYER: the menu's pending cancel set")
      return nil
    end
    if Pages.page ~= "main" and e < 5 then return nil end
    local shown = Pages.screen() or "?"
    check(Pages.page == "main" and shown:find("| MULTIPLAYER |", 1, true) ~= nil and menuRow() == 2,
      "B/Esc on MULTIPLAYER: BACK to the stock main menu, the cursor on MULTIPLAYER", shown .. "; row " .. menuRow())
    say("SHOT ui_main_after_back_key")
    return "next"
  end)
end
if suite == "ui_scan" then
  -- which row the menu shows as selected (the white bar; the cursor starts on CAMPAIGN, row 01): every widget inside
  -- each row widget (WBP_Menu_Text_Focus_000_0N), with its class, name and visibility, and the row's own focus/hover
  step("the menu rows' insides", 60, function()
    local n = 0
    ForEachUObject(function(o)
      local okN, full = pcall(function() return o:GetFullName() end)
      if not okN or type(full) ~= "string" or not full:find("WBP_Menu_MainTop_000_C", 1, true) then return end
      local row = full:match("CommandList%.WidgetTree_%d+%.WBP_Menu_Text_Focus_000_0(%d)")
      if not row then return end
      local okV, vis = pcall(function() return o:GetVisibility() end)
      if not okV then return end
      local extra = ""
      if full:match("WBP_Menu_Text_Focus_000_0%d$") then
        local f1 = select(2, pcall(function() return o:HasAnyUserFocus() end))
        local f2 = select(2, pcall(function() return o:IsHovered() end))
        local f3 = select(2, pcall(function() return o:GetIsEnabled() end))
        extra = string.format(" [row widget: focus %s hovered %s enabled %s]", tostring(f1), tostring(f2), tostring(f3))
      end
      local okO, op = pcall(function() return o:GetRenderOpacity() end)
      n = n + 1
      if n <= 200 then
        say(string.format("INFO row %s: %s vis %s opacity %s%s", row, full:gsub("^.-WBP_Menu_Text_Focus_000_0%d", "~"), tostring(vis),
          okO and string.format("%.2f", op) or "?", extra))
      end
    end)
    check(n > 0, "the menu rows' widgets listed", n .. " widgets")
    return "next"
  end)
  -- the main menu's text widgets: every UObject whose class is a text widget (UMG's TextLayoutWidget or a class named
  -- *Text*) and whose text is the header, a row or the description line is logged with its class and full name
  step("the menu's text widgets", 120, function()
    say("INFO FText constructor: " .. type(rawget(_G, "FText")) .. ", ForEachUObject: " .. type(rawget(_G, "ForEachUObject")))
    local base = StaticFindObject("/Script/UMG.TextLayoutWidget")
    local want = { ["MAIN MENU"] = 1, ["COMPETITIVE 1V1"] = 1, ["CAMPAIGN"] = 1, ["QUIT GAME"] = 1,
      ["Play through the game following a storyline."] = 1 }
    local found, seen, classes = 0, 0, {}
    ForEachUObject(function(o)
      seen = seen + 1
      local okC, cname = pcall(function() return o:GetClass():GetFName():ToString() end)
      if not okC or type(cname) ~= "string" or not cname:find("Text", 1, true) then return end
      local isText = false
      if base and base:IsValid() then local okA, a = pcall(function() return o:IsA(base) end); isText = okA and a end
      local okT, t = pcall(function() return o:GetText():ToString() end)
      if okT and type(t) == "string" then
        classes[cname] = (classes[cname] or 0) + 1
        if want[t] then
          found = found + 1
          say(string.format("INFO text widget: \"%s\" class %s (TextLayoutWidget %s) %s", t, cname, tostring(isText), o:GetFullName()))
        end
      end
    end)
    local list = {}
    for k, v in pairs(classes) do list[#list + 1] = k .. "=" .. v end
    table.sort(list)
    say("INFO text classes with a GetText: " .. table.concat(list, ", "))
    check(found >= 3, "the main menu's text widgets found", string.format("%d of the wanted texts, %d objects looked at", found, seen))
    return "next"
  end)
end
if suite == "link" then
  -- the link's Steam side on one PC (link.h): ISteamNetworkingMessages from the game's steam_api64.dll, relay-only
  -- (P2P_Transport_ICE_Enable = 0, read back), Valve's relay network (SDR) ready, this PC's account. The two-PC link
  -- itself needs the other PC; its protocol is tested offline (native/tests/rt_test.c, TestLink).
  local relay0
  step("Steam's networking, relay-only", 30, function()
    local L = rawget(_G, "RVNG_LinkInfo")
    if type(L) ~= "function" then check(false, "the runtime has the link"); return "abort" end
    relay0 = RVNG_Relay()                                  -- (finds Steam's interfaces, sets relay-only, asks for the relays)
    if L(18) == 0 then return nil end                      -- (Steam not up yet: again next tick)
    check(L(18) == 1, "Steam's ISteamNetworkingMessages found in the game's steam_api64.dll", "found " .. L(18))
    check(L(19) == 1, "relay-only: P2P_Transport_ICE_Enable set to 0 and read back as 0 (no direct connections, no IPs)")
    return "next"
  end)
  step("Valve's relay network", 60, function(e)
    local r = RVNG_Relay()
    if r == 100 then
      check(true, "Valve's relay network ready (status 100)", string.format("%d s; first status %s", e, tostring(relay0)))
      return "next"
    end
    if e >= 59 then check(false, "Valve's relay network ready (status 100)", "status " .. r) end
  end)
  step("this PC's Steam account", 5, function()
    local me = RVNG_LinkSelf()
    check(type(me) == "string" and #me >= 16 and me:match("^%d+$") ~= nil, "this PC's SteamID read",
      "ends in " .. (type(me) == "string" and me:sub(-4) or "?"))
    check(RVNG_LinkStart(me, 1, "selftest") == 0 and RVNG_LinkInfo(0) == 0, "a link to this PC's own account is refused")
    check(RVNG_LinkStart("abc", 1, "selftest") == 0 and RVNG_LinkStart("12345", 3, "selftest") == 0,
      "a link with a bad peer id or player number is refused")
    return "next"
  end)
end
if suite == "net" or suite == "net_dm" or suite == "link" then
  -- D9: the observe-only network log (netlog=1). Its lines in the runtime's log say who opened what; here only its counts.
  step("the network log", 5, function()
    check(RVNG_NetInfo(0) == 1 and RVNG_NetInfo(1) > 0, "the network log is on and observing",
      string.format("%d import slots in %d modules", RVNG_NetInfo(1), RVNG_NetInfo(2)))
    info(string.format("network calls: %d outside connect/send, %d loopback, %d outside name lookups, %d HTTP-library calls, %d distinct, %d socket binds (see the netlog: lines)",
      RVNG_NetInfo(3), RVNG_NetInfo(4), RVNG_NetInfo(5), RVNG_NetInfo(6), RVNG_NetInfo(7), RVNG_NetInfo(8)))
    if type(rawget(_G, "RVNG_EosInfo")) == "function" then
      info(string.format("EOS functions the game looked up: %d (and %d of EOS's anti-cheat interface, counted only; see the netlog: EOS lines)",
        RVNG_EosInfo(9), RVNG_EosInfo(10)))
    end
    return "next"
  end)
end

-- D9's counts at the end of every suite: what the game tried to send, all of it refused (the runtime's log names each)
step("D9: what the wall refused", 5, function()
  if type(rawget(_G, "RVNG_WallInfo")) ~= "function" then return "next" end
  local W = RVNG_WallInfo
  info(string.format("D9 refused: %d LiveWebAPI requests, %d Cosmos calls, %d engine HTTP requests, %d WebSocket connects, %d Strix starts, %d Messenger set-ups; the nine more gates asked %d times (the game would have said yes %d); queued %s",
    W(4), W(5), W(6), W(7), W(8), W(9), W(10), W(11), W(12) >= 0 and tostring(W(12)) or "not watched"))
  -- the EOS SDK's own outside calls (D9 since 2026-11-19, eoswall.h): its import slots pointed at refusing wrappers when
  -- it loaded, and still so now. (The gate's NET: line is the outside view: it should list no outside connection.)
  local E = rawget(_G, "RVNG_EosInfo")
  if type(E) ~= "function" then check(false, "D9: the runtime refuses the EOS SDK's outside calls"); return "next" end
  check(E(0) == 1 and E(1) == 1 and E(2) > 0 and E(3) == 0, "D9: the EOS SDK's outside calls refused (its reaching-out imports all point at refusing wrappers)",
    string.format("on %d, patched %d, %d slots, %d unwrapped now", E(0), E(1), E(2), E(3)))
  info(string.format("EOS refused: %d name lookups, %d connects, %d UDP sends; %d loopback calls let through; %d other EOS modules loaded",
    E(4), E(5), E(6), E(7), E(8)))
  return "next"
end)

-- ---- the runner ----------------------------------------------------------------------------------------------------
local cur, stepStart, t0, done = 1, nil, nil, false
local function finish()
  if done then return end
  done = true
  say(string.format("RESULT %d/%d", ST.pass, ST.pass + ST.fail))
end
info(string.format("suite %s: %d steps (max %d s)", suite, #steps, C.max_s))

Tick.add(function()
  if done then return end
  local now = os.time()
  t0 = t0 or now
  if now - t0 > C.max_s then
    check(false, "the suite within max_s", string.format("%d s; at step %d", C.max_s, cur))
    return finish()
  end
  local s = steps[cur]
  if not s then return finish() end
  if not stepStart then stepStart = now; info("step: " .. s.name) end
  local e = now - stepStart
  local ok, r = pcall(s.fn, e)
  if not ok then
    check(false, s.name, "error " .. tostring(r))
    return finish()
  end
  if r == "next" then
    cur, stepStart = cur + 1, nil
  elseif r == "abort" then
    finish()
  elseif s.timeout and e > s.timeout then
    check(false, s.name, string.format("not within %d s", s.timeout))
    finish()
  end
end)

return ST
