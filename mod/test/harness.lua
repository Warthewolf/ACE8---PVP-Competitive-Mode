-- Runs mod/ProjectRVNG/Scripts/main.lua against stubbed UE4SS functions and a stub game adapter.
-- Usage: lua5.4 harness.lua <bridge dir>   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
local Json = require("json")

RVNG_BRIDGE = assert(arg[1], "bridge dir required") .. "/"

-- ---- controllable clock and UE4SS stubs ----
local clock = 1000
os.time = function() return clock end
local hooks, loop = {}, nil
Key = { F8 = "F8", F9 = "F9" }
function RegisterKeyBind() end
function RegisterHook(path, fn) hooks[path] = fn end
function LoopAsync(_, fn) loop = fn end
local params = {}
local function param(id, stats)
  local p = { IsValid = function() return true end, GetFName = function() return { ToString = function() return id end } end }
  for k, v in pairs(stats) do p[k] = v end
  return p
end
function FindAllOf() return params end
params[1] = param("f22a", { TODO_MaxSpeed = 2400, TODO_TurnRate = 30, TODO_HP = 100 })

-- ---- stub game adapter ----
-- Like UE4SS, every ctx:get() returns a NEW wrapper for the same object: only the address identifies it.
local me, opp, ai = { name = "me", addr = 0x1000 }, { name = "opp", addr = 0x2000 }, { name = "ai", addr = 0x3000 }
local function wrap(obj)
  if obj == nil then return nil end
  local w = { obj = obj, kind = obj.kind }
  function w:GetAddress() return obj.addr end
  function w:GetOwner() return wrap(obj.owner) end
  return w
end
local joins, roomResult = {}, nil
RVNG_GAME = {
  createRoom = function() return roomResult end,
  joinRoom = function(code) joins[#joins + 1] = code; return true end,
  isLocal = function(p) return p ~= nil and p.obj == me end,
  isOpponent = function(p) return p ~= nil and p.obj == opp end,
  key = function(p) return p:GetAddress() end,
  weaponKind = function(c) return c.kind end,
  aircraftIds = function() return "f22a", "su57" end,
  speeds = function() return 2300, 2350 end,
  endReason = function() return "kill_target" end,
}
dofile(here .. "/../ProjectRVNG/Scripts/main.lua")

local function hook(name) for path, fn in pairs(hooks) do if path:find(name, 1, true) then return fn end end error("no hook " .. name) end
local ctx = function(obj) return { get = function() return wrap(obj) end } end
local function writeState(t) local f = assert(io.open(RVNG_BRIDGE .. "state.json", "w")); f:write(Json.encode(t)); f:close() end
local function read(name) local f = io.open(RVNG_BRIDGE .. name, "r"); if not f then return nil end local s = f:read("a"); f:close(); return s end
local function check(cond, msg) if not cond then error("FAIL: " .. msg, 2) end print("ok - " .. msg) end
local function tick(sec) clock = clock + (sec or 1); loop() end

-- 1. Guest joins each match's room once, and never rejoins a finished match from a stale state.json.
writeState({ state = "matched", match = { id = "m1", state = "live", role = "guest", lobbyCode = "ROOM1" } })
tick(); tick()
check(#joins == 1 and joins[1] == "ROOM1", "guest joins ROOM1 exactly once")

hook("OnMatchStarted")()
tick(30)
params[1] = param("f22a", { TODO_MaxSpeed = 2600, TODO_TurnRate = 30, TODO_HP = 100 }) -- trainer switched on mid-match
tick(30)
params[1] = param("f22a", { TODO_MaxSpeed = 2400, TODO_TurnRate = 30, TODO_HP = 100 })
-- Kill attribution: credited to the instigator; a crash is a death without a kill; AI is ignored.
hook("ReceiveDamage")(ctx(opp), 40, ctx(me))
hook("AircraftPawn:OnDestroyed")(ctx(opp))
hook("AircraftPawn:OnDestroyed")(ctx(me))
hook("AircraftPawn:OnDestroyed")(ctx(ai))
hook("WeaponComponent:Fire")(ctx({ owner = me, kind = "mystery" }))
hook("WeaponComponent:Fire")(ctx({ owner = opp, kind = "gun" }))
clock = clock + 100
hook("OnMatchEnded")()
local result = Json.decode(read("result.json"))
check(result.matchId == "m1", "result written for m1")
check(result.durationSec == 160, "duration uses wall-clock seconds (got " .. tostring(result.durationSec) .. ")")
check(result.self.kills == 1 and result.self.deaths == 1 and result.opponent.kills == 0 and result.opponent.deaths == 1,
  "kills come from the instigator; crashes and AI add no kill")
local kinds = {}
for _, e in ipairs(result.events) do kinds[#kinds + 1] = e.type .. ":" .. e.actor end
local evs = table.concat(kinds, ",")
check(evs:find("special_fired:self", 1, true) ~= nil, "unknown weapon kinds are logged as special (fail closed)")
check(evs:find("gun_fired:opponent", 1, true) ~= nil, "gun fire is classified")
check(result.runtime.aircraft.f22a.maxSpeed == 2600 and result.runtime.aircraftMin.f22a.maxSpeed == 2400,
  "the highest and lowest live stat samples are reported")
check(result.telemetry.opponentMaxSpeed == 2350, "speed telemetry is sampled")

-- The companion still shows m1 as matched/live until it submits: no rejoin.
writeState({ state = "matched", match = { id = "m1", state = "live", role = "guest", lobbyCode = "ROOM1" } })
tick()
check(#joins == 1, "no stale rejoin of the finished match")
writeState({ state = "reported", match = { id = "m1", state = "awaiting_reports" } })
tick()
writeState({ state = "matched", match = { id = "m2", state = "live", role = "guest", lobbyCode = "ROOM2" } })
tick()
check(#joins == 2 and joins[2] == "ROOM2", "the next match's room is joined")

-- 1b. A trainer already on at match start and briefly off still shows: highest and lowest samples are kept,
--     not the sample furthest from the start value.
local function setStats(turn, hp) params[1] = param("f22a", { TODO_MaxSpeed = 2400, TODO_TurnRate = turn, TODO_HP = hp }) end
writeState({ state = "matched", match = { id = "m1b", state = "live", role = "guest", lobbyCode = "ROOM1B" } })
setStats(39, 50) -- turn rate up, HP down, before the match starts
tick()
hook("OnMatchStarted")()
tick(10); setStats(30, 100); tick(10); setStats(39, 50); tick(10); tick(10)
hook("OnMatchEnded")()
local r1b = Json.decode(read("result.json"))
check(r1b.matchId == "m1b" and r1b.runtime.aircraft.f22a.turnRate == 39 and r1b.runtime.aircraftMin.f22a.hp == 50,
  "tampered values present at match start are kept despite a clean sample")
setStats(30, 100)

-- 1c. An AI aircraft hit by the local pilot is destroyed; the opponent's next aircraft gets the same address
--     and crashes without being hit. That is a death without a kill, not a kill for the local pilot.
writeState({ state = "matched", match = { id = "m1a", state = "live", role = "guest", lobbyCode = "ROOM1A" } })
tick()
hook("OnMatchStarted")()
local drone = { name = "drone", addr = 0x4000 }
hook("ReceiveDamage")(ctx(drone), 40, ctx(me))
hook("AircraftPawn:OnDestroyed")(ctx(drone))
local oppAddr = opp.addr
opp.addr = drone.addr -- freed address reused
hook("AircraftPawn:OnDestroyed")(ctx(opp))
opp.addr = oppAddr
clock = clock + 60
hook("OnMatchEnded")()
local reuse = Json.decode(read("result.json"))
check(reuse.matchId == "m1a" and reuse.self.kills == 0 and reuse.opponent.deaths == 1,
  "a reused address does not inherit the attacker of a destroyed AI aircraft")
os.remove(RVNG_BRIDGE .. "result.json")

-- 2. An empty match log encodes events as a JSON array.
writeState({ state = "matched", match = { id = "m3", state = "live", role = "guest", lobbyCode = "ROOM3" } })
tick()
hook("OnMatchStarted")()
clock = clock + 40
hook("OnMatchEnded")()
check(read("result.json"):find('"events":[]', 1, true) ~= nil, "empty events encode as []")

-- 3. Host retries room creation until the game returns a room id.
os.remove(RVNG_BRIDGE .. "lobby.json")
writeState({ state = "matched", match = { id = "m4", state = "pending", role = "host" } })
roomResult = nil
tick()
check(read("lobby.json") == nil, "no lobby while the room could not be created")
tick(2)
roomResult = "R9"
tick(2)
check(read("lobby.json") == nil, "retries are spaced out")
tick(5)
local lobby = Json.decode(read("lobby.json") or "null")
check(lobby and lobby.matchId == "m4" and lobby.lobbyCode == "R9", "room created on retry and lobby.json written")
writeState({ state = "matched", match = { id = "m4", state = "live", role = "host", lobbyCode = "R9" } })
os.remove(RVNG_BRIDGE .. "lobby.json")
tick(10)
check(read("lobby.json") == nil, "no re-post once the server has the room code")
print("all mod checks passed")
