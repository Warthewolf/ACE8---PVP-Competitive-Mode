-- Runs mod/ProjectRVNG/Scripts/rvng_ready.lua (the ready-up screen) against a fake native link.
-- Usage: lua5.4 ready_test.lua   (exits non-zero on the first failed check)
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/../ProjectRVNG/Scripts/?.lua;" .. package.path
RVNG_TICK_SYNC = true
ExecuteInGameThread = function(fn) fn() end
local loopFn
function LoopAsync(_, fn) loopFn = fn end
local _print = print
print = function() end

-- the fake link: state, player, ready flags, launch
local L = { state = 1, player = 1, mine = 0, theirs = 0, synced = 0, ln = 0, left = -1, due = 0, launches = {} }
local texts = {}
RVNG_LinkReady = function(v) L.mine = v ~= 0 and 1 or 0 end
RVNG_LinkLaunch = function(ms) L.launches[#L.launches + 1] = ms; L.ln = 1; return 1 end
RVNG_ReadyInfo = function(k)
  return ({ [0] = L.state, L.player, L.mine, L.theirs, L.synced, L.ln, L.left, L.due })[k] or -1
end
RVNG_MenuText = function(t, h) texts[#texts + 1] = { t, h } end

local Tick = require("rvng_tick")
local Ready = require("rvng_ready")
Tick.start(1000)
local function tick() loopFn() end
local function last() return texts[#texts] or { "", "" } end
local function check(c, msg) if not c then print = _print; error("FAIL: " .. msg, 2) end end

local launched = 0
Ready.onLaunch = function() launched = launched + 1 end

Ready.begin("Mihaly\226\128\148X")                      -- (a name with a non-ASCII character)
tick()
check(last()[1] == "CONNECTING..." and last()[2]:find("Mihaly???X", 1, true), "connecting shown, the name kept to ASCII")
check(Ready.active() and not Ready.toggle(), "no ready toggle before the link is up")
L.state = 2
tick()
check(last()[1] == "READY UP (0/2)" and last()[2]:find("You: not ready", 1, true), "the ready-up screen: 0 of 2")
check(Ready.toggle() and L.mine == 1, "a press readies this pilot")
tick()
check(last()[1] == "READY (1/2)" and last()[2]:find("Mihaly???X: not ready", 1, true), "1 of 2: this pilot ready")
check(Ready.toggle() and L.mine == 0, "a second press cancels ready")
tick()
check(last()[1] == "READY UP (0/2)", "back to 0 of 2")
Ready.toggle()
L.theirs = 1
tick()
check(#L.launches == 0 and last()[1] == "READY (2/2)", "both ready, but no LAUNCH before the guest's clock is synced")
L.synced = 1
tick()
check(#L.launches == 1 and L.launches[1] == 5000, "the host sends LAUNCH for 5 s later")
L.ln, L.left = 2, 3400
tick()
check(last()[1] == "LAUNCHING IN 4" and not Ready.active() and not Ready.toggle(), "the countdown; ready can't be cancelled now")
L.state = 3                                          -- (a link lost during the countdown: still launches)
L.left = 400
tick()
check(last()[1] == "LAUNCHING IN 1" and launched == 0, "the last second")
L.due, L.left = 1, -10
tick(); tick()
check(launched == 1 and last()[1] == "LAUNCHING" and Ready.phase == "launched", "launched once, at the launch time")
Ready.reset()
check(Ready.phase == "off" and last()[1] == "" and L.mine == 0, "reset: the row's own texts again")

-- the guest: never sends LAUNCH; the opponent leaving before the launch ends the screen
L.state, L.player, L.mine, L.theirs, L.synced, L.ln, L.left, L.due, L.launches = 2, 2, 0, 1, 1, 0, -1, 0, {}
local ended
Ready.onEnd = function(p) ended = p end
Ready.begin("Pixy")
tick()
Ready.toggle()
tick()
check(#L.launches == 0 and last()[1] == "READY (2/2)", "the guest waits for the host's LAUNCH")
L.state = 4
tick()
check(Ready.phase == "left" and ended == "left" and last()[2]:find("Pixy left before the match", 1, true), "the opponent left: said so")
tick()
check(Ready.phase == "left", "stays until the pilot presses again")

-- the main menu's own text widgets (LiveLocalizeTextBlocks in WBP_Menu_MainTop_000): written every tick, put back
local function widget(path, text)
  local w = { path = path, text = text, sets = 0 }
  function w:IsValid() return true end
  function w:GetFullName() return "LiveLocalizeTextBlock /Engine/Transient.X.WBP_Menu_MainTop_000_C_1.WidgetTree_1." .. self.path .. ".Text_Body" end
  function w:GetText() local t = self.text; return { ToString = function() return t end } end
  function w:SetText(ft) self.text = ft.s; self.sets = self.sets + 1 end
  return w
end
local header, row, help = widget("Header", "MAIN MENU"), widget("CommandList.Row3", "MULTIPLAYER"),
  widget("HelpText", "Play through the game following a storyline.")
local other = widget("CommandList.Row1", "CAMPAIGN")
FText = function(s) return { s = s } end
FindAllOf = function(cls) return cls == "LiveLocalizeTextBlock" and { other, header, row, help } or nil end
L.state, L.player, L.mine, L.theirs, L.synced, L.ln, L.left, L.due = 2, 1, 0, 0, 0, 0, -1, 0
Ready.onEnd = nil
Ready.reset()
Ready.begin("Pixy")
tick()
check(Ready.widgets and header.text == "READY UP" and row.text == "READY UP (0/2)" and help.text:find("vs Pixy", 1, true) and
  other.text == "CAMPAIGN", "the screen written into the menu's header, row and description; other rows untouched")
help.text = "Play through the game following a storyline."   -- (the game rewrites it when the cursor moves)
tick()
check(help.text:find("vs Pixy", 1, true) and row.sets == 1, "the description written again; an unchanged row not rewritten")
Ready.toggle()
tick()
check(row.text == "READY (1/2)", "the row follows the ready state (found again by the text RVNG set)")
Ready.reset()
check(header.text == "MAIN MENU" and row.text == "MULTIPLAYER", "reset: the header and the row back")

-- the result screen: back at the main menu after the match, this match's scores (x10 from the runtime)
local res = { 0, -1, -1 }
RVNG_ResultInfo = function(k) return res[k + 1] or -1 end
L.state, L.player, L.mine, L.theirs, L.synced, L.ln, L.left, L.due = 2, 1, 1, 1, 1, 2, -1, 1
Ready.begin("Pixy")
tick()
check(Ready.phase == "launched", "launched")
tick()
check(Ready.phase == "launched", "no result before the match has one")
res = { 1, 125, 80 }
tick()
check(Ready.phase == "result" and header.text == "MATCH RESULT" and row.text == "VICTORY  12 - 8" and
  help.text:find("you 12, Pixy 8", 1, true), "the result screen: VICTORY 12 - 8")
help.text = "something else"
tick()
check(help.text:find("you 12", 1, true), "the result stays until the next press")
Ready.reset()
Ready.begin("Pixy")                                   -- (the next match: last match's result not shown again)
L.due = 1
tick(); tick()
check(Ready.phase == "launched", "a new match ignores the last result")
res = { 2, 30, 30 }
tick()
check(row.text == "DRAW  3 - 3", "a draw")
Ready.reset()

print = _print
print("all ready-up checks passed")
