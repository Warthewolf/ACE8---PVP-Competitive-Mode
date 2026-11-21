--[[
  rvng_menu.lua : RVNG's changes to the game's main menu.
  - ACE COMBAT STORE ("Shop") comes off (the user, 2026-11-18: "Remove the Online and Store from the menu").
  - ACE COMBAT ONLINE ("Online") becomes RVNG's own row, COMPETITIVE 1V1, in the same place (2026-11-19): its CommandID,
    texts and StringArgs are rewritten. The DLL (dlls/main.dll) answers the texts RVNG_Menu_Title / RVNG_Menu_Help and
    takes a press on StringArgs "RVNG_1v1"; a press here asks the companion app to queue (Menu.onPick, set by main.lua).
    Without the DLL's two hooks (RVNG_MenuReady() ~= 1) the row comes off instead, as before.
  Both are changes to the game's in-memory copy of DT_LiveMenuMainTopCommands, the way Survival Mode changes rows (RVNG's
  own code; the files on disk are never changed):
    - the table is found, or loaded through the engine's soft-reference loader, on RVNG's game-thread tick;
    - it is pinned (added to the GameInstance's ReferencedObjects) so it stays loaded with the changes, and the menu
      never builds from a fresh copy;
    - every tick looks again, so a copy the game reloads gets them too.
  QUIT GAME and the other rows stay.
]]
local Menu = { removed = {}, repurposed = 0, picks = 0, pinned = false, table = nil, onPick = nil }
local Tick = require("rvng_tick")

local TABLE = "/Game/Datatables/UI/Menu/MainMenu/Top/DT_LiveMenuMainTopCommands.DT_LiveMenuMainTopCommands"
Menu.HIDE = { "Shop" }                        -- ACE COMBAT STORE
Menu.ROW = "Online"                           -- ACE COMBAT ONLINE: becomes COMPETITIVE 1V1 (or comes off)
Menu.ARGS = "RVNG_1v1"
Menu.COMMAND = "Main_Top_RVNG1v1"
Menu.TITLE, Menu.HELP = "RVNG_Menu_Title", "RVNG_Menu_Help"

local function say(msg)
  print("[ProjectRVNG] menu: " .. msg .. "\n")
  if type(rawget(_G, "RVNG_Log")) == "function" then RVNG_Log("menu: " .. msg) end
end

local function live(o)
  if o == nil then return false end
  local ok, v = pcall(function() return o:IsValid() end)
  return ok and v == true
end

local function native(name, ...)
  local f = rawget(_G, name)
  if type(f) ~= "function" then return nil end
  local ok, v = pcall(f, ...)
  return ok and v or nil
end

-- the table, if it is in memory; else loaded (game thread only), at most every 5 s while it can't be
local lastLoad = -100
local function findTable(n)
  local ok, dt = pcall(StaticFindObject, TABLE)
  if ok and live(dt) then return dt end
  if n - lastLoad < 5 then return nil end
  lastLoad = n
  local okK, ks = pcall(StaticFindObject, "/Script/Engine.Default__KismetSystemLibrary")
  if not (okK and live(ks)) then return nil end
  local okL, loaded = pcall(function()
    return ks:LoadAsset_Blocking(ks:Conv_SoftObjPathToSoftObjRef(ks:MakeSoftObjectPath(TABLE)))
  end)
  if okL and live(loaded) then return loaded end
  return nil
end

local gi
local function gameInstance()
  if live(gi) then return gi end
  for _, cls in ipairs({ "BP_LiveGameInstance_C", "LiveGameInstance", "GameInstance" }) do
    local ok, o = pcall(FindFirstOf, cls)
    if ok and live(o) then gi = o; return o end
  end
  return nil
end

local function pin(dt)
  local g = gameInstance()
  if not g then return false end
  local ok, err = pcall(function()
    local arr = g.ReferencedObjects
    arr[#arr + 1] = dt
  end)
  say(ok and "the main menu's table pinned (kept loaded)" or ("the main menu's table could not be pinned: " .. tostring(err)))
  return ok
end

local function str(v)
  if v == nil then return nil end
  local ok, s = pcall(function() return v:ToString() end)
  if ok then return s end
  return type(v) == "string" and v or nil
end

local function takeOff(dt, row)
  pcall(function() dt:RemoveRow(row) end)
  local _, still = pcall(function() return dt:FindRow(row) end)
  Menu.removed[row] = (Menu.removed[row] or 0) + 1
  say(string.format("'%s' %s the main menu%s", row, still == nil and "taken off" or "could NOT be taken off",
    Menu.removed[row] > 1 and " (again: the table was reloaded)" or ""))
end

-- ONLINE -> COMPETITIVE 1V1 (true when the row is RVNG's now)
local function repurpose(dt)
  local okF, row = pcall(function() return dt:FindRow(Menu.ROW) end)
  if not okF or row == nil then return false end
  if str(row.StringArgs) == Menu.ARGS then return true end
  if native("RVNG_MenuReady") ~= 1 then takeOff(dt, Menu.ROW); return false end
  local ok, err = pcall(function()
    row.CommandID = FName(Menu.COMMAND)
    row.TitleTextID = Menu.TITLE
    row.HelpTextID = Menu.HELP
    row.StringArgs = Menu.ARGS
  end)
  local args, title = str(row.StringArgs), str(row.TitleTextID)
  if ok and args == Menu.ARGS and title == Menu.TITLE then
    Menu.repurposed = Menu.repurposed + 1
    say(string.format("'%s' is RVNG's COMPETITIVE 1V1 row now%s", Menu.ROW,
      Menu.repurposed > 1 and " (again: the table was reloaded)" or ""))
    return true
  end
  say(string.format("'%s' could not be rewritten (%s; StringArgs %s, TitleTextID %s): taken off instead", Menu.ROW,
    tostring(err), tostring(args), tostring(title)))
  takeOff(dt, Menu.ROW)
  return false
end

function Menu.tick(n)
  -- a press on COMPETITIVE 1V1 (the DLL took it; game thread here)
  local picks = native("RVNG_MenuPicks")
  if picks and picks > Menu.picks then
    Menu.picks = picks
    say("COMPETITIVE 1V1 pressed: queueing")
    if Menu.onPick then
      local ok, err = pcall(Menu.onPick)
      if not ok then say("the queue request failed: " .. tostring(err)) end
    end
  end
  local dt = findTable(n)
  if not dt then return end
  local a = dt:GetAddress()
  if Menu.table ~= a then                     -- (a new copy: pin it, and the changes go in again)
    Menu.table, Menu.pinned = a, false
  end
  if not Menu.pinned then Menu.pinned = pin(dt) end
  for _, row in ipairs(Menu.HIDE) do
    local okF, have = pcall(function() return dt:FindRow(row) end)
    if okF and have ~= nil then takeOff(dt, row) end
  end
  repurpose(dt)
end

Tick.add(Menu.tick)
return Menu
