-- Runs mod/ProjectRVNG/Scripts/rvng_native.lua against a stub RVNG_Tick (no game, no DLL).
-- Usage: lua5.4 native_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
RVNG_TICK_SYNC = true
local _print = print
print = function() end

-- without the DLL: nothing ticks
local Native = require("rvng_native")
assert(Native.ticks == 0 and Native.ended == 0, "no RVNG_Tick: the module does nothing")
package.loaded["rvng_native"] = nil

local looked, giAddrs, ended = 0, {}, 0
local gi = { IsValid = function() return true end, GetAddress = function() return 0x1234 end }
function FindFirstOf(cls) looked = looked + 1; if cls == "BP_LiveGameInstance_C" then return gi end end
function RVNG_Tick(addr) giAddrs[#giAddrs + 1] = addr; if #giAddrs == 3 then ended = 1 end; return ended end
local loopFn
function LoopAsync(_, fn) loopFn = fn end
local Tick = require("rvng_tick")
Native = require("rvng_native")
Tick.start(1000)

loopFn(); loopFn(); loopFn()
assert(Native.ticks == 3, "one RVNG_Tick per tick")
assert(giAddrs[1] == 0x1234 and giAddrs[3] == 0x1234, "the GameInstance's address is handed over")
assert(looked == 1, "the GameInstance is looked up once")
assert(Native.ended == 1, "the DLL's count of ended logins is kept")

print = _print
print("all native tick checks passed")
