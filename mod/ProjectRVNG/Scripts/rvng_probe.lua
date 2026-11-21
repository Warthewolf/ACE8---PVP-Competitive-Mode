--[[
  rvng_probe.lua : drives RVNG's native test logger (native/rvng_rt.c, dlls/main.dll) for in-game tests 1 and 2
  (docs/IN_GAME_TESTS.md). It does nothing unless the DLL is installed and Mods/ProjectRVNG/rvng_test.ini says probe=1.

  - On RVNG's game-thread tick (rvng_tick.lua, once a second) it hands the GameInstance to RVNG_Watch, which logs the
    "stay offline" flags.
  - Ctrl+F6 in the hangar arms the solo deathmatch sortie (RVNG_ArmDM, on the next tick); then press Sortie.
  Everything it finds goes to Mods/ProjectRVNG/logs/RVNG_<date>_<time>.log.
]]
local Probe = { offlineBad = 0, watched = 0 }
if type(rawget(_G, "RVNG_ProbeOn")) ~= "function" or RVNG_ProbeOn() ~= 1 then return Probe end
local Tick = require("rvng_tick")

local gi, armWanted = nil, false
local function findGameInstance()
  for _, cls in ipairs({ "BP_LiveGameInstance_C", "LiveGameInstance", "GameInstance" }) do
    local ok, obj = pcall(FindFirstOf, cls)
    if ok and obj and obj:IsValid() then return obj end
  end
  return nil
end

function Probe.gameInstance() return gi end

Tick.add(function()
  if not (gi and gi:IsValid()) then gi = findGameInstance() end   -- it lives the whole session: found once
  local r = RVNG_Watch(gi and gi:GetAddress() or 0)
  Probe.watched = Probe.watched + 1
  if r == 1 then Probe.offlineBad = Probe.offlineBad + 1 end
  if armWanted then armWanted = false; RVNG_ArmDM() end
end)

-- (the key's callback only sets a flag: the tick does the work on the game thread)
RegisterKeyBind(Key.F6, { ModifierKey.CONTROL }, function() armWanted = true end)

print("[ProjectRVNG] test logger on (rvng_test.ini): Ctrl+F6 in the hangar arms the solo deathmatch test\n")
return Probe
