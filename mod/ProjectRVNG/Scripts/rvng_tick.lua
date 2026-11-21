--[[
  rvng_tick.lua : the one game-thread tick all of RVNG's Lua runs on (the pattern is Survival Mode's sv_main.lua loop,
  copied and trimmed).

  UE4SS 3.0.1 runs LoopAsync's function on its own thread, in this mod's single Lua state, with no lock against the game
  thread, and Lua isn't safe on two threads at once. Survival found that the hard way: heap corruption, and a crash on a
  tester's launch. So the async function only reads a few upvalues and the clock and queues ONE prebuilt job with
  ExecuteInGameThread. That happens only when no job is waiting or running, and the last one ended a moment ago. A job
  that never ran is queued again after 10 s, then after twice as long each time.
  The job runs every function added with Tick.add(fn), each under pcall, on the game thread.

  RVNG_TICK_SYNC (the Lua tests only) makes LoopAsync's function run the job itself, with no game thread to queue onto.
]]
local Tick = {}
local fns = {}
local waiting, running, queuedAt, doneAt, lostAfter, runs, count = false, false, 0, -math.huge, 0, 0, 0
local TICK_LOST_S, SETTLE_S = 10, 0.02
local osClock, inGameThread = os.clock, ExecuteInGameThread

local function job()                               -- (the game thread)
  runs = runs + 1
  running = true
  lostAfter = 0
  count = count + 1
  for i = 1, #fns do
    local ok, err = pcall(fns[i], count)
    if not ok then pcall(print, "[ProjectRVNG] tick error: " .. tostring(err) .. "\n") end
  end
  doneAt = osClock()
  waiting = false
  running = false
end

function Tick.add(fn) fns[#fns + 1] = fn end

-- Every frame (the menus' texts: rvng_pages.lua, rvng_hangar.lua), on the same game-thread loop as the tick. One loop
-- for all of RVNG: since 2026-11-21 nothing of RVNG's Lua runs on UE4SS's async thread (the crash below)
local frameFns = {}
function Tick.everyFrame(fn) frameFns[#frameFns + 1] = fn end
Tick.frames = 0

function Tick.start(ms)
  if Tick.started then return false end
  if rawget(_G, "RVNG_TICK_SYNC") then
    if type(LoopAsync) ~= "function" then return false end
    Tick.started = true
    LoopAsync(ms, function() job() for i = 1, #frameFns do pcall(frameFns[i]) end return false end)
    return true
  end
  -- The game thread's own loop (2026-11-21): the tick every `ms` and the per-frame functions, all on the game thread.
  -- The hangar lobby's run of 11:16 aborted inside UE4SS between two ticks: by then two per-frame loops ran Lua on the
  -- game thread every frame while LoopAsync's function (below) ran Lua on UE4SS's thread in the same Lua state, which
  -- Lua isn't safe for (docs/re/HANGAR.md, run 8). LoopAsync stays only as the fallback without this function.
  if type(rawget(_G, "LoopInGameThreadAfterFrames")) == "function" then
    Tick.started, Tick.mode = true, "frames"
    local nextAt = 0
    LoopInGameThreadAfterFrames(1, function()
      Tick.frames = Tick.frames + 1
      for i = 1, #frameFns do pcall(frameFns[i]) end
      local t = osClock()
      if t >= nextAt then
        nextAt = t + ms / 1000
        job()
      end
      return false
    end)
    return true
  end
  if type(LoopAsync) ~= "function" then return false end
  Tick.mode = "async"
  if type(inGameThread) ~= "function" then return false end
  Tick.started = true
  LoopAsync(ms, function()                         -- (UE4SS's async thread: the flags, the clock and the queueing only)
    if running then return false end
    local seen = runs
    local t = osClock()
    local la = lostAfter
    if waiting then
      if la == 0 then la = TICK_LOST_S; lostAfter = la end
      if t - queuedAt < la then return false end
    elseif t - doneAt < SETTLE_S then
      return false
    end
    if running or runs ~= seen then return false end   -- (a job started since the first look)
    if waiting then lostAfter = la * 2 end             -- (taken as lost: queued again, the next after twice as long)
    waiting, queuedAt = true, t
    inGameThread(job)
    return false
  end)
  return true
end

return Tick
