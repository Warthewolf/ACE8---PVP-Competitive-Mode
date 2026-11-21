-- Runs mod/ProjectRVNG/Scripts/rvng_pages.lua (RVNG's menu pages in the main menu) against fake menu widgets, a fake
-- native runtime and a fake link. Usage: lua5.4 pages_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
RVNG_TICK_SYNC = true
ExecuteInGameThread = function(fn) fn() end
local loopFn
function LoopAsync(_, fn) loopFn = fn end
local _print = print
print = function() end

-- the main menu's widgets
local function widget(path, text)
  local w = { path = path, text = text }
  function w:IsValid() return true end
  function w:GetFullName() return "LiveLocalizeTextBlock /Engine/Transient.X.WBP_Menu_MainTop_000_C_1.WidgetTree_1." .. self.path .. ".Text_Body" end
  -- (a second, stale menu's copy of each text exists too: WBP_Menu_MainTop_000_C_0, not in the viewport)
  function w:GetText() local t = self.text; return { ToString = function() return t end } end
  function w:SetText(ft) self.text = ft.s end
  return w
end
local stock = { "CAMPAIGN", "CAMPAIGN TRAINING", "MULTIPLAYER", "SYSTEM", "QUIT GAME" }
local header = widget("Header.WidgetTree_2.WBP_Menu_Text_000.WidgetTree_3", "MAIN MENU")
local help = widget("HelpText.WidgetTree_4.WBP_Menu_Text_001.WidgetTree_5", "Play through the game following a storyline.")
local rows = {}
local decoys = {}
for i = 1, 5 do
  rows[i] = widget("CommandList.WidgetTree_6.WBP_Menu_Text_Focus_000_0" .. i .. ".WidgetTree_7.TextWidget.WidgetTree_8", stock[i])
  decoys[i] = widget("CommandList.WidgetTree_6.WBP_Menu_Text_Focus_000_0" .. i .. ".WidgetTree_7.NewBadge.WidgetTree_9", "NEW")
end
-- (the real names end in .Text_Body; the helper adds it)
local other = widget("Other.WidgetTree_9", "OPTIONS")
FText = function(s) return { s = s } end
local selects = {}
RVNG_MenuSelect = function(addr, row) if addr == 0x7000 then selects[#selects + 1] = row; return 1 end return 0 end
local top = { IsValid = function() return true end, IsInViewport = function() return true end, GetAddress = function() return 0x7000 end,
  GetFullName = function() return "WBP_Menu_MainTop_000_C /Engine/Transient.X.WBP_Menu_MainTop_000_C_1" end }
-- the old menu (still alive after a travel, not on screen): its texts must never be picked
local stale = {}
for _, p in ipairs({ "Header.WidgetTree_2.WBP_Menu_Text_000.WidgetTree_3", "HelpText.WidgetTree_4.WBP_Menu_Text_001.WidgetTree_5",
  "CommandList.WidgetTree_6.WBP_Menu_Text_Focus_000_01.WidgetTree_7.TextWidget.WidgetTree_8" }) do
  local w = widget(p, "STALE")
  w.GetFullName = function() return "LiveLocalizeTextBlock /Engine/Transient.X.WBP_Menu_MainTop_000_C_0.WidgetTree_1." .. p .. ".Text_Body" end
  stale[#stale + 1] = w
end
local top0 = { IsValid = function() return true end, IsInViewport = function() return false end,
  GetFullName = function() return "WBP_Menu_MainTop_000_C /Engine/Transient.X.WBP_Menu_MainTop_000_C_0" end }
FindAllOf = function(cls)
  if cls == "WBP_Menu_MainTop_000_C" then return { top0, top } end
  if cls ~= "LiveLocalizeTextBlock" then return nil end
  local all = { other, stale[1], stale[2], stale[3], header, help }
  for i = 1, 5 do all[#all + 1] = rows[i]; all[#all + 1] = decoys[i] end    -- (a decoy after each row: never picked)
  return all
end

-- the native runtime: page mode, presses, the link
local page, presses, pressRow, backs = 0, 0, -1, 0
local L = { state = 0, player = 1, mine = 0, theirs = 0, synced = 0, ln = 0, left = -1, due = 0 }
RVNG_MenuPage = function(v) page = v end
RVNG_MenuPress = function(k) return k == 0 and presses or k == 2 and backs or pressRow end
RVNG_LinkReady = function(v) L.mine = v ~= 0 and 1 or 0 end
RVNG_LinkLaunch = function() L.ln = 1; return 1 end
RVNG_ReadyInfo = function(k) return ({ [0] = L.state, L.player, L.mine, L.theirs, L.synced, L.ln, L.left, L.due })[k] or -1 end
local res = { 0, -1, -1 }
RVNG_ResultInfo = function(k) return res[k + 1] or -1 end
RVNG_MenuText = function() end

local Tick = require("rvng_tick")
local Ready = require("rvng_ready")
local Pages = require("rvng_pages")
Tick.start(1000)
local function tick() loopFn() end
local function check(c, msg) if not c then print = _print; error("FAIL: " .. msg, 2) end end
local function texts() local t = {}; for i = 1, 5 do t[i] = rows[i].text end; return t end
local function press(row) presses = presses + 1; pressRow = row - 1; tick() end
local function back() backs = backs + 1; tick() end                 -- (B / Esc, taken by the DLL on a page)

local queued, cancels, leaves = {}, 0, 0
Pages.onQueue = function(mode) queued[#queued + 1] = mode end
Pages.onCancel = function() cancels = cancels + 1 end
Pages.onLeave = function() leaves = leaves + 1 end

tick()
check(Pages.page == "main" and rows[3].text == "MULTIPLAYER" and page == 0, "the stock main menu, untouched")
Pages.openMultiplayer()
tick()
local t = texts()
check(page == 1 and header.text == "MULTIPLAYER" and t[1] == "RANKED 1V1" and t[2] == "CASUAL 1V1" and t[3] == "" and t[5] == "BACK",
  "the MULTIPLAYER page: RANKED 1V1, CASUAL 1V1, BACK; presses are RVNG's")
check(selects[#selects] == 0, "the cursor put on RANKED 1V1 (the on-screen menu's own SetSelectedIndex)")
check(other.text == "OPTIONS" and decoys[1].text == "NEW" and decoys[5].text == "NEW", "widgets outside the rows' drawn texts untouched")
check(stale[1].text == "STALE" and stale[2].text == "STALE" and stale[3].text == "STALE", "the old menu not on screen untouched")
help.text = "Play through the game following a storyline."   -- (the game rewrites it under the cursor)
tick()
check(help.text:find("Ranked: rated", 1, true), "the description written again")
press(5)
check(Pages.page == "main" and page == 0 and header.text == "MAIN MENU" and rows[1].text == "CAMPAIGN" and rows[5].text == "QUIT GAME",
  "BACK: the stock main menu's texts restored, presses back to the game")
check(selects[#selects] == 2, "BACK puts the cursor back on MULTIPLAYER (not on QUIT GAME)")

-- RANKED: the queue, then the lobby
Pages.openMultiplayer(); tick()
press(1)
check(queued[1] == "ranked" and Pages.page == "lobby" and header.text == "LOBBY" and rows[1].text == "RANKED 1V1" and rows[5].text == "LEAVE LOBBY",
  "RANKED 1V1 queues ranked and opens the LOBBY")
Ready.queue({ state = "queued", mode = "ranked" })
tick()
check(rows[2].text:find("^SEARCHING") and help.text:find("Looking for an opponent %(ranked%)"), "the lobby searching")
press(5)
check(cancels == 1 and Pages.page == "multiplayer" and rows[1].text == "RANKED 1V1", "LEAVE LOBBY while searching cancels the queue")

-- CASUAL: matched, the ready-up in the lobby, leaving after the match was found
press(2)
check(queued[2] == "casual" and Pages.page == "lobby" and rows[1].text == "CASUAL 1V1", "CASUAL 1V1 queues casual")
Ready.begin("Pixy"); L.state = 2; tick()
check(rows[1].text == "VS Pixy" and rows[2].text == "READY UP (0/2)", "matched: VS Pixy, READY UP (0/2)")
press(2)
tick()
check(L.mine == 1 and rows[2].text == "READY (1/2)", "the row 2 press readies")
press(5)
check(leaves == 1 and Pages.page == "multiplayer" and Ready.phase == "off", "LEAVE LOBBY after the match was found leaves the link")

-- launched: the pages step aside for the travel; the result page after the match
press(1)
Ready.begin("Mihaly"); L.state, L.mine, L.theirs, L.synced, L.ln, L.left, L.due = 2, 1, 1, 1, 2, -1, 1
tick()
check(Ready.phase == "launched" and Pages.page == "main" and page == 0, "launched: the pages down (the menu goes with the travel)")
for i = 1, 5 do rows[i].text = stock[i] end; header.text = "MAIN MENU"   -- (a new main menu after the match)
res = { 1, 125, 80 }
tick(); tick()
t = texts()
check(Pages.page == "result" and page == 1 and header.text == "MATCH RESULT" and t[1] == "VICTORY  12 - 8" and t[2] == "PLAY AGAIN" and t[5] == "BACK",
  "the result page: VICTORY 12 - 8, PLAY AGAIN, BACK")
press(2)
check(queued[#queued] == "ranked" and Pages.page == "lobby", "PLAY AGAIN queues the same mode again")
press(5)
press(5)
check(Pages.page == "main" and rows[3].text == "MULTIPLAYER" and header.text == "MAIN MENU", "back to the stock main menu")
check(Pages.press(1) == nil and Pages.page == "main", "no press is RVNG's on the stock main menu")

-- B / Esc: the page's BACK (the lobby's LEAVE LOBBY); nothing on the stock main menu
L.state, L.mine, L.theirs, L.synced, L.ln, L.left, L.due = 0, 0, 0, 0, 0, -1, 0   -- (the last match's link gone)
Ready.reset()
Pages.openMultiplayer(); tick()
press(1)
check(Pages.page == "lobby", "the lobby again")
Ready.queue({ state = "queued", mode = "ranked" }); tick()
local c0 = cancels
back()
check(Pages.page == "multiplayer" and cancels == c0 + 1 and rows[1].text == "RANKED 1V1", "B/Esc in the lobby: LEAVE LOBBY (the queue cancelled)")
back()
check(Pages.page == "main" and page == 0 and rows[5].text == "QUIT GAME" and selects[#selects] == 2,
  "B/Esc on MULTIPLAYER: BACK to the stock main menu, the cursor on MULTIPLAYER " .. string.format("(page %s, native %s, row 5 %s, select %s)",
  Pages.page, tostring(page), tostring(rows[5].text), tostring(selects[#selects])))
back()
check(Pages.page == "main", "B/Esc on the stock main menu: nothing of RVNG's (the game's own)")

print = _print
print("all page checks passed")
