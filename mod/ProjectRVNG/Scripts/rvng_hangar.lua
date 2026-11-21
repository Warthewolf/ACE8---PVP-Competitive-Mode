--[[
  rvng_hangar.lua : RVNG's lobby in the stock pre-sortie hangar (2026-11-21, runtime 0.4.3; docs/re/HANGAR.md).

  The user: "Players need to be able to select their aircraft and edit them in the hangar before the match starts",
  "launch straight into the hangar, and select all our options from the Screen where it also allows us to sortie",
  "I want the Sortie button to be blocked until both players have readied up", and only the opponent's plane next to
  yours ("delete the other wingman aircraft").

  A match found (main.lua's onLink, after Ready.begin) starts it:
    travel   the main menu's own travel into the hangar (RVNG_HangarGo: Mission014's context, one wingman spot)
    walk     the stock pages pressed through for the pilot, each by its own decide (the DLL's confirm-input hook):
             HANGAR MENU > START MISSION > aircraft > special weapons > squad > STANDBY, the plane as it was last set
    standby  STANDBY is the lobby: SORTIE, SELECT AIRCRAFT, SP WEAPON 1 / 2, READY UP (was SELECT WINGMEN AIRCRAFT),
             SELECT PARTS, LEAVE THE HANGAR. The DLL takes SORTIE / READY UP / LEAVE (lobby.h); SORTIE stays refused (the
             menu's reject sound) until both pilots are ready, then either pilot's press launches both (Ready.sortie).
             Each second: this pilot's loadout to the opponent (RVNG_LoSend), the opponent's shown on the wingman's spot
             (RVNG_HgOpp: the DLL puts it in whenever the game sets that spot), the texts.
    the launch (Ready.onLaunch, main.lua) ends the session before the travel into the match (Hangar.stop).
  Leaving (LEAVE THE HANGAR, QUIT MISSION, or the opponent gone) travels back to the main menu (RVNG_HgLeave).
]]
local Hangar = { enabled = true, phase = "off", presses = 0, seenPeer = 0, walkPresses = 0, onStart = nil, onLeave = nil,
                 frames = 0, scanned = false }
local Tick = require("rvng_tick")
local Ready = require("rvng_ready")

local TOP, STANDBY, SQUAD = "WBP_Menu_Hangar_Top_000_C", "WBP_Menu_Hangar_StandbySetting_000_C", "WBP_Menu_Hangar_SquadSetting_000_C"
-- the pages the walk confirms as they are (the plane, its weapons and parts as last set)
local WALK_THROUGH = {
  WBP_Menu_Hangar_AircraftSettings_000_C = true, WBP_Menu_Hangar_WeaponSettings1_000_C = true,
  WBP_Menu_Hangar_WeaponSettings2_000_C = true, WBP_Menu_Hangar_PartsSettings_000_Old_C = true,
  WBP_Menu_Hangar_PartsSettings_000_C = true,
}

local function native(name, ...)
  local f = rawget(_G, name)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  if ok then return v end
  return nil
end
local function log(msg)
  if type(rawget(_G, "RVNG_Log")) == "function" then pcall(RVNG_Log, "hangar lobby: " .. msg) end
end
local function ascii(s) return (tostring(s or ""):gsub("[^\32-\126]", "?")) end
local function valid(o)
  if o == nil then return false end
  local ok, v = pcall(function() return o:IsValid() end)
  return ok and v == true
end
local function addrOf(o)
  local ok, a = pcall(function() return o:GetAddress() end)
  return ok and type(a) == "number" and a or nil
end
local function textOf(o)
  local ok, t = pcall(function() return o:GetText():ToString() end)
  return ok and t or nil
end
local function setText(o, t)
  if not valid(o) or textOf(o) == t then return end
  pcall(function() o:SetText(FText(t)) end)
end

-- the active menu page (the one whose tick asks the menus' confirm input: the DLL's hook) and its class
function Hangar.pageNow()
  local a = native("RVNG_PageNow")
  if type(a) ~= "number" or a == 0 then return nil, "" end
  return a, native("RVNG_PageName", a) or ""
end
-- a page's command rows: { i, menu (MenuID), level (LevelId) }
local function rows(a)
  local t = {}
  local n = a and native("RVNG_PageRows", a) or -1
  for i = 0, (n or 0) - 1 do
    local s = native("RVNG_PageRow", a, i) or ""
    local cmd, menu, lv = s:match("^([^|]*)|([^|]*)|([^|]*)|")
    t[#t + 1] = { i = i, cmd = cmd or "?", menu = menu or "?", level = tonumber(lv) or -9 }
  end
  return t
end
local function rowOf(a, menuId)
  for _, r in ipairs(rows(a)) do if r.menu == menuId and r.level == -1 then return r.i end end
end

-- the main menu on screen (the travel is its own request)
local function mainMenuAddr()
  local ok, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
  local any
  for _, t in ipairs(ok and type(tops) == "table" and tops or {}) do
    if valid(t) then
      local okV, inVp = pcall(function() return t:IsInViewport() end)
      if okV and inVp then return addrOf(t) end
      any = any or addrOf(t)
    end
  end
  return any
end

-- a match was found and the link to the opponent started (main.lua, after Ready.begin): into the hangar
function Hangar.start()
  if not Hangar.enabled or type(rawget(_G, "RVNG_HangarGo")) ~= "function" then return false end
  local a = mainMenuAddr()
  if not a then log("no main menu on screen: the hangar can't be opened"); return false end
  if Hangar.onStart then pcall(Hangar.onStart) end   -- (the pages step aside: rvng_pages.lua)
  Ready.needSortie = true
  if native("RVNG_HangarGo", a) ~= 1 then
    log("the travel into the hangar was refused (see the runtime's log)")
    Ready.needSortie = false
    return false
  end
  Hangar.phase, Hangar.t, Hangar.walkPresses, Hangar.seenPeer, Hangar.scanned = "travel", os.time(), 0, 0, false
  Hangar.walkPage, Hangar.walkPressed, Hangar.loBase = nil, nil, nil
  Hangar.presses = native("RVNG_HgInfo", 2) or 0
  Hangar.W = {}
  log("into the hangar (the opponent: " .. ascii(Ready.opponent) .. ")")
  return true
end

-- the launch (main.lua's Ready.onLaunch, before the travel into the match): the session over
function Hangar.stop()
  if Hangar.phase == "off" then return end
  native("RVNG_HgSortie", 0)
  native("RVNG_HangarEnd")
  Ready.needSortie = false
  Hangar.phase = "off"
  log("the session over: the launch")
end

-- leave the lobby: back to the main menu (LEAVE THE HANGAR, QUIT MISSION, or the opponent gone)
function Hangar.leave(why)
  if Hangar.phase == "off" then return end
  local a = Hangar.pageNow()
  native("RVNG_HgLeave", a or 0)
  native("RVNG_HgSortie", 0)
  Ready.needSortie = false
  Hangar.phase = "off"
  log("leaving the hangar: " .. tostring(why))
  if Hangar.onLeave then pcall(Hangar.onLeave, why) end
end

-- ---- STANDBY's texts -------------------------------------------------------------------------------------------------
-- The page's own LiveLocalizeTextBlocks, found by their stock texts once and kept: the READY UP row (SELECT WINGMEN
-- AIRCRAFT), the SORTIE row, the description line, and the FLIGHT panel's wingman name (Mission014's BAXTER)
local STOCK = { ready = "SELECT WINGMEN AIRCRAFT", sortie = "SORTIE", wingman = "BAXTER" }
local function findTexts()
  local W = Hangar.W or {}
  Hangar.W = W
  if valid(W.ready) and valid(W.sortie) and valid(W.help) then return true end
  local ok, all = pcall(FindAllOf, "LiveLocalizeTextBlock")
  if not ok or type(all) ~= "table" then return false end
  local lines, order = {}, {}
  for _, o in ipairs(all) do
    local okN, n = pcall(function() return o:GetFullName() end)
    if okN and type(n) == "string" and n:find("WBP_Menu_Hangar_StandbySetting_000_C", 1, true) and valid(o) then
      local t = textOf(o) or ""
      order[#order + 1] = { o = o, t = t }
      if t == STOCK.ready or (W.readyText and t == W.readyText) then W.ready = o
      elseif t == STOCK.sortie or (W.sortieText and t == W.sortieText) then W.sortie = o
      elseif t == STOCK.wingman or (W.oppText and t == W.oppText) then W.opp = o
      elseif n:find("HelpText", 1, true) and n:find("Text_Body", 1, true) then W.help = o end
      if not Hangar.scanned then lines[#lines + 1] = (n:match("([^%.]+%.[^%.]+)$") or n) .. " = \"" .. ascii(t) .. "\"" end
    end
  end
  -- the FLIGHT panel, in its order (run of 11:09): FLIGHT, this pilot's callsign, plane, SP 1, SP 2, then the wingman's
  -- (the opponent's spot): callsign, plane, SP 1, SP 2
  for i, e in ipairs(order) do
    if e.t == "FLIGHT" and order[i + 8] and order[i + 5].o == W.opp then
      W.me = order[i + 1].o                                    -- (the game's callsign, REX: the pilot's RVNG name)
      W.mine = { order[i + 2].o, order[i + 3].o, order[i + 4].o }
      W.theirs = { order[i + 6].o, order[i + 7].o, order[i + 8].o }
    end
  end
  if not Hangar.scanned and #lines > 0 then
    Hangar.scanned = true
    log("STANDBY's text blocks: " .. table.concat(lines, "; "))
  end
  return valid(W.ready) and valid(W.sortie)
end

-- what STANDBY shows now: { ready row, sortie row, description, wingman name }
function Hangar.view()
  local opp = ascii(Ready.opponent or "your opponent")
  local I = function(k) return native("RVNG_ReadyInfo", k) or -1 end
  local mine, theirs = I(2) >= 1, I(3) >= 1
  local n = (mine and 1 or 0) + (theirs and 1 or 0)
  local launchLeft = I(6)
  if Ready.phase == "launching" and launchLeft >= 0 then
    return "LAUNCHING", string.format("SORTIE IN %d", math.floor(launchLeft / 1000) + 1),
      "Both pilots ready. Launching into the match against " .. opp .. ".", opp
  end
  if I(0) ~= 2 then
    return "READY UP", "SORTIE (LOCKED)", "Match found: " .. opp .. ". Connecting through Steam's relays...", opp
  end
  local sortie = (mine and theirs) and "SORTIE" or string.format("SORTIE (LOCKED %d/2)", n)
  local help
  if mine and theirs then
    help = string.format("Both pilots ready. Press SORTIE to launch against %s.", opp)
  else
    help = string.format("vs %s.  You: %s.  %s: %s.  SORTIE opens when both pilots are ready.", opp,
      mine and "READY" or "not ready", opp, theirs and "READY" or "not ready")
  end
  return mine and string.format("CANCEL READY (%d/2)", n) or string.format("READY UP (%d/2)", n), sortie, help, opp
end
function Hangar.apply()
  if Hangar.phase ~= "standby" then return end
  if not findTexts() then return end
  local W = Hangar.W
  local ready, sortie, help, opp = Hangar.view()
  W.readyText, W.sortieText, W.oppText = ready, sortie, opp
  setText(W.ready, ready)
  setText(W.sortie, sortie)
  if W.help then setText(W.help, help) end
  if W.opp then setText(W.opp, opp) end
  if W.me and Ready.me then setText(W.me, ascii(Ready.me)) end
  -- this pilot's plane and special weapons as its own FLIGHT row shows them go with the LOADOUT; the opponent's are
  -- written into the wingman's row
  if W.mine and valid(W.mine[1]) then
    local mine = ascii((textOf(W.mine[1]) or "") .. "|" .. (textOf(W.mine[2]) or "") .. "|" .. (textOf(W.mine[3]) or ""))
    if mine ~= Hangar.myNames then Hangar.myNames = mine; native("RVNG_LoNames", mine) end
  end
  local theirs = native("RVNG_LoPeerName") or ""
  if W.theirs and theirs ~= "" then
    local i = 0
    for part in (theirs .. "|"):gmatch("([^|]*)|") do
      i = i + 1
      if W.theirs[i] and part ~= "" then setText(W.theirs[i], part) end
    end
    Hangar.peerNames = theirs
  end
  Hangar.shown = { ready = textOf(W.ready), sortie = textOf(W.sortie), help = W.help and textOf(W.help) or nil,
                   me = W.me and textOf(W.me) or nil, opp = W.opp and textOf(W.opp) or nil }
end

-- ---- the opponent's plane ---------------------------------------------------------------------------------------------
local function showOpponent()
  local seq = native("RVNG_LoPeer", 0) or 0
  if seq <= Hangar.seenPeer then return end
  local plane, skin = native("RVNG_LoPeer", 1) or 0, native("RVNG_LoPeer", 2) or -1
  if plane <= 0 then return end
  Hangar.seenPeer = seq
  local shown = native("RVNG_HgOpp", plane, skin)
  local ok, mgrs = pcall(FindAllOf, "LiveHangarManager")
  local done = false
  for _, m in ipairs(ok and type(mgrs) == "table" and mgrs or {}) do
    local a = addrOf(m)
    if a and not done and native("RVNG_HangarShow", a, plane, skin) == 1 then done = true end
  end
  Hangar.oppPlane = shown
  log(string.format("the opponent's plane %s on the wingman's spot (%s)", tostring(shown), done and "shown" or "set for the game's next refresh"))
end

-- ---- the tick ------------------------------------------------------------------------------------------------------
function Hangar.step()
  if Hangar.phase == "off" then return end
  local now = os.time()
  if Ready.phase == "left" then Hangar.leave("the opponent left") return end
  if Ready.phase == "launched" then Hangar.stop() return end
  local a, name = Hangar.pageNow()
  if Hangar.phase == "travel" then
    local m = native("RVNG_LastMap") or ""
    if m:find("PL_Hangar", 1, true) and name == TOP then
      Hangar.phase, Hangar.t, Hangar.lastPage, Hangar.pageAt = "walk", now, a, now
      log("in the hangar: walking to STANDBY")
    elseif now - Hangar.t > 90 then
      log("the hangar didn't come up within 90 s")
      Hangar.leave("the hangar didn't load")
    end
    return
  end
  if a ~= Hangar.lastPage then Hangar.lastPage, Hangar.pageAt = a, now end
  if Hangar.phase == "walk" then
    if name == STANDBY then
      Hangar.phase = "standby"
      log("STANDBY: the lobby is up")
    end                                               -- (the presses: Hangar.walkFrame, every frame)
    if now - Hangar.t > 90 then
      log("STANDBY not reached within 90 s of the walk (on " .. tostring(name) .. ")")
      Hangar.t = now                                  -- (the pilot can still get there; the lobby works from STANDBY)
    end
  end
  -- every second, wherever the pilot is in the hangar: the loadout, the opponent's plane, the presses, SORTIE
  native("RVNG_LoSend")
  -- (the plan the user OK'd: changing the plane after readying un-readies the pilot): ready, then off STANDBY (editing)
  -- or a changed loadout sent: not ready any more (not once the launch is set: that is committed)
  local changes = native("RVNG_HgInfo", 12) or 0
  if Hangar.phase == "standby" and Ready.phase == "ready" and (native("RVNG_ReadyInfo", 2) or 0) >= 1 then
    if a and name ~= STANDBY then
      Ready.toggle(); Hangar.unreadies = (Hangar.unreadies or 0) + 1
      log("not ready any more: off STANDBY (" .. tostring(name) .. ")")
    elseif Hangar.loBase and changes > Hangar.loBase then
      Ready.toggle(); Hangar.unreadies = (Hangar.unreadies or 0) + 1
      log("not ready any more: the plane changed")
    end
  end
  if Hangar.phase == "standby" then Hangar.loBase = changes end
  showOpponent()
  native("RVNG_HgSortie", (Ready.bothReady and Ready.phase == "ready") and 1 or 0)
  local n = native("RVNG_HgInfo", 2) or 0
  if n > Hangar.presses then
    Hangar.presses = n
    local kind = native("RVNG_HgInfo", 3)
    if kind == 1 then Ready.sortie()
    elseif kind == 2 then Ready.toggle()
    elseif kind == 3 then Hangar.leave("the pilot left the lobby") return end
  end
  if name == STANDBY and Hangar.phase == "walk" then Hangar.phase = "standby" end
  Hangar.apply()
end

Tick.add(Hangar.step)
-- every frame too (the game rewrites a row's text on focus changes); counted, so a test can see it
-- The walk's presses, every frame (2026-11-21 12:5x: the 1 s tick and a 3 s gap made the walk ~20 s of flashing pages):
-- each page is pressed once, WALK_SETTLE_S after it became the active page (again only if it is still up 4 s later)
local WALK_SETTLE_S = 0.8
function Hangar.walkFrame()
  local a, name = Hangar.pageNow()
  if not a or name == STANDBY then return end
  local t = os.clock()
  if a ~= Hangar.walkPage then Hangar.walkPage, Hangar.walkSeen, Hangar.walkPressed = a, t, nil end
  if t - Hangar.walkSeen < WALK_SETTLE_S then return end
  if Hangar.walkPressed and t - Hangar.walkPressed < 4 then return end
  local row
  if name == TOP then row = rowOf(a, "SelectAircraft") or 0
  elseif name == SQUAD then row = rowOf(a, "Standby")
  elseif WALK_THROUGH[name] then row = -1 end
  if row then
    native("RVNG_PagePress", a, row)
    Hangar.walkPressed, Hangar.walkPresses = t, Hangar.walkPresses + 1
  end
end

-- (RVNG's one game-thread loop, rvng_tick.lua: never a loop of its own, so no Lua runs on two threads)
Tick.everyFrame(function()
  if Hangar.phase == "walk" then Hangar.walkFrame() end
  if Hangar.phase == "standby" then Hangar.frames = Hangar.frames + 1; Hangar.apply() end
end)
return Hangar
