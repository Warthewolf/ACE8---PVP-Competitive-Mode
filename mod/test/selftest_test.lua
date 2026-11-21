-- Runs tools/autotest/lua/rvng_selftest.lua's suites against a fake game (stub RVNG_* functions, a controllable clock).
-- Usage: lua5.4 selftest_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. here .. "/../../tools/autotest/lua/?.lua;" .. package.path

RVNG_TICK_SYNC = true
Key = { F6 = "F6" }
ModifierKey = { CONTROL = "CONTROL" }
function RegisterKeyBind() end
ExecuteInGameThread = function(fn) fn() end
local now = 1000
os.time = function() return now end
local _print = print
print = function() end

-- the fake game
local G
local function fakeGame(opts)
  G = { lines = {}, state = -1, travel = 0, menuAt = opts.menuAt or 30, hooks = opts.hooks or 12, bad = 0, reqs = 0, map = "" }
  RVNG_ProbeOn = function() return 1 end
  RVNG_Version = function() return "0.2.0" end
  RVNG_Hooks = function() return G.hooks end
  RVNG_CheatInfo = function(k) return k == 12 and (opts.d8 == false and 0 or 1) or 0 end   -- D8 hooked, nothing seen
  -- D9: all 6 send points and 9 more gates in (opts.wall = send points hooked), 2 LiveWebAPI requests refused
  RVNG_WallInfo = function(k) return ({ [0] = opts.wall or 6, 6, 9, 9, 2, 0, 0, 0, 0, 0, 3, 3, 2 })[k] or -1 end
  -- D9's EOS part: on, the SDK patched, 6 slots, opts.eosOpen slots unwrapped; 3 lookups and 2 connects refused; 40 EOS lookups
  RVNG_EosInfo = function(k) return ({ [0] = 1, 1, 6, opts.eosOpen or 0, 3, 2, 0, 1, 0, 40, 5 })[k] or -1 end
  RVNG_Watch = function() return G.bad end
  RVNG_ArmDM = function() return 1 end
  RVNG_Log = function(s) G.lines[#G.lines + 1] = s end
  RVNG_State = function() return G.state end
  RVNG_LastState = function() return G.lastHook or G.state end
  RVNG_MapReqs = function() return G.reqs end
  RVNG_LastMap = function()
    if G.map == "" and now - 1000 >= G.menuAt then return "/Game/Maps/Menu/PL_MainMenu" end
    return G.map
  end
  RVNG_TravelDM = function()
    G.travel = G.travel + 1
    G.reqs, G.map = G.reqs + 1, "/Game/OnlineMode/Maps/PL_DM_001"
    return opts.travelOk == false and 0 or 1
  end
  local widget = { IsValid = function() return true end, GetFullName = function() return "LiveMenuMainTopWidget /Engine/Transient.Top_0" end }
  local gi = { IsValid = function() return true end, GetAddress = function() return 0x1000 end }
  function FindFirstOf(cls)
    if cls == "LiveMenuMainTopWidget" then return now - 1000 >= G.menuAt and widget or nil end
    if cls == "BP_LiveGameInstance_C" then return gi end
  end
end

local loopFn
function LoopAsync(_, fn) loopFn = fn end

local function run(conf, opts, game)
  fakeGame(opts or {})
  now = 1000
  RVNG_SELFTEST_CONF = conf
  for _, m in ipairs({ "rvng_tick", "rvng_probe", "rvng_selftest" }) do package.loaded[m] = nil end
  local Tick = require("rvng_tick")
  require("rvng_probe")
  require("rvng_selftest")
  Tick.start(1000)
  for _ = 1, 3000 do
    if game then game(now - 1000) end
    loopFn()
    now = now + 1
    local last = G.lines[#G.lines]
    if last and last:find("RESULT", 1, true) then break end
  end
  return G.lines
end
local function has(lines, pat)
  for _, l in ipairs(lines) do if l:find(pat, 1, true) then return l end end
end
local function result(lines) return (lines[#lines] or ""):match("RESULT (%d+)/(%d+)") end

-- smoke: all pass
local L = run({ suite = "smoke" })
local p, t = result(L)
assert(p and p == t and tonumber(t) == 6, "smoke passes 6/6: " .. table.concat(L, "\n"))
assert(has(L, "PASS D9: the EOS SDK's outside calls refused") and has(L, "INFO EOS refused: 3 name lookups, 2 connects, 0 UDP sends"),
  "smoke checks the EOS block at its end")

-- smoke: an EOS SDK slot not pointed at its wrapper fails it
L = run({ suite = "smoke" }, { eosOpen = 1 })
assert(has(L, "FAIL D9: the EOS SDK's outside calls refused") and result(L), "an unwrapped EOS slot fails")
assert(has(L, "PASS D9: every send point and the nine more web gates hooked (send points 6 of 6, more gates 9 of 9)") and
  has(L, "INFO D9 refused: 2 LiveWebAPI requests"), "smoke checks D9's wall and ends with its counts")

-- smoke: D9 only partly in fails it
L = run({ suite = "smoke" }, { wall = 5 })
assert(has(L, "FAIL D9: every send point") and result(L), "a missing D9 send point fails")

-- smoke: a missing hook fails it
L = run({ suite = "smoke" }, { hooks = 5 })
p, t = result(L)
assert(has(L, "FAIL the runtime hooked the game") and p ~= t, "a missing hook fails")

-- smoke: no main menu: FAIL and RESULT
L = run({ suite = "smoke", menu_timeout_s = 60 }, { menuAt = 9999 })
assert(has(L, "FAIL the main menu") and result(L), "no main menu fails within its timeout")

-- flags: not offline at the main menu fails
L = run({ suite = "flags", watch_s = 20 }, nil, function(t) if t == 50 then G.bad = 1 end end)
assert(has(L, "FAIL offline for 20 s more"), "a NOT OFFLINE sample fails the flags suite")

-- dm_a: states up to 12, held there
L = run({ suite = "dm_a" }, nil, function(t)
  if G.travel > 0 and G.state < 12 and t % 3 == 0 then G.state = G.state + 1 end
end)
p, t = result(L)
assert(p == t and has(L, "PASS held at state 12"), "dm_a passes when the game holds at 12: " .. table.concat(L, "\n"))

-- dm_a: a game that goes past 12 without D2 fails "held"
L = run({ suite = "dm_a" }, nil, function(t)
  if G.travel > 0 and G.state < 14 and t % 3 == 0 then G.state = G.state + 1 end
end)
assert(has(L, "FAIL held at state 12"), "dm_a fails when the game goes past 12")

-- dm_c: through 14, 15, 19 and a travel after
L = run({ suite = "dm_c" }, nil, function(t)
  if G.travel == 0 then return end
  G.t0 = G.t0 or t
  local e = t - G.t0
  if e < 30 then G.state = 1 elseif e < 40 then G.state = 12 elseif e < 260 then G.state = 14
  elseif e < 270 then G.state = 15 elseif e < 280 then G.state = 17
  else G.state, G.lastHook = -1, 19; if not G.after then G.after = true; G.reqs = G.reqs + 1; G.map = "/Game/Maps/Menu/PL_MainMenu" end end
end)
p, t = result(L)
assert(p == t and has(L, "PASS D6: after Ended the game goes to the main menu"), "dm_c passes: " .. table.concat(L, "\n"))

-- prod (probe=0): the gates hooked, the boot login ended by the always-on tick, rows off, no gate asked again
do
  local function prodRun(endAt, gateLater, suite)
    fakeGame({ hooks = 11 })
    now = 1000
    RVNG_SELFTEST_CONF = { suite = suite or "prod" }
    RVNG_NetInfo = function(k) return ({ [0] = 1, 120, 90, 4, 7, 2, 1, 5 })[k] or -1 end
    RVNG_ProbeOn = function() return 0 end
    local gates = 3
    RVNG_GateCalls = function() return gates end
    RVNG_Tick = function() return now - 1000 >= endAt and 1 or 0 end
    for _, m in ipairs({ "rvng_tick", "rvng_probe", "rvng_native", "rvng_menu", "rvng_selftest" }) do package.loaded[m] = nil end
    package.loaded["rvng_menu"] = { removed = { Shop = 1 }, repurposed = 1 }
    local Tick = require("rvng_tick")
    require("rvng_native")
    require("rvng_probe")
    require("rvng_selftest")
    Tick.start(1000)
    for _ = 1, 3000 do
      if gateLater and now - 1000 == endAt + 60 then gates = 4 end
      loopFn()
      now = now + 1
      local last = G.lines[#G.lines]
      if last and last:find("RESULT", 1, true) then break end
    end
    RVNG_Tick, RVNG_GateCalls = nil, nil
    return G.lines
  end
  L = prodRun(25)
  p, t = result(L)
  assert(p == t and tonumber(t) == 7 and has(L, "PASS no web gate asked again") and has(L, "PASS D9: every send point"),
    "prod passes 7/7: " .. table.concat(L, "\n"))
  L = prodRun(25, true)
  assert(has(L, "FAIL no web gate asked again"), "a gate asked after the login ended fails prod")
  -- net (D9): prod's steps, then the observe-only network log's counts
  L = prodRun(25, false, "net")
  p, t = result(L)
  assert(p == t and tonumber(t) == 8 and has(L, "PASS the network log is on and observing") and
    has(L, "INFO network calls: 4 outside connect/send") and has(L, "INFO EOS functions the game looked up: 40"),
    "net passes 8/8 with the network log's counts: " .. table.concat(L, "\n"))
  -- link: prod's steps, then Steam's networking (relay-only), the relay network, this PC's account, refusals
  local relayAt
  RVNG_Relay = function() relayAt = relayAt or now; return now - relayAt >= 3 and 100 or 3 end
  RVNG_LinkInfo = function(k) return ({ [0] = 0, [18] = 1, [19] = 1 })[k] or 0 end
  RVNG_LinkSelf = function() return "76561190000001234" end
  RVNG_LinkStart = function() return 0 end
  L = prodRun(25, false, "link")
  p, t = result(L)
  assert(p == t and tonumber(t) == 14 and has(L, "PASS relay-only: P2P_Transport_ICE_Enable set to 0") and
    has(L, "PASS Valve's relay network ready (status 100)") and has(L, "PASS this PC's SteamID read (ends in 1234)"),
    "link passes 14/14: " .. table.concat(L, "\n"))
  RVNG_LinkInfo = function(k) return ({ [0] = 0, [18] = 1, [19] = 0 })[k] or 0 end
  relayAt = nil
  L = prodRun(25, false, "link")
  assert(has(L, "FAIL relay-only"), "relay-only not confirmed fails the link suite")
  RVNG_Relay, RVNG_LinkInfo, RVNG_LinkSelf, RVNG_LinkStart = nil, nil, nil, nil
end

-- hangar (2026-11-21): RVNG's pages, the travel into the hangar, a picture of every page to STANDBY, the opponent's plane,
-- B back out, the HANGAR MENU's other pages, QUIT. A fake hangar: pages by address, presses and backs run a tick later
do
  fakeGame({ hooks = 11 })
  now = 1000
  RVNG_SELFTEST_CONF = { suite = "hangar" }
  RVNG_HgInfo = function(k) return k == 0 and 8 or 0 end
  RVNG_ProbeOn = function() return 0 end
  RVNG_Tick = function() return now - 1000 >= 25 and 1 or 0 end
  local TOP, AC, W1, W2, PARTS, SQUAD, STANDBY = 0x100, 0x200, 0x300, 0x400, 0x500, 0x600, 0x700
  local names = {
    [TOP] = "WBP_Menu_Hangar_Top_000_C", [AC] = "WBP_Menu_Hangar_AircraftSettings_000_C",
    [W1] = "WBP_Menu_Hangar_WeaponSettings1_000_C", [W2] = "WBP_Menu_Hangar_WeaponSettings2_000_C",
    [PARTS] = "WBP_Menu_Hangar_PartsSettings_000_Old_C", [SQUAD] = "WBP_Menu_Hangar_SquadSetting_000_C",
    [STANDBY] = "WBP_Menu_Hangar_StandbySetting_000_C", [0x800] = "WBP_Menu_Hangar_AircraftSettings_002_C",
    [0x900] = "WBP_Menu_Hangar_AircraftTree_000_C", [0xA00] = "WBP_Menu_HangarDifficulty_000_C",
    [0xB00] = "WBP_Menu_Hangar_Training_000_C", [0x7000] = "WBP_Menu_MainTop_000_C",
    [0xC00] = "WBP_Menu_CampaignFreeMission_000_C",
  }
  local topRows = { "Hangar_Top_StartMission|AircraftSettings|-1|0|0", "Hangar_Top_AircraftSet|AircraftSet_SelectSlot|-1|0|0",
    "Hangar_Top_AircraftTree|AircraftTree|-1|0|0", "Hangar_Top_Briefing|None|4|0|0",
    "Hangar_Top_Difficulty|SelectDifficulty|-1|0|0", "Hangar_Top_Training|SelectTraining|-1|0|0", "Hangar_Top_Quit|None|2|0|0" }
  local byMenu = { AircraftSettings = AC, AircraftSet_SelectSlot = 0x800, AircraftTree = 0x900, SelectDifficulty = 0xA00, SelectTraining = 0xB00 }
  local nextOf = { [AC] = W1, [W1] = W2, [W2] = PARTS, [PARTS] = SQUAD, [SQUAD] = STANDBY }
  local backOf = { [STANDBY] = SQUAD, [SQUAD] = PARTS, [PARTS] = W2, [W2] = W1, [W1] = AC, [AC] = TOP,
    [0x800] = TOP, [0x900] = TOP, [0xA00] = TOP, [0xB00] = TOP, [0xC00] = 0x7000 }
  local H = { active = 0x7000, presses = 0, changes = 0, session = 0, sortie = 0, briefing = 0, shown = {} }
  local function go(a) if a ~= H.active then H.active, H.changes = a, H.changes + 1 end end
  local mainTop = { IsValid = function() return true end, IsInViewport = function() return true end, GetAddress = function() return 0x7000 end }
  local mgrObj = { IsValid = function() return true end, GetAddress = function() return 0x9000 end }
  function FindAllOf(cls)
    if cls == "WBP_Menu_MainTop_000_C" then return (G.map == "" or G.map:find("PL_MainMenu", 1, true)) and { mainTop } or {} end
    if cls == "LiveHangarManager" then return { mgrObj } end
    return {}
  end
  RVNG_HangarGo = function(a)
    if a ~= 0x7000 then return 0 end
    H.session, H.goAt = 1, now
    return 1
  end
  RVNG_HangarEnd = function() H.session = 0 end
  RVNG_HangarShow = function(m, id) if m == 0x9000 and (id == 21010 or id == 10034010 or id == 4010) then H.shown[#H.shown + 1] = id; return 1 end return 0 end
  RVNG_UdmDump = function() end
  RVNG_PageNow = function() return H.active end
  RVNG_PageName = function(a) return names[a] or "" end
  RVNG_PagePress = function(a, row) if not names[a] then return 0 end H.press = { a, row }; return 1 end
  RVNG_PageBack = function(a) if not names[a] then return 0 end H.back = a; return 1 end
  RVNG_PageRows = function(a) return a == TOP and #topRows or a == STANDBY and 3 or a == SQUAD and 2 or names[a] and 0 or -1 end
  RVNG_PageRow = function(a, i)
    if a == TOP then return topRows[i + 1] or "" end
    if a == STANDBY then
      return ({ "None|Sortie|-1|0|0", "None|SelectAircraft|-1|0|0", "None|Top|-1|0|0" })[i + 1] or ""
    end
    if a == SQUAD then return ({ "Hangar_Squad_SelectWingman|SelectAircraft|-1|0|0", "Hangar_Squad_RecommendSetup|Standby|-1|0|0" })[i + 1] or "" end
    return ""
  end
  RVNG_PageInfo = function(k) return ({ [0] = H.presses, -1, 0, H.changes, H.session })[k] or -1 end
  package.loaded["rvng_pages"] = nil
  local P = { page = "main" }
  function P.openMultiplayer() P.page = "multiplayer" end
  function P.press(r)
    if P.page == "multiplayer" then P.page = r == 5 and "main" or "lobby"
    elseif P.page == "lobby" and r == 5 then P.page = "multiplayer" end
  end
  function P.screen() return P.page end
  local hangarGame = function()
    if H.goAt and now - H.goAt == 4 then G.map = "/Game/Maps/Hangar/PL_Hangar002"; go(TOP) end
    if H.press then
      local a, row = H.press[1], H.press[2]
      H.press, H.presses = nil, H.presses + 1
      if a == TOP then
        local r = topRows[row + 1] or ""
        local menu, lv = r:match("^[^|]*|([^|]*)|([^|]*)")
        if lv == "2" then G.map = "/Game/Maps/Menu/PL_MainMenu"; go(0xC00)
        elseif lv == "4" then H.briefing = H.briefing + 1
        elseif byMenu[menu] then go(byMenu[menu]) end
      elseif a == STANDBY then if row == 0 then H.sortie = H.sortie + 1 else go(AC) end
      elseif a == SQUAD then go(row == 1 and STANDBY or AC)
      elseif nextOf[a] then go(nextOf[a]) end
    end
    if H.back then
      local a = H.back
      H.back = nil
      if a == TOP then G.map = "/Game/Maps/Menu/PL_MainMenu"; go(0xC00) elseif backOf[a] then go(backOf[a]) end
    end
  end
  for _, m in ipairs({ "rvng_tick", "rvng_probe", "rvng_native", "rvng_menu", "rvng_selftest" }) do package.loaded[m] = nil end
  package.loaded["rvng_menu"] = { removed = { Shop = 1 }, repurposed = 1 }
  local Tick = require("rvng_tick")
  require("rvng_native")
  package.loaded["rvng_pages"] = P
  require("rvng_probe")
  require("rvng_selftest")
  Tick.start(1000)
  for _ = 1, 3000 do
    hangarGame()
    loopFn()
    now = now + 1
    local last = G.lines[#G.lines]
    if last and last:find("RESULT", 1, true) then break end
  end
  L = G.lines
  p, t = result(L)
  local shots = 0
  for _, l in ipairs(L) do if l:find("selftest: SHOT hangar_", 1, true) then shots = shots + 1 end end
  assert(p and p == t and tonumber(t) == 24, "hangar passes 24/24: " .. table.concat(L, "\n"))
  assert(H.sortie == 0 and H.briefing == 0, "the hangar suite never presses SORTIE or BRIEFING")
  assert(#H.shown == 3 and H.shown[1] == 21010 and H.shown[2] == 10034010 and H.shown[3] == 10034010,
    "the opponent's planes: the Su-57, then the F-14A, the F-14A again on STANDBY")
  assert(has(L, "SHOT hangar_12_StandbySetting_000") and has(L, "SHOT hangar_15_standby_opponent_f14a_c") and has(L, "SHOT hangar_16_wingman_page") and
    has(L, "SHOT hangar_19_AircraftTree_000") and has(L, "SHOT hangar_23_after_quit_CampaignFreeMission_000") and shots == 24,
    "a picture of every page (24): " .. table.concat(L, "\n"))
  assert(has(L, "PASS QUIT: back in the main menu's world") and has(L, "PASS B back to the main menu's top page") and
    H.session == 0, "QUIT ends in the main menu's world, B to its top, the session over")
  RVNG_Tick, FindAllOf = nil, nil
  for _, k in ipairs({ "HgInfo", "HangarGo", "HangarEnd", "HangarShow", "UdmDump", "PageNow", "PageName", "PagePress", "PageBack",
                       "PageRows", "PageRow", "PageInfo" }) do _G["RVNG_" .. k] = nil end
  package.loaded["rvng_pages"] = nil
end

-- a failed travel aborts with a RESULT
L = run({ suite = "dm_b" }, { travelOk = false })
assert(has(L, "FAIL the game's own mission-by-ID travel") and result(L), "a refused travel ends the suite")

print = _print
print("all self-test checks passed")
