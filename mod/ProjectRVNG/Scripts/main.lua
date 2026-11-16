--[[
  Project RVNG - in-game mod (UE4SS Lua)

  Talks to the companion app (client/rvng.js run) through JSON files in
  <game root>/ProjectRVNG/bridge/. See docs/GAME_INTEGRATION.md.

  IMPORTANT: ACE COMBAT 8 has no public modding API. Every name in HOOKS and every
  function in GAME below is a placeholder that must be filled in from a UE4SS object
  dump (Live View / "Dump all objects"). Nothing here has been run against the retail
  game yet.
]]

local Json = require("json")

-- Path of the game root as seen from UE4SS's working directory (Binaries/Win64).
local BRIDGE = rawget(_G, "RVNG_BRIDGE") or "../../../ProjectRVNG/bridge/"

-- ===== Fill these in from a UE4SS object dump =====================================
local HOOKS = {
  -- Fired when the main menu widget is constructed: used to add the "Competitive 1v1" entry.
  MainMenuConstruct   = "/Script/TODO.MainMenuWidget:Construct",
  -- Sortie / match start, kill, damage, weapon, leave and match end events.
  MatchStart          = "/Script/TODO.MultiplayerGameMode:OnMatchStarted",
  AircraftDestroyed   = "/Script/TODO.AircraftPawn:OnDestroyed",
  DamageApplied       = "/Script/TODO.AircraftPawn:ReceiveDamage",
  WeaponFired         = "/Script/TODO.WeaponComponent:Fire",
  PlayerLeft          = "/Script/TODO.MultiplayerGameMode:OnPlayerLeft",   -- surrender / disconnect
  MatchEnd            = "/Script/TODO.MultiplayerGameMode:OnMatchEnded",
}
-- Class holding per-aircraft flight parameters (speed, turn rate, HP, ...).
local AIRCRAFT_PARAM_CLASS = "TODO_AircraftParameter"
-- Map from our stat names to the property names on AIRCRAFT_PARAM_CLASS.
local STAT_PROPS = { maxSpeed = "TODO_MaxSpeed", turnRate = "TODO_TurnRate", hp = "TODO_HP", stallSpeed = "TODO_StallSpeed" }
local GAME_VERSION = "TODO"   -- read from the build string once located

-- Every game-specific call goes through this table. RVNG_GAME exists only for the test harness
-- (mod/test/harness.lua); another script mod able to set it would itself fail the integrity scan.
local GAME = rawget(_G, "RVNG_GAME") or {
  -- Create a private 2-player room with these rules (time limit, kill target, special weapons).
  -- Return the joinable room id, or nil if the game is not ready yet (it is retried every few seconds).
  createRoom = function(rules) return nil end,
  -- Join a private room by id. Return true once the join has started.
  joinRoom = function(code) return false end,
  isLocal = function(pawn) return false end,          -- pawn belongs to the local pilot
  isOpponent = function(pawn) return false end,       -- pawn belongs to the other pilot (not AI)
  -- A stable identity for a game object. UE4SS hands every hook a new Lua wrapper for the same object, and
  -- table keys compare wrappers by reference, so the object's address is used instead.
  key = function(obj) return obj:GetAddress() end,
  -- "gun" | "missile" | "special" for a weapon component.
  weaponKind = function(component) return nil end,
  -- Aircraft ids of both pilots, as used in the baseline's aircraft stats.
  aircraftIds = function() return "TODO", "TODO" end,
  -- Current speeds (km/h) of both aircraft, or nil.
  speeds = function() return nil, nil end,
  -- "kill_target" | "time_limit" | "disconnect" | "surrender" from the MatchEnd hook context.
  endReason = function(ctx) return "kill_target" end,
}
-- ===================================================================================

local state = {
  match = nil,          -- latest server view of the open match (from state.json)
  lobby = nil,          -- host: { matchId, at, code } room creation for that match
  joinedMatchId = nil,  -- guest: the match whose room we joined
  doneMatchId = nil,    -- the match we already played and wrote a result for
  log = nil,
}

-- Wall-clock seconds. (os.clock() is CPU time and would make durations meaningless.)
local function now() return os.time() end

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
local RETRY_SEC = 5

-- Host: create the room once per match, retrying while the game is not ready, and re-post the code if the
-- server still has none a few seconds later (the companion keeps lobby.json until the server accepts it).
local function onMatched(match)
  state.match = match
  if match.role ~= "host" or match.lobbyCode then return end
  local l = state.lobby
  if l and l.matchId == match.id then
    if now() - l.at < RETRY_SEC then return end
    if l.code then
      writeJson("lobby.json", { matchId = match.id, lobbyCode = l.code }); l.at = now()
      return
    end
  end
  state.lobby = { matchId = match.id, at = now() }
  local ok, roomId = pcall(GAME.createRoom, match.rules)
  if ok and roomId then
    state.lobby.code = tostring(roomId)
    writeJson("lobby.json", { matchId = match.id, lobbyCode = state.lobby.code })
  end
end

-- Guest: join each match's room exactly once.
local function onLobbyReady(match)
  if match.role == "guest" and state.joinedMatchId ~= match.id then
    local ok, started = pcall(GAME.joinRoom, match.lobbyCode)
    if ok and started then state.joinedMatchId = match.id end
  end
end

-- ---- Match logging ------------------------------------------------------------------
local function logEvent(type_, actor, extra)
  if not state.log then return end
  local e = { t = now() - state.log.start, type = type_, actor = actor }
  if extra then for k, v in pairs(extra) do e[k] = v end end
  table.insert(state.log.events, e)
end

-- Keeps, per aircraft and stat, the lowest and the highest sampled value. The server compares both with the
-- baseline: a changed value is above or below it, so it shows up whenever it was active, also when a trainer
-- was already on at match start or switched off before the last sample. (The mod cannot know the baseline.)
local function sampleStats()
  local log = state.log
  if not log then return end
  for id, stats in pairs(collectAircraftStats()) do
    local lo, hi = log.minStats[id] or {}, log.maxStats[id] or {}
    for stat, v in pairs(stats) do
      if lo[stat] == nil or v < lo[stat] then lo[stat] = v end
      if hi[stat] == nil or v > hi[stat] then hi[stat] = v end
    end
    log.minStats[id], log.maxStats[id] = lo, hi
  end
  local okS, selfSpeed, oppSpeed = pcall(GAME.speeds)
  if okS then
    if type(selfSpeed) == "number" and selfSpeed > log.maxSpeedSelf then log.maxSpeedSelf = selfSpeed end
    if type(oppSpeed) == "number" and oppSpeed > log.maxSpeedOpp then log.maxSpeedOpp = oppSpeed end
  end
end

pcall(RegisterHook, HOOKS.MatchStart, function()
  if not state.match or state.match.id == state.doneMatchId then return end
  writeRuntime()
  state.log = {
    matchId = state.match.id, start = now(), events = Json.array(),
    self = { kills = 0, deaths = 0 }, opponent = { kills = 0, deaths = 0 },
    minStats = {}, maxStats = {}, maxSpeedSelf = 0, maxSpeedOpp = 0,
    lastHitBy = {}, -- object key -> side ("self"/"opponent") of whoever damaged it last
  }
  sampleStats()
end)

-- "self" / "opponent" for the two pilots' objects, nil for AI and everything else.
local function sideOf(obj)
  if obj == nil then return nil end
  if GAME.isLocal(obj) then return "self" end
  if GAME.isOpponent(obj) then return "opponent" end
  return nil
end
local function keyOf(obj)
  local ok, k = pcall(GAME.key, obj)
  return ok and k or nil
end

-- Kills are credited to whoever last damaged the victim, not inferred from the victim. The attacker's side
-- is resolved when the damage happens and stored under the victim's stable key.
pcall(RegisterHook, HOOKS.DamageApplied, function(ctx, _damage, instigator)
  if not state.log then return end
  local victim = ctx:get()
  local k = keyOf(victim)
  if k ~= nil then state.log.lastHitBy[k] = sideOf(instigator and instigator:get() or nil) end
  local hit = sideOf(victim)
  if hit then logEvent("hit", hit == "self" and "opponent" or "self") end
end)

pcall(RegisterHook, HOOKS.AircraftDestroyed, function(ctx)
  if not state.log then return end
  local pawn = ctx:get()
  -- Forget who last hit it, for every destroyed aircraft (AI too): the engine reuses a freed object's address,
  -- and a pilot's next aircraft at that address must not inherit the old attacker.
  local k = keyOf(pawn)
  local inst = k ~= nil and state.log.lastHitBy[k] or nil
  if k ~= nil then state.log.lastHitBy[k] = nil end
  local victim = sideOf(pawn)
  if not victim then return end -- AI or other non-pilot aircraft
  local killer = (victim == "self" and inst == "opponent" and "opponent")
              or (victim == "opponent" and inst == "self" and "self") or nil
  state.log[victim].deaths = state.log[victim].deaths + 1
  logEvent("death", victim)
  -- A crash or self-destruct is a death without a kill.
  -- TODO: if the game credits the last attacker for crashes, mirror its rule here.
  if killer then
    state.log[killer].kills = state.log[killer].kills + 1
    logEvent("kill", killer)
  end
end)

-- Unknown weapon kinds are logged as special weapons (fail closed when special weapons are banned).
local WEAPON_EVENT = { gun = "gun_fired", missile = "missile_fired", special = "special_fired" }
pcall(RegisterHook, HOOKS.WeaponFired, function(ctx)
  if not state.log then return end
  local comp = ctx:get()
  local owner = comp:GetOwner()
  local actor = GAME.isLocal(owner) and "self" or (GAME.isOpponent(owner) and "opponent") or nil
  if not actor then return end
  local ok, kind = pcall(GAME.weaponKind, comp)
  logEvent(WEAPON_EVENT[ok and kind or ""] or "special_fired", actor)
end)

pcall(RegisterHook, HOOKS.PlayerLeft, function(ctx)
  if not state.log then return end
  local p = ctx:get()
  logEvent("disconnect", GAME.isLocal(p) and "self" or "opponent")
end)

pcall(RegisterHook, HOOKS.MatchEnd, function(ctx)
  local log = state.log
  if not (log and state.match and state.match.id == log.matchId) then return end
  sampleStats()
  local selfAc, oppAc = GAME.aircraftIds()
  local okR, reason = pcall(GAME.endReason, ctx)
  writeJson("result.json", {
    matchId = log.matchId,
    gameVersion = GAME_VERSION,
    durationSec = now() - log.start,
    endReason = okR and reason or "kill_target",
    self = { aircraftId = selfAc, kills = log.self.kills, deaths = log.self.deaths },
    opponent = { aircraftId = oppAc, kills = log.opponent.kills, deaths = log.opponent.deaths },
    events = log.events,
    telemetry = { selfMaxSpeed = log.maxSpeedSelf, opponentMaxSpeed = log.maxSpeedOpp },
    runtime = { aircraft = log.maxStats, aircraftMin = log.minStats },
  })
  state.doneMatchId = log.matchId
  state.log, state.lobby = nil, nil
end)

-- ---- Poll the companion ---------------------------------------------------------------
local function poll()
  local s = readJson("state.json")
  -- Act only on an open match we have not played yet. The companion keeps showing a finished match
  -- as "matched" for a moment (until its result is submitted), which must not trigger a rejoin.
  if s and s.state == "matched" and type(s.match) == "table" and s.match.id ~= state.doneMatchId
    and (s.match.state == "pending" or s.match.state == "live") then
    onMatched(s.match)
    if s.match.lobbyCode then onLobbyReady(s.match) end
  end
  sampleStats()
end

LoopAsync(1000, function()
  poll()
  return false -- keep looping
end)

print("[ProjectRVNG] loaded")
