# Starts the RVNG companion app: a scan first (shows the verdict), then the bridge the in-game mod talks to. Keep the
# window open while you play.
. (Join-Path $PSScriptRoot 'common.ps1')
$Host.UI.RawUI.WindowTitle = 'RVNG companion'

if ((Get-NodeMajor) -lt $NodeMin) { Update-PathFromRegistry }
if ((Get-NodeMajor) -lt $NodeMin) { Stop-Script "Node.js $NodeMin or newer isn't installed. Run ""Install RVNG.cmd"" first." }
$game = Get-SavedGame
if (-not $game) { Stop-Script 'RVNG is not installed yet. Run "Install RVNG.cmd" first.' }

# credentials.json from the website's sign-up, picked up from Downloads
if (-not (Test-Path -LiteralPath $Creds)) {
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  $found = Get-ChildItem -LiteralPath $dl -Filter 'credentials*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
    Where-Object { try { $j = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json; $j.apiKey -and $j.apiSecret -and $j.server } catch { $false } } |
    Select-Object -First 1
  if ($found -and (Read-YesNo "Use $($found.Name) from your Downloads folder (account: $((Get-Content -Raw -LiteralPath $found.FullName | ConvertFrom-Json).name))?")) {
    Move-Item -LiteralPath $found.FullName -Destination $Creds
  } else {
    Open-Site $Pkg.site
    Stop-Script "No account yet. Sign up at $($Pkg.site), download credentials.json, then run ""Start RVNG.cmd"" again."
  }
}
$me = (Get-Content -Raw -LiteralPath $Creds | ConvertFrom-Json)
Write-Host "RVNG $($Pkg.rvngVersion) - pilot $($me.name) - $($me.server)" -ForegroundColor White
Write-Host "Game: $game"
[void](Test-GameBuild $game)

Push-Location $Companion
try {
  Write-Step 'Scanning your game files (the first scan hashes everything and takes a few minutes)'
  & node rvng.js scan --game $game
  if ($LASTEXITCODE -ne 0) {
    Write-Warn 'The scan did not go through (see above). Check your internet connection; the companion keeps trying when you queue.'
  }
  Write-Host ''
  Write-Host 'If the verdict is not CLEAN, the lines under it name each file: remove those (or run "Install RVNG.cmd" again).' -ForegroundColor Gray
  Write-Step 'Companion running: start ACE COMBAT 8 from Steam and pick RVNG in the main menu. Keep this window open.'
  & node rvng.js run --game $game
} finally { Pop-Location }
Wait-Close 'The companion stopped. Press Enter to close'
