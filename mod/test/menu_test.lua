-- Runs mod/ProjectRVNG/Scripts/rvng_menu.lua against a fake main-menu table (stub UE4SS objects).
-- Usage: lua5.4 menu_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
RVNG_TICK_SYNC = true
local _print = print
print = function() end

local TABLE = "/Game/Datatables/UI/Menu/MainMenu/Top/DT_LiveMenuMainTopCommands.DT_LiveMenuMainTopCommands"
local function newRow(args) return { StringArgs = args, TitleTextID = "x", HelpTextID = "y", CommandID = "z" } end
local function fakeTable(addr)
  local t = { rows = { Campaign = newRow("c"), Online = newRow("o"), Shop = newRow("s"), System = newRow("y"), QuitGame = newRow("q") }, addr = addr }
  function t:IsValid() return true end
  function t:GetAddress() return self.addr end
  function t:FindRow(name) return self.rows[name] end
  function t:RemoveRow(name) self.rows[name] = nil end
  return t
end
function FName(s) return s end

local inMemory, loads, referenced, logs
local gi = { IsValid = function() return true end }
function FindFirstOf(cls) if cls == "BP_LiveGameInstance_C" then return gi end end
local ks = { IsValid = function() return true end }
function ks:MakeSoftObjectPath(p) return p end
function ks:Conv_SoftObjPathToSoftObjRef(p) return p end
function ks:LoadAsset_Blocking(p) loads = loads + 1; if p == TABLE then inMemory = inMemory or fakeTable(0x100) end; return inMemory end
function StaticFindObject(path)
  if path == TABLE then return inMemory end
  if path == "/Script/Engine.Default__KismetSystemLibrary" then return ks end
end
RVNG_Log = function(s) logs[#logs + 1] = s end
local loopFn
function LoopAsync(_, fn) loopFn = fn end

local function fresh()
  inMemory, loads, referenced, logs = nil, 0, {}, {}
  gi.ReferencedObjects = referenced
  for _, m in ipairs({ "rvng_tick", "rvng_menu" }) do package.loaded[m] = nil end
  local Tick = require("rvng_tick")
  local Menu = require("rvng_menu")
  Tick.start(1000)
  return Menu
end
local function logged(s) for _, l in ipairs(logs) do if l:find(s, 1, true) then return true end end end

-- 1. without the DLL's row hooks: ONLINE and STORE both come off (as before 0.2.8)
RVNG_MenuReady, RVNG_MenuPicks = nil, nil
local Menu = fresh()
loopFn()
assert(loads == 1 and inMemory ~= nil, "a table that isn't in memory is loaded")
assert(inMemory.rows.Online == nil and inMemory.rows.Shop == nil, "no hooks: Online and Shop are taken off")
assert(inMemory.rows.Campaign and inMemory.rows.System and inMemory.rows.QuitGame, "Campaign, System and Quit Game stay")
assert(#referenced == 1 and referenced[1] == inMemory, "the table is pinned once")
loopFn(); loopFn()
assert(#referenced == 1 and loads == 1, "no second pin and no reload while it stays in memory")
assert(Menu.removed.Online == 1 and Menu.removed.Shop == 1, "each row taken off once")
inMemory = fakeTable(0x200)                                  -- the game reloads the table
loopFn()
assert(inMemory.rows.Online == nil and inMemory.rows.Shop == nil and #referenced == 2, "a reloaded copy loses them again, pinned")
assert(logged("again: the table was reloaded"), "the reload is logged")

-- 2. with the hooks: STORE comes off, ONLINE becomes COMPETITIVE 1V1 in place; a press queues
local picks = 0
RVNG_MenuReady = function() return 1 end
RVNG_MenuPicks = function() return picks end
Menu = fresh()
local queued = 0
Menu.onPick = function() queued = queued + 1 end
loopFn()
local row = inMemory.rows.Online
assert(inMemory.rows.Shop == nil, "hooks: Shop taken off")
assert(row and row.StringArgs == "RVNG_1v1" and row.TitleTextID == "RVNG_Menu_Title" and row.HelpTextID == "RVNG_Menu_Help"
  and row.CommandID == "Main_Top_RVNG1v1", "hooks: ONLINE rewritten as COMPETITIVE 1V1, in place")
assert(Menu.repurposed == 1 and (Menu.removed.Online or 0) == 0, "rewritten once, not taken off")
loopFn()
assert(Menu.repurposed == 1, "not rewritten again while it stays RVNG's")
picks = 1; loopFn()
assert(queued == 1 and Menu.picks == 1, "a press queues once")
loopFn()
assert(queued == 1, "no second queue without a second press")
inMemory = fakeTable(0x300)
loopFn()
assert(inMemory.rows.Online.StringArgs == "RVNG_1v1" and Menu.repurposed == 2, "a reloaded copy gets the row again")

-- 3. a row that won't take the new strings comes off instead
Menu = fresh()
local stubborn = setmetatable({}, { __newindex = function() error("read-only") end, __index = function() return "o" end })
inMemory = fakeTable(0x400); inMemory.rows.Online = stubborn
loopFn()
assert(inMemory.rows.Online == nil and logged("could not be rewritten"), "an unwritable row is taken off")

print = _print
print("all menu checks passed")
