--[[
  rvng_native.lua : the always-on half of RVNG's native runtime (dlls/main.dll), with or without the test logger.

  The DLL holds the game's LiveWebAPI gates shut in every install (they always answer false, so no request to the game's
  online services leaves; docs/re/DEATHMATCH_NATIVE.md 9.2). With the gates shut, the boot login the main menu waits
  for is never answered, so the DLL ends it through the game's own "login failed" exit (D7). That has to happen on the
  game thread, after the refused call has returned: this module hands the DLL a tick for it (RVNG_Tick, once a second
  on RVNG's game-thread tick, rvng_tick.lua) together with the GameInstance it reads the login from.
]]
local Native = { ended = 0, ticks = 0 }
if type(rawget(_G, "RVNG_Tick")) ~= "function" then return Native end   -- (the DLL isn't installed)
local Tick = require("rvng_tick")

local gi
local function findGameInstance()
  for _, cls in ipairs({ "BP_LiveGameInstance_C", "LiveGameInstance", "GameInstance" }) do
    local ok, obj = pcall(FindFirstOf, cls)
    if ok and obj and obj:IsValid() then return obj end
  end
  return nil
end

Tick.add(function()
  if not (gi and gi:IsValid()) then gi = findGameInstance() end   -- it lives the whole session: found once
  Native.ended = RVNG_Tick(gi and gi:GetAddress() or 0)
  Native.ticks = Native.ticks + 1
end)

return Native
