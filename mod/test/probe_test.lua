-- Runs mod/ProjectRVNG/Scripts/rvng_probe.lua and rvng_tick.lua against stubbed UE4SS functions and stub RVNG_*
-- functions (the DLL's). Usage: lua5.4 probe_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path

local loops, binds = {}, {}
Key = { F6 = "F6" }
ModifierKey = { CONTROL = "CONTROL" }
function LoopAsync(ms, fn) loops[#loops + 1] = { ms = ms, fn = fn } end
function RegisterKeyBind(key, mods, fn) binds[#binds + 1] = { key = key, mods = mods, fn = fn } end
local valid = true
local giObj = { IsValid = function() return valid end, GetAddress = function() return 0x7ff600001000 end }
local finds = 0
function FindFirstOf(cls) finds = finds + 1; if cls == "BP_LiveGameInstance_C" then return giObj end end

local function load()
  package.loaded["rvng_probe"], package.loaded["rvng_tick"] = nil, nil
  loops, binds = {}, {}
  local probe = require("rvng_probe")
  return probe, require("rvng_tick")
end

-- 0. The tick on the game thread: the async function queues one job and runs nothing itself.
do
  RVNG_TICK_SYNC = nil
  local queued = {}
  ExecuteInGameThread = function(fn) queued[#queued + 1] = fn end
  RVNG_ProbeOn = nil
  local _, Tick = load()
  local ran = 0
  Tick.add(function() ran = ran + 1 end)
  assert(Tick.start(250) and #loops == 1 and loops[1].ms == 250, "one async loop")
  assert(loops[1].fn() == false and #queued == 1 and ran == 0, "the async function only queues the job")
  loops[1].fn()
  assert(#queued == 1, "no second job while one waits")
  queued[1]()
  assert(ran == 1, "the job runs the tick functions")
  assert(not Tick.start(250) and #loops == 1, "started once")
end

RVNG_TICK_SYNC = true
ExecuteInGameThread = function(fn) fn() end

-- 1. No DLL: the probe adds nothing.
RVNG_ProbeOn = nil
do
  local probe, Tick = load()
  Tick.start(1000)
  loops[1].fn()
  assert(probe.watched == 0 and #binds == 0, "without the DLL the probe does nothing")
end

-- 2. DLL present, probe off.
RVNG_ProbeOn = function() return 0 end
do
  local probe, Tick = load()
  Tick.start(1000)
  loops[1].fn()
  assert(probe.watched == 0 and #binds == 0, "probe=0 does nothing")
end

-- 3. Probe on: each tick passes the GameInstance's address, found once; Ctrl+F6 arms on the next tick.
local watched, armed, watchAnswer = {}, 0, 0
RVNG_ProbeOn = function() return 1 end
RVNG_Watch = function(a) watched[#watched + 1] = a; return watchAnswer end
RVNG_ArmDM = function() armed = armed + 1; return 1 end
do
  local probe, Tick = load()
  assert(Tick.start(1000) and loops[1].ms == 1000, "a 1 s tick")
  assert(loops[1].fn() == false, "the loop keeps going")
  loops[1].fn()
  assert(#watched == 2 and watched[1] == 0x7ff600001000 and watched[2] == 0x7ff600001000, "the GameInstance's address is watched")
  assert(finds == 1, "the GameInstance is looked up once while it stays valid")
  valid = false
  loops[1].fn()
  assert(finds == 4 and watched[3] == 0, "an invalid GameInstance is looked up again (all three class names), and 0 is passed when none is found")
  assert(#binds == 1 and binds[1].key == "F6" and binds[1].mods[1] == "CONTROL", "Ctrl+F6 is bound")
  binds[1].fn()
  assert(armed == 0, "the key only sets a flag")
  loops[1].fn()
  assert(armed == 1, "Ctrl+F6 arms the deathmatch test on the next tick")
  watchAnswer = 1
  loops[1].fn()
  assert(probe.offlineBad == 1 and probe.watched == 5, "a NOT OFFLINE answer is counted")
end

print("all probe checks passed")
