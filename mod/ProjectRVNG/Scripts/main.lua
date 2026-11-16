--[[
  Project RVNG - in-game mod (UE4SS Lua)

  Talks to the companion app (client/rvng.js run) through JSON files in
  <game root>/ProjectRVNG/bridge/. See docs/GAME_INTEGRATION.md.

  IMPORTANT: ACE COMBAT 8 has no public modding API. Every name in HOOKS below is a
  placeholder that must be replaced with the real class/function paths found by
  dumping the game with UE4SS (Live View / "Dump all objects"). Nothing here has
  been run against the retail game yet.
]]

local Json = require("json")

-- Path of the game root as seen from UE4SS's working directory (Binaries/Win64).
local BRIDGE = "../../../ProjectRVNG/bridge/"

-- ===== Fill these in from a UE4SS object dump =====================================
local HOOKS = {
  -- Fired when the main menu widget is constructed: used to add the "Competitive 1v1" entry.
  MainMenuConstruct   = "/Script/TODO.MainMenuWidget:Construct",
  -- Creates a private / custom online room. Must return or expose a joinable room id.
  CreatePrivateRoom   = "/Script/TODO.OnlineSessionSubsystem:CreatePrivateRoom",
  JoinPrivateRoom     = "/Script/TODO.OnlineSessionSubsystem:JoinRoomById",
  -- Sortie / match start, kill, damage and match end events.
  MatchStart          = "/Script/TODO.MultiplayerGameMode:OnMatchStarted",
  AircraftDestroyed   = "/Script/TODO.AircraftPawn:OnDestroyed",
  DamageApplied       = "/Script/TODO.AircraftPawn:ReceiveDamage",
  WeaponFired         = "/Script/TODO.WeaponComponent:Fire",
  MatchEnd            = "/Script/TODO.MultiplayerGameMode:OnMatchEnded",
}
-- Class holding per-aircraft flight parameters (speed, turn rate, HP, ...).
local AIRCRAFT_PARAM_CLASS = "TODO_AircraftParameter"
-- Map from our stat names to the property names on AIRCRAFT_PARAM_CLASS.
local STAT_PROPS = { maxSpeed = "TODO_MaxSpeed", turnRate = "TODO_TurnRate", hp = "TODO_HP", stallSpeed = "TODO_StallSpeed" }
local GAME_VERSION = "TODO"   -- read from the build string once located
-- ===================================================================================

local state = { phase = "idle", match = nil, log = nil, maxSpeedSelf = 0, maxSpeedOpp = 0 }

local function now() return os.clock() end

local function readJson(name)
  local f = io.open(BRIDGE .. name, "r")
  if not f then return nil end
  local s = f:read("a"); f:close()
  local ok, data = pcall(Json.decode, s)
  return ok and data or nil
end

local function writeJson(name, data)
  local tmp = BRIDGE .. name .. ".tmp"
  local f = assert(io.open(tmp, "w"))
  f:write(Json.encode(data)); f:close()
  os.remove(BRIDGE .. name)
  os.rename(tmp, BRIDGE .. name)
end

-- Reads the live flight parameters of every loaded aircraft for the integrity check.
local function collectAircraftStats()
  local out = {}
  local params = FindAllOf(AIRCRAFT_PARAM_CLASS) or {}
  for _, p in ipairs(params) do
    if p:IsValid() then
      local id = p:GetFName():ToString()
      local s = {}
      for stat, prop in pairs(STAT_PROPS) do
        local ok, v = pcall(function() return p[prop] end)
        if ok and type(v) == "number" then s[stat] = v end
      end
      out[id] = s
    end
  end
  return out
end

local function writeRuntime()
  writeJson("runtime.json", { gameVersion = GAME_VERSION, aircraft = collectAircraftStats(), at = os.time() })
end

-- ---- Main menu entry ----------------------------------------------------------------
-- Until the menu widget is hooked, F8 = queue, F9 = cancel.
local function requestQueue()
  writeRuntime()
  writeJson("request.json", { action = "queue" })
  print("[ProjectRVNG] queue requested")
end
RegisterKeyBind(Key.F8, requestQueue)
RegisterKeyBind(Key.F9, function() writeJson("request.json", { action = "cancel" }) end)

pcall(RegisterHook, HOOKS.MainMenuConstruct, function(ctx)
  -- TODO: add a "COMPETITIVE 1v1" button to the menu that calls requestQueue().
end)

-- ---- Lobby: host creates the room, guest joins it ------------------------------------
local function onMatched(match)
  if state.match and state.match.id == match.id then return end
  state.match = match
  if match.role == "host" and not match.lobbyCode then
    -- TODO: call the game's private-room creation with match.rules applied
    -- (time limit, kill target, 2 player slots, special weapons on/off).
    local roomId = nil -- = CreatePrivateRoom(...)
    if roomId then writeJson("lobby.json", { matchId = match.id, lobbyCode = tostring(roomId) }) end
  end
end

local function onLobbyReady(match)
  if match.role == "guest" and state.phase ~= "joined" then
    state.phase = "joined"
    -- TODO: JoinPrivateRoom(match.lobbyCode)
  end
end

-- ---- Match logging ------------------------------------------------------------------
local function logEvent(type_, actor, extra)
  if not state.log then return end
  local e = { t = now() - state.log.start, type = type_, actor = actor }
  if extra then for k, v in pairs(extra) do e[k] = v end end
  table.insert(state.log.events, e)
end

pcall(RegisterHook, HOOKS.MatchStart, function()
  if not state.match then return end
  writeRuntime()
  state.log = { start = now(), events = {}, self = { kills = 0, deaths = 0 }, opponent = { kills = 0, deaths = 0 } }
  state.maxSpeedSelf, state.maxSpeedOpp = 0, 0
end)

-- TODO: resolve whether the destroyed aircraft belongs to the local player.
local function isLocal(pawn) return false end

pcall(RegisterHook, HOOKS.AircraftDestroyed, function(ctx)
  if not state.log then return end
  local victimLocal = isLocal(ctx:get())
  local killer = victimLocal and "opponent" or "self"
  local victim = victimLocal and "self" or "opponent"
  state.log[killer].kills = state.log[killer].kills + 1
  state.log[victim].deaths = state.log[victim].deaths + 1
  logEvent("kill", killer)
  logEvent("death", victim)
end)

pcall(RegisterHook, HOOKS.WeaponFired, function(ctx)
  logEvent("missile_fired", isLocal(ctx:get():GetOwner()) and "self" or "opponent")
end)

pcall(RegisterHook, HOOKS.MatchEnd, function()
  if not (state.log and state.match) then return end
  writeJson("result.json", {
    matchId = state.match.id,
    gameVersion = GAME_VERSION,
    durationSec = now() - state.log.start,
    endReason = "kill_target", -- TODO: map from the game's end reason
    self = { aircraftId = "TODO", kills = state.log.self.kills, deaths = state.log.self.deaths },
    opponent = { aircraftId = "TODO", kills = state.log.opponent.kills, deaths = state.log.opponent.deaths },
    events = state.log.events,
    telemetry = { selfMaxSpeed = state.maxSpeedSelf, opponentMaxSpeed = state.maxSpeedOpp },
  })
  state.log, state.match, state.phase = nil, nil, "idle"
end)

-- ---- Poll the companion ---------------------------------------------------------------
LoopAsync(1000, function()
  local s = readJson("state.json")
  if s and s.match then
    if s.state == "matched" then onMatched(s.match) end
    if s.match.lobbyCode then onLobbyReady(s.match) end
  end
  -- TODO: sample both aircraft's current speed here to fill telemetry max speeds.
  return false -- keep looping
end)

print("[ProjectRVNG] loaded")
