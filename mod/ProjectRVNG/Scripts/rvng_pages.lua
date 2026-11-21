--[[
  rvng_pages.lua : RVNG's menu pages inside the game's main menu (2026-11-19; the user: "MULTIPLAYER > RANKED 1v1,
  CASUAL 1v1 > LOBBY").

  The game has no free menu page RVNG could open, so the pages are drawn in the main menu itself: its header, its five
  command rows and its description line are rewritten (the game's own LiveLocalizeTextBlocks inside WBP_Menu_MainTop_000,
  found by the autotest's ui_scan suite), the way some mods draw pages in the stock pause menu. The game's own cursor,
  highlight, sounds and confirm keep working; while a page is up the DLL takes every confirm press (RVNG_MenuPage(1))
  and reports the selected row (RVNG_MenuPress), and this module decides what it does. B / Esc on a page is the page's
  BACK (the DLL turns on the main menu's cancel while a page is up and takes it; the user's choice, 2026-11-19).

    main         the stock main menu; RVNG's row reads MULTIPLAYER (the DLL's text); a press opens:
    multiplayer  RANKED 1V1 / CASUAL 1V1 / BACK
    lobby        the queue and the ready-up (rvng_ready.lua): status, READY UP (n/2), LEAVE LOBBY
    result       after the match: the result, PLAY AGAIN, BACK
  The texts are written every frame while a page is up (rvng_tick.lua's game-thread loop, Tick.everyFrame), so they
  hold when the game rewrites the description for the row under the cursor. Leaving the pages puts every text back.
]]
local Pages = { page = "main", mode = "ranked", presses = nil, onQueue = nil, onCancel = nil, onLeave = nil }
local Tick = require("rvng_tick")
local Ready = require("rvng_ready")

local ROWS = 5
Ready.drawWidgets = false                             -- (the pages draw the lobby and the result from Ready.want)
Ready.atMainMenu = function() return Pages.findWidgets() end

local function native(name, ...)
  local f = rawget(_G, name)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  if ok then return v end
  return nil
end

local function ascii(s) return (tostring(s or ""):gsub("[^\32-\126]", "?")) end

-- ---- the main menu's widgets -----------------------------------------------------------------------------------------
local W = { header = nil, help = nil, rows = {}, orig = nil }
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
local function haveAll()
  if not (valid(W.header) and valid(W.help)) then return false end
  for i = 1, ROWS do if not valid(W.rows[i]) then return false end end
  return true
end
-- the main menu on screen (after a match the old one can still exist for a while): its object name, or nil (and the
-- object, W.topObj)
local function liveTop()
  local ok, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
  if not ok or type(tops) ~= "table" then return nil end
  local any
  for _, t in ipairs(tops) do
    if valid(t) then
      local okN, n = pcall(function() return t:GetFullName() end)
      local name = okN and type(n) == "string" and n:match("(WBP_Menu_MainTop_000_C_%d+)") or nil
      if name then
        -- on screen: in the viewport, or inside another widget (the game's menu sits in its manager's layer); an
        -- old menu after a travel is detached
        local okV, inVp = pcall(function() return t:IsInViewport() end)
        local okP, parent = pcall(function() return t:GetParent() end)
        if (okV and inVp == true) or (okP and valid(parent)) then W.topObj = t; return name end
        if not any then any, W.topObj = name, t end
      end
    end
  end
  return any
end

function Pages.findWidgets()
  if haveAll() then return true end
  if type(rawget(_G, "FindAllOf")) ~= "function" or rawget(_G, "FText") == nil then return false end
  local top = liveTop()
  if not top then return false end
  local ok, all = pcall(FindAllOf, "LiveLocalizeTextBlock")
  if not ok or type(all) ~= "table" then return false end
  local header, help, rows = nil, nil, {}
  for _, o in ipairs(all) do
    local okN, n = pcall(function() return o:GetFullName() end)
    if okN and type(n) == "string" and n:find("." .. top .. ".", 1, true) and valid(o) then
      if n:find("%.Header%.WidgetTree_%d+%.WBP_Menu_Text_000%.WidgetTree_%d+%.Text_Body$") then header = o
      elseif n:find("%.HelpText%.WidgetTree_%d+%.WBP_Menu_Text_001%.WidgetTree_%d+%.Text_Body$") then help = o
      else
        -- (each row holds several text blocks; the one drawn is TextWidget's Text_Body, as the ui_scan suite found)
        local r = n:match("%.CommandList%..-WBP_Menu_Text_Focus_000_0(%d)%.WidgetTree_%d+%.TextWidget%.WidgetTree_%d+%.Text_Body$")
        if r then rows[tonumber(r)] = o end
      end
    end
  end
  for i = 1, ROWS do if not rows[i] then return false end end
  if not (header and help) then return false end
  if W.header ~= header then W.orig = nil end                  -- (a new menu: its own texts are the originals)
  W.header, W.help, W.rows, W.top = header, help, rows, top
  return true
end
-- once a second: the cached widgets still belong to the menu on screen (else found again)
local function recheckTop()
  if W.top and liveTop() ~= W.top then W.header, W.help, W.rows, W.top, W.orig = nil, nil, {}, nil, nil end
end

-- what the screen shows now: the header and the five rows (for the self-test)
function Pages.screen()
  if not Pages.findWidgets() then return nil end
  local t = { textOf(W.header) }
  for i = 1, ROWS do t[#t + 1] = textOf(W.rows[i]) or "?" end
  return table.concat(t, " | ")
end

function Pages.helpText() return Pages.findWidgets() and textOf(W.help) or nil end

-- the stock texts, kept when a page first covers them
local function capture()
  if W.orig then return end
  W.orig = { header = textOf(W.header), rows = {} }
  for i = 1, ROWS do W.orig.rows[i] = textOf(W.rows[i]) end
end
local function restore()
  if not (W.orig and haveAll()) then W.orig = nil; return end
  setText(W.header, W.orig.header or "MAIN MENU")
  for i = 1, ROWS do setText(W.rows[i], W.orig.rows[i] or "") end
  W.orig = nil
end

-- ---- the pages' contents ---------------------------------------------------------------------------------------------
local MODE = { ranked = "RANKED 1V1", casual = "CASUAL 1V1" }
function Pages.view()
  local p = Pages.page
  if p == "multiplayer" then
    return "MULTIPLAYER", { "RANKED 1V1", "CASUAL 1V1", "", "", "BACK" },
      "Ranked: rated matches on the RVNG ladder.  Casual: unrated matches."
  elseif p == "lobby" then
    local w = Ready.want or {}
    local status = w[2] or "SEARCHING..."
    local opp = (Ready.phase ~= "off" and Ready.phase ~= "searching") and ("VS " .. ascii(Ready.opponent or "?")) or MODE[Pages.mode]
    return "LOBBY", { opp, status, "", "", "LEAVE LOBBY" }, w[3] or ("Joining the " .. Pages.mode .. " queue...")
  elseif p == "result" then
    local w = Ready.want or {}
    return "MATCH RESULT", { w[2] or "", "PLAY AGAIN", "", "", "BACK" }, w[3] or ""
  end
  return nil
end

-- the page into the widgets (every frame while a page is up)
function Pages.apply()
  if Pages.page == "main" then return end
  if not Pages.findWidgets() then Pages.shown = false; return end
  capture()
  local header, rows, help = Pages.view()
  if not header then return end
  setText(W.header, ascii(header))
  for i = 1, ROWS do setText(W.rows[i], ascii(rows[i] or "")) end
  setText(W.help, ascii(help))
  Pages.shown = true
end

-- the cursor onto row (1..5), by the menu's own SetSelectedIndex (the highlight and its refresh are the game's)
function Pages.select(row)
  if not (Pages.findWidgets() and W.topObj) then return false end
  local okA, a = pcall(function() return W.topObj:GetAddress() end)
  return okA and type(a) == "number" and native("RVNG_MenuSelect", a, row - 1) == 1
end

function Pages.open(name)
  if name == Pages.page then return end
  local from = Pages.page
  Pages.page = name
  if name == "main" then
    native("RVNG_MenuPage", 0)                   -- (the stock rows' presses back to the game)
    local back = nil
    if Pages.findWidgets() and W.orig then
      for i = 1, ROWS do if W.orig.rows[i] == "MULTIPLAYER" then back = i end end
      restore()
    end
    if back then Pages.select(back) end          -- (back on MULTIPLAYER, not on whatever row BACK was)
  else
    native("RVNG_MenuPage", 1)                   -- (every press is RVNG's while a page is up)
    Pages.apply()
    if from ~= name then Pages.select(name == "lobby" and 2 or 1) end   -- (the first row that does something)
  end
end

-- a confirm press on row (1..5) while a page is up
function Pages.press(row)
  local p = Pages.page
  if p == "multiplayer" then
    if row == 1 or row == 2 then
      Pages.mode = row == 1 and "ranked" or "casual"
      if Pages.onQueue then pcall(Pages.onQueue, Pages.mode) end
      Pages.open("lobby")
    elseif row == 5 then
      Pages.open("main")
    end
  elseif p == "lobby" then
    if row == 2 then
      Ready.toggle()
    elseif row == 5 then
      if Ready.searching() then
        if Pages.onCancel then pcall(Pages.onCancel) end
      elseif Ready.phase ~= "off" and Ready.phase ~= "launched" then
        if Pages.onLeave then pcall(Pages.onLeave) end
      end
      Ready.reset()
      Pages.open("multiplayer")
    end
  elseif p == "result" then
    if row == 2 then
      Ready.reset()
      if Pages.onQueue then pcall(Pages.onQueue, Pages.mode) end
      Pages.open("lobby")
    elseif row == 5 then
      Ready.reset()
      Pages.open("main")
    end
  end
end

-- B / Esc while a page is up (the DLL turns on the main menu's cancel there and takes it; the stock main menu has none):
-- the page's BACK row (LEAVE LOBBY in the lobby)
function Pages.back()
  if Pages.page ~= "main" then Pages.press(5) end
end

-- the stock main menu's RVNG row (MULTIPLAYER) was pressed
function Pages.openMultiplayer() Pages.open("multiplayer") end

-- back from the hangar lobby (rvng_hangar.lua's leave): the MULTIPLAYER page, as LEAVE LOBBY on the main menu goes there; the
-- main menu is still loading, so the cursor goes onto RANKED 1V1 once its widgets are up
function Pages.backFromHangar()
  Pages.page = "main"
  Pages.pendingOpen = "multiplayer"     -- (opened by Pages.step once the new main menu is on screen)
end
-- the main menu on screen now (in the viewport or inside the menu manager's layer, as liveTop; an old one still in
-- memory after a travel is detached). (IsInViewport alone is false for the game's menu: run of 13:08)
local function topOnScreen()
  local ok, tops = pcall(FindAllOf, "WBP_Menu_MainTop_000_C")
  for _, t in ipairs(ok and type(tops) == "table" and tops or {}) do
    if valid(t) then
      local okV, inVp = pcall(function() return t:IsInViewport() end)
      local okP, parent = pcall(function() return t:GetParent() end)
      if (okV and inVp == true) or (okP and valid(parent)) then return true end
    end
  end
  return false
end

-- the hangar lobby takes over (rvng_hangar.lua): the main menu goes with the travel, so its texts aren't put back and every
-- press is the game's again
function Pages.stepAside()
  Pages.page = "main"
  native("RVNG_MenuPage", 0)
  W.orig = nil
end

-- RVNG's tick: presses taken by the DLL, and the page following the match's progress
function Pages.step()
  recheckTop()
  if Pages.pendingOpen then
    local m = native("RVNG_LastMap") or ""
    if type(m) == "string" and m:find("PL_MainMenu", 1, true) and topOnScreen() then
      local p = Pages.pendingOpen
      Pages.pendingOpen = nil
      W.header, W.help, W.rows, W.top, W.orig = nil, nil, {}, nil, nil   -- (this menu's own widgets, found again)
      Pages.open(p)
    end
  end
  local n = native("RVNG_MenuPress", 0)
  if type(n) == "number" then
    if Pages.presses == nil then Pages.presses = n end
    if n > Pages.presses then
      Pages.presses = n
      local row = native("RVNG_MenuPress", 1)
      if type(row) == "number" and row >= 0 and Pages.page ~= "main" then Pages.press(row + 1) end
    end
  end
  local c = native("RVNG_MenuPress", 2)                -- (B / Esc taken on a page; one BACK per tick)
  if type(c) == "number" then
    if Pages.cancels == nil then Pages.cancels = c end
    if c > Pages.cancels then
      Pages.cancels = c
      Pages.back()
    end
  end
  if Ready.phase == "launched" and Pages.page ~= "main" then
    Pages.page = "main"                               -- (the menu goes with the travel; the result page comes back)
    native("RVNG_MenuPage", 0)
    W.orig = nil
  end
  if Ready.phase == "result" and Pages.page ~= "result" then Pages.open("result") end
  Pages.apply()
end

Tick.add(Pages.step)
-- every frame as well (the game rewrites the description for the row under the cursor); counted, so a test can see it
Pages.frames = 0
-- (RVNG's one game-thread loop, rvng_tick.lua: never a loop of its own, so no Lua runs on two threads)
Tick.everyFrame(function()
  if Pages.page ~= "main" then Pages.frames = Pages.frames + 1; Pages.apply() end
end)
return Pages
