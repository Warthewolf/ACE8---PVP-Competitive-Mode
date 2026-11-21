--[[
  rvng_ready.lua : the ready-up screen (2026-11-19, the user: "a ready up screen so both players launch into the match
  at the same time").

  Once RVNG's matchmaker has paired two pilots and the native link to the opponent is starting (main.lua's onLink), the
  main menu's COMPETITIVE 1V1 row becomes the ready-up screen: its title and the menu's description line show the
  opponent, both pilots' ready state and, once both are ready, the countdown. A press on the row toggles this pilot's
  ready (until the launch is set). The native link (link.h) carries each side's ready flag; when both are ready and the
  guest's clock is synced, the host sends LAUNCH for LAUNCH_MS later, and both PCs launch into the match at that moment
  on their own clocks, aligned by the link (within milliseconds; checked offline). The start gate's GO then lines up
  the match itself, however long each PC takes to load.

  Runs on RVNG's game-thread tick (rvng_tick.lua, once a second). Ready.onLaunch is called once, at the launch time
  (main.lua / the self-test set it). Without the native runtime this module does nothing.
]]
local Ready = { phase = "off", launched = false, opponent = nil, onLaunch = nil, onEnd = nil, toggles = 0, lastTitle = nil,
                drawWidgets = true,                 -- (false once rvng_pages.lua draws the pages from Ready.want)
                -- (the hangar lobby, rvng_hangar.lua: the launch waits for a SORTIE press too, the link's ready flag 2)
                needSortie = false, sorties = 0 }
local Tick = require("rvng_tick")

Ready.LAUNCH_MS = 5000

local function native(name, ...)
  local f = rawget(_G, name)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  if ok then return v end
  return nil
end

-- menu texts are drawn by the game from RVNG's text hook as 8-bit characters: keep them printable ASCII
local function ascii(s)
  return (tostring(s or ""):gsub("[^\32-\126]", "?"))
end

-- The main menu's own text widgets (found 2026-11-19 by the autotest's ui_scan suite): the header ("MAIN MENU"), the
-- COMPETITIVE 1V1 row and the description line are LiveLocalizeTextBlocks inside WBP_Menu_MainTop_000. The screen is
-- written into them (SetText) every tick, so it shows at once and comes back when the game rewrites the description for
-- another row; reset() puts the original texts back. The DLL's row texts (RVNG_MenuText) are set too, for a menu built
-- while the screen is up.
local W = { header = nil, row = nil, help = nil, orig = {} }
local function valid(o)
  if o == nil then return false end
  local ok, v = pcall(function() return o:IsValid() end)
  return ok and v == true
end
local function textOf(o)
  local ok, t = pcall(function() return o:GetText():ToString() end)
  return ok and t or nil
end
local function setText(o, t)
  if not valid(o) or textOf(o) == t then return end
  pcall(function() o:SetText(FText(t)) end)
end
local function findWidgets()
  if valid(W.header) and valid(W.row) and valid(W.help) then return true end
  if type(rawget(_G, "FindAllOf")) ~= "function" or rawget(_G, "FText") == nil then return false end
  local ok, all = pcall(FindAllOf, "LiveLocalizeTextBlock")
  if not ok or type(all) ~= "table" then return false end
  local header, row, help
  for _, o in ipairs(all) do
    local okN, n = pcall(function() return o:GetFullName() end)
    if okN and type(n) == "string" and n:find("WBP_Menu_MainTop_000_C", 1, true) and valid(o) then
      if n:find(".Header.", 1, true) then header = o
      elseif n:find(".HelpText.", 1, true) then help = o
      elseif n:find(".CommandList.", 1, true) then
        local t = textOf(o)
        if t == "COMPETITIVE 1V1" or t == "MULTIPLAYER" or (t and t == W.rowText) then row = o end
      end
    end
  end
  if header and row and help then
    W.header, W.row, W.help = header, row, help
    W.orig.header = W.orig.header or textOf(header)
    return true
  end
  return false
end
-- the screen into the widgets (every tick while it is up)
function Ready.apply()
  if not Ready.want or not Ready.drawWidgets then return end
  if not findWidgets() then Ready.widgets = false; return end
  Ready.widgets = true
  setText(W.header, Ready.want[1]); setText(W.row, Ready.want[2]); setText(W.help, Ready.want[3])
  W.rowText = Ready.want[2]
end

local function show(title, help, header)
  Ready.want = { ascii(header or "READY UP"), ascii(title), ascii(help) }
  Ready.apply()
  if title == Ready.lastTitle and help == Ready.lastHelp then return end
  Ready.lastTitle, Ready.lastHelp = title, help
  if Ready.drawWidgets then native("RVNG_MenuText", ascii(title), ascii(help)) end
end

-- the queue (the companion's state.json, every poll from main.lua): SEARCHING with the time waited; a press on the
-- row cancels (main.lua); a match found hands over to the ready-up screen (begin), anything else puts the row back
function Ready.queue(s)
  local st = type(s) == "table" and s.state or nil
  if st == "queued" or st == "scanning" or st == "waiting" then
    if Ready.phase ~= "off" and Ready.phase ~= "searching" and Ready.phase ~= "left" and Ready.phase ~= "result" then return end
    if Ready.phase ~= "searching" then Ready.phase, Ready.searchAt = "searching", os.time() end
    local t = os.time() - Ready.searchAt
    show(string.format("SEARCHING  %d:%02d", t // 60, t % 60),
      st == "queued" and string.format("Looking for an opponent (%s).  Press to cancel.", s.mode == "casual" and "casual" or "ranked")
        or "Checking the game files before queueing...  Press to cancel.", "SEARCHING")
  elseif Ready.phase == "searching" then
    Ready.reset()
  end
end
function Ready.searching() return Ready.phase == "searching" end

-- this pilot is on the ready-up screen (a press on the row then means ready / not ready)
function Ready.active()
  return Ready.phase == "connecting" or Ready.phase == "ready"
end

-- the link to the opponent has started (main.lua) or, on one PC, the self-test's stand-in peer
-- (myName: this pilot's RVNG name from the server's match, for the hangar's FLIGHT panel; nil keeps the game's callsign)
function Ready.begin(opponentName, myName)
  Ready.phase, Ready.launched, Ready.opponent, Ready.toggles = "connecting", false, opponentName or "your opponent", 0
  Ready.me = type(myName) == "string" and myName ~= "" and myName or nil
  Ready.resultBase, Ready.result = native("RVNG_ResultInfo", 0) or 0, nil   -- (only this match's result is shown)
  Ready.lastTitle, Ready.lastHelp = nil, nil
  native("RVNG_LinkReady", 0)
end

-- a press on COMPETITIVE 1V1 during the ready-up screen
function Ready.toggle()
  if Ready.phase ~= "ready" then return false end
  local mine = (native("RVNG_ReadyInfo", 2) or 0) >= 1
  native("RVNG_LinkReady", mine and 0 or 1)
  Ready.toggles = Ready.toggles + 1
  return true
end

-- SORTIE in the hangar lobby: only once both pilots are ready (the DLL refuses the press before); the ready flag 2 rides
-- on the pings and the host launches both PCs
function Ready.sortie()
  if Ready.phase ~= "ready" or not Ready.bothReady then return false end
  native("RVNG_LinkReady", 2)
  Ready.sorties = Ready.sorties + 1
  return true
end

-- back to the plain MULTIPLAYER row (after the match, or when the pilot queues again). (It read COMPETITIVE 1V1 before the
-- pages; writing that name back left the row misnamed and BACK unable to find it for the cursor: found 2026-11-19)
function Ready.reset()
  Ready.phase, Ready.launched, Ready.lastTitle, Ready.lastHelp, Ready.want = "off", false, nil, nil, nil
  native("RVNG_LinkReady", 0)
  native("RVNG_MenuText", "", "")
  if findWidgets() then                               -- (the menu's own texts back; the description comes back with focus)
    setText(W.header, W.orig.header or "MAIN MENU"); setText(W.row, "MULTIPLAYER"); setText(W.help, "")
  end
  W.rowText = nil
end

local function finish(phase, title, help, header)
  Ready.phase = phase
  show(title, help, header)
  if Ready.onEnd then pcall(Ready.onEnd, phase) end
end

-- the result screen: back at the main menu after the match, the scores both planes had at time-up (the native runtime
-- reads them with the game's own TotalScore; on the guest the host's ScoreUpdates set them), until the next press
local function resultStep()
  local n = native("RVNG_ResultInfo", 0) or 0
  if n <= (Ready.resultBase or 0) then return end
  if not (Ready.atMainMenu or findWidgets)() then return end   -- (still in the match, or the menu not built yet)
  local mine, theirs = (native("RVNG_ResultInfo", 1) or -1) / 10, (native("RVNG_ResultInfo", 2) or -1) / 10
  local verdict = mine > theirs and "VICTORY" or mine < theirs and "DEFEAT" or "DRAW"
  Ready.phase, Ready.result = "result", { mine = mine, theirs = theirs, verdict = verdict }
  show(string.format("%s  %d - %d", verdict, math.floor(mine), math.floor(theirs)),
    string.format("vs %s.  Final score: you %d, %s %d.  Press to queue again.", Ready.opponent, math.floor(mine),
      Ready.opponent, math.floor(theirs)), "MATCH RESULT")
end

function Ready.step()
  if Ready.phase == "left" or Ready.phase == "result" then Ready.apply() return end   -- (until the next press)
  if Ready.phase == "launched" then resultStep() return end
  if Ready.phase == "off" then return end
  local I = function(k) return native("RVNG_ReadyInfo", k) or -1 end
  -- the launch, once agreed, is committed: the countdown runs out on this PC's clock even if the link drops now
  local launchLeft = I(6)
  if I(7) == 1 then
    Ready.launched, Ready.phase = true, "launched"
    show("LAUNCHING", "Launching into the match against " .. Ready.opponent .. ".", "LAUNCHING")
    if Ready.onLaunch then pcall(Ready.onLaunch) end
    return
  end
  if I(5) ~= 0 and launchLeft >= 0 then
    Ready.phase = "launching"
    show(string.format("LAUNCHING IN %d", math.floor(launchLeft / 1000) + 1),
      "Both pilots ready. Launching into the match against " .. Ready.opponent .. ".", "LAUNCHING")
    return
  end
  local st = I(0)
  if st == 3 or st == 4 then                          -- lost or closed before the launch
    finish("left", "MULTIPLAYER", Ready.opponent .. " left before the match. Press to queue again.", "MAIN MENU")
    return
  end
  if st ~= 2 then
    show("CONNECTING...", "Match found: " .. Ready.opponent .. ". Connecting through Steam's relays...", "MATCH FOUND")
    return
  end
  if Ready.phase == "connecting" then Ready.phase = "ready" end
  local mine, theirs = I(2) >= 1, I(3) >= 1
  Ready.bothReady = mine and theirs
  Ready.sortied = I(2) == 2 or I(3) == 2
  -- the host: both ready and the guest's clock synced: LAUNCH for both PCs
  -- (the hangar lobby: also a SORTIE press on either PC)
  if I(1) == 1 and mine and theirs and I(4) == 1 and I(5) == 0 and (not Ready.needSortie or Ready.sortied) then
    native("RVNG_LinkLaunch", Ready.LAUNCH_MS)
  end
  local n = (mine and 1 or 0) + (theirs and 1 or 0)
  show(mine and string.format("READY (%d/2)", n) or string.format("READY UP (%d/2)", n),
    string.format("vs %s.  You: %s.  %s: %s.  Press to %s.", Ready.opponent, mine and "READY" or "not ready",
      Ready.opponent, theirs and "READY" or "not ready", mine and "cancel ready" or "ready up"))
end

Tick.add(Ready.step)
return Ready
