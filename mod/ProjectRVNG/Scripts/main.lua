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
local Ready = require("rvng_ready")       -- the ready-up screen (both pilots ready, then both launch at once)
local Hangar = require("rvng_hangar")     -- the lobby in the stock hangar (STANDBY: READY UP, SORTIE, the opponent's plane)

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
-- (the game version: the companion takes Steam's build id of the install; the mod sends none)
local GAME_VERSION = nil

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

-- The stats check (rvng_stats.lua, docs/re/STATS.md): the game's combat tables as fingerprints, read in the
-- background (a slice of STATS_SLICE_S each tick, paused while a match is armed), a new pass every STATS_EVERY_S, each
-- written to runtime.json. A clean install's first pass is what `rvng baseline` takes.
local Stats = require("rvng_stats")
local STATS_SLICE_S, STATS_EVERY_S = 0.04, 120
local stats = { job = nil, last = nil, nextAt = 0, passes = 0 }
RVNG_STATS_STATE = stats                                 -- (the in-game self-test reads it)
local function writeRuntime()
  writeJson("runtime.json", { gameVersion = GAME_VERSION, aircraft = collectAircraftStats(), stats = stats.last, at = os.time() })
end
local function statsDone(res)
  stats.last, stats.job, stats.passes = res, nil, stats.passes + 1
  stats.nextAt = os.time() + STATS_EVERY_S
  writeRuntime()
  print(string.format("[ProjectRVNG] stats pass %d: %d planes, %d parts, %d values, %d ms in %d slices\n", stats.passes,
    res.groups.PlaneDataMap_.count, res.groups.PartsDataMap_.count, res.leaves, res.ms, res.slices))
end
-- In a match (a normal install's armed match, or a test's deathmatch map): no menu pass. Instead the in-match pass
-- reads the tables the last menu pass found not loaded (the online weapon and durability tables load with the match),
-- in slices of STATS_MATCH_SLICE_S, once per match: runtime_match.json, and the match's result carries it.
local STATS_MATCH_SLICE_S = 0.005
local function inMatch()
  local f = rawget(_G, "RVNG_MatchInfo")
  if type(f) == "function" and f(2) ~= 0 then return true end
  local m = type(rawget(_G, "RVNG_LastMap")) == "function" and RVNG_LastMap() or nil
  return type(m) == "string" and m:find("PL_DM_", 1, true) ~= nil
end
local function matchTables()
  local only, n = {}, 0
  for _, g in ipairs(Stats.GROUPS) do
    local seen = stats.last and stats.last.groups[g.name]
    if g.optional and (not seen or seen.missing) then only[g.name] = true; n = n + 1 end
  end
  return only, n
end
local function matchTick()
  if stats.matchDone then return end
  if not stats.matchJob then
    local only, n = matchTables()
    if n == 0 then stats.matchDone = true; return end
    stats.matchJob = Stats.new(nil, { only = only })
    if not stats.matchJob then return end
  end
  if stats.matchJob:step(STATS_MATCH_SLICE_S) then
    local res = stats.matchJob.res
    stats.match, stats.matchJob, stats.matchDone = res, nil, true
    writeJson("runtime_match.json", { stats = res, at = os.time() })
    local read = {}
    for name, g in pairs(res.groups) do if not g.missing then read[#read + 1] = name .. " " .. g.count end end
    table.sort(read)
    print(string.format("[ProjectRVNG] stats in the match: %s (%d ms in %d slices)\n",
      #read > 0 and table.concat(read, ", ") or "none loaded", res.ms, res.slices))
  end
end
local function statsTick()
  if inMatch() then return matchTick() end
  if stats.matchDone or stats.matchJob then             -- (out of the match: the next one reads its tables again)
    stats.matchDone, stats.matchJob = false, nil
  end
  if not stats.job then
    if os.time() < stats.nextAt then return end
    stats.job = Stats.new()
    if not stats.job then return end                    -- (the manager isn't there yet: next tick)
  end
  if stats.job:step(STATS_SLICE_S) then statsDone(stats.job.res) end
end
-- before a queue: a pass must be there (the first one finished at once if it isn't yet: one pause, on the menu)
local function statsReady()
  if stats.last then return end
  stats.job = stats.job or Stats.new()
  if stats.job and stats.job:step(nil) then statsDone(stats.job.res) end
end

-- ---- Main menu entry ----------------------------------------------------------------
-- COMPETITIVE 1V1 on the main menu queues (rvng_menu.lua, below); F8 = queue and F9 = cancel stay as keys.
local function requestQueue(mode)
  pcall(statsReady)
  writeRuntime()
  writeJson("request.json", { action = "queue", mode = mode })   -- (mode: "ranked" | "casual"; nil = the companion's)
  print("[ProjectRVNG] queue requested" .. (mode and (" (" .. mode .. ")") or ""))
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

-- ---- The two PCs' link (the native runtime's link.h: Steam, relay-only) ----------------------
-- Each pilot's mod posts this PC's SteamID for the match (link.json; the companion sends it to the server, which shows
-- it only to the opponent). Once the opponent's is there, the native runtime starts the link: the host is player 1,
-- the guest player 2, the match id is its tag (a message from another match is dropped).
local function onLink(match)
  if type(rawget(_G, "RVNG_LinkSelf")) ~= "function" then return end   -- (no native runtime)
  local L = state.link
  if not L or L.matchId ~= match.id then
    L = { matchId = match.id, at = nil, started = false }
    state.link = L
  end
  local me = RVNG_LinkSelf()
  if type(me) ~= "string" or me == "" then return end             -- (Steam not up yet: the next poll)
  local link = type(match.link) == "table" and match.link or {}
  if link.self ~= me and (not L.at or now() - L.at >= RETRY_SEC) then
    writeJson("link.json", { matchId = match.id, steamId = me })   -- (a string: 17 digits don't fit a Lua number)
    L.at = now()
  end
  if not L.started and type(link.peer) == "string" and link.peer ~= "" then
    local player = match.role == "host" and 1 or 2
    local opp = match.role == "host" and match.guest or match.host
    local oppName = type(opp) == "table" and type(opp.name) == "string" and opp.name or nil
    local mine = match.role == "host" and match.host or match.guest
    local myName = type(mine) == "table" and type(mine.name) == "string" and mine.name or nil
    if RVNG_LinkStart(link.peer, player, match.id) == 1 then
      L.started = true
      -- (the opponent's name in the match itself: the copy's name, from the server's match like the lobby's)
      if type(rawget(_G, "RVNG_OppName")) == "function" then RVNG_OppName(oppName or "") end
      Ready.begin(oppName, myName)                                -- (the ready-up screen: rvng_ready.lua)
      Hangar.start()                                              -- (both PCs into the hangar: rvng_hangar.lua)
      print(string.format("[ProjectRVNG] link to the opponent started as player %d\n", player))
    end
  end
end

-- ---- The native deathmatch's result, for the leaderboard (runtime 0.4.4, matchstats.h) ----------------------------
-- The match is the game's own deathmatch on the two PCs. At its end (time-up, or the forced end after a lost link) the
-- runtime has both scores (the host's ScoreUpdates make them the same on both PCs) and both pilots' deaths (each counted
-- from the death messages both PCs handle); in a 1v1 a pilot's kills are the other's deaths. Written once per match as
-- result.json, for the server match the link was started for; the companion sends it (POST /api/matches/:id/report).
local function nativeResult()
  if type(rawget(_G, "RVNG_MatchStat")) ~= "function" then return end
  local n = RVNG_MatchStat(0)
  if state.statsSeen == nil then state.statsSeen = n end
  if n <= state.statsSeen then return end
  state.statsSeen = n
  local L = state.link
  if not (L and L.matchId) or state.doneMatchId == L.matchId then return end
  local myDeaths, oppDeaths = RVNG_MatchStat(1), RVNG_MatchStat(2)
  local events = Json.array()
  for i = 0, RVNG_MatchStat(5) - 1 do
    local t, who = tostring(RVNG_MatchEvent(i) or ""):match("^([%d%.]+),(%d)$")
    t = tonumber(t)
    if t and who == "1" then
      events[#events + 1] = { t = t, type = "kill", actor = "self" }
      events[#events + 1] = { t = t, type = "death", actor = "opponent" }
    elseif t then
      events[#events + 1] = { t = t, type = "kill", actor = "opponent" }
      events[#events + 1] = { t = t, type = "death", actor = "self" }
    end
  end
  local myPlane = type(rawget(_G, "RVNG_HgInfo")) == "function" and RVNG_HgInfo(13) or -1
  local oppPlane = type(rawget(_G, "RVNG_HgInfo")) == "function" and RVNG_HgInfo(8) or -1
  writeJson("result.json", {
    matchId = L.matchId,
    format = "native_dm",                            -- (the game's own deathmatch: decided by score at time-up)
    gameVersion = GAME_VERSION,
    runtimeVersion = RVNG_Version(),
    durationSec = RVNG_MatchStat(3),
    endReason = RVNG_MatchStat(4) == 1 and "disconnect" or "time_limit",
    self = { aircraftId = tostring(myPlane), kills = oppDeaths, deaths = myDeaths, score = (RVNG_ResultInfo(1) or 0) / 10 },
    opponent = { aircraftId = tostring(oppPlane), kills = myDeaths, deaths = oppDeaths, score = (RVNG_ResultInfo(2) or 0) / 10 },
    events = events,
    stats = stats.match,                             -- (the in-match pass: the tables the match loaded, when it finished)
  })
  state.doneMatchId = L.matchId
  print(string.format("[ProjectRVNG] the match's result written for the leaderboard (%s)\n", tostring(L.matchId)))
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
  if state.link and state.link.started and type(rawget(_G, "RVNG_LinkStop")) == "function" then RVNG_LinkStop() end
end)

-- ---- Poll the companion ---------------------------------------------------------------
local function poll()
  nativeResult()                                      -- (a native match just ended: its result.json)
  local s = readJson("state.json")
  -- Act only on an open match we have not played yet. The companion keeps showing a finished match
  -- as "matched" for a moment (until its result is submitted), which must not trigger a rejoin.
  if s and s.state == "matched" and type(s.match) == "table" and s.match.id ~= state.doneMatchId
    and (s.match.state == "pending" or s.match.state == "live") then
    onMatched(s.match)
    onLink(s.match)
    if s.match.lobbyCode then onLobbyReady(s.match) end
  end
  Ready.queue(s)                                     -- (SEARCHING while queued: rvng_ready.lua)
  sampleStats()
end

-- Everything runs on RVNG's one game-thread tick, once a second (rvng_tick.lua: Lua must not run on UE4SS's async
-- thread and the game thread at once).
local Tick = require("rvng_tick")
Tick.add(poll)
Tick.add(function() pcall(statsTick) end)

-- The native runtime's always-on tick: the web gates stay shut and the boot menu's login is ended (rvng_native.lua)
require("rvng_native")

-- RVNG's main menu (rvng_menu.lua): ACE COMBAT STORE taken off, ACE COMBAT ONLINE turned into COMPETITIVE 1V1, whose
-- press queues (as F8; on the game thread)
local Menu = require("rvng_menu")
-- RVNG's pages (rvng_pages.lua): MULTIPLAYER > RANKED 1V1 / CASUAL 1V1 > LOBBY (the ready-up) > the match > the result.
-- A press on the main menu's MULTIPLAYER row opens them; on a page the DLL takes every press and the pages decide.
local Pages = require("rvng_pages")
Menu.onPick = function() Pages.openMultiplayer() end
Pages.onQueue = function(mode) requestQueue(mode) end
Pages.onCancel = function() writeJson("request.json", { action = "cancel" }) end
Hangar.onStart = function() Pages.stepAside() end      -- (the main menu goes with the travel into the hangar)
Hangar.onLeave = function()                            -- (LEAVE THE HANGAR / QUIT MISSION / the opponent gone)
  Ready.reset()
  Pages.backFromHangar()                               -- (back on MULTIPLAYER, ready to queue again)
  if type(rawget(_G, "RVNG_LinkStop")) == "function" then RVNG_LinkStop() end
  writeJson("request.json", { action = "cancel" })
end
Pages.onLeave = function()                             -- (leaving the lobby after a match was found: the link ends)
  if type(rawget(_G, "RVNG_LinkStop")) == "function" then RVNG_LinkStop() end
  writeJson("request.json", { action = "cancel" })
end
-- both pilots ready: both PCs launch into the match at the agreed time
Ready.onLaunch = function()
  Hangar.stop()                                         -- (first: it puts the hangar's mission context back)
  local ok = type(rawget(_G, "RVNG_TravelDM")) == "function" and RVNG_TravelDM() == 1
  if not ok then
    -- (0.4.1: a normal install arms the match itself, from the link: the DLL refuses only without the link up or with a
    -- match hook or piece missing, and its log says which)
    print("[ProjectRVNG] the launch could not start the match travel (see RVNG_*.log)\n")
  end
end

-- The native runtime's in-game test logger (docs/IN_GAME_TESTS.md); a no-op without dlls/main.dll or rvng_test.ini.
require("rvng_probe")

Tick.start(1000)
print("[ProjectRVNG] loaded")
