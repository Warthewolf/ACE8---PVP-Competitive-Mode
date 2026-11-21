# Removes RVNG and UE4SS from ACE COMBAT 8 (only files that are still exactly the installed ones) and puts back
# everything the installer moved to backup\. The account (companion\credentials.json) stays.
. (Join-Path $PSScriptRoot 'common.ps1')
Write-Host "RVNG $($Pkg.rvngVersion) uninstaller" -ForegroundColor White
$game = Get-SavedGame
if (-not $game) { $game = Find-SteamGame }
if (-not (Test-Game $game)) { Stop-Script "Couldn't find the game folder RVNG was installed in." }
Write-Host "   Game: $game"
if (Test-GameRunning) { Stop-Script 'ACE COMBAT 8 is running. Close it first.' }
if (-not (Read-YesNo 'Remove RVNG and UE4SS from it and put back your backed-up files?')) { exit 0 }

Write-Step 'Removing RVNG and UE4SS'
$kept = 0
foreach ($f in $Pkg.install) {
  $p = Join-Rel $game $f.path
  if (-not (Test-Path -LiteralPath $p)) { continue }
  if ((Get-Sha256 $p) -eq $f.sha256) { Remove-Item -LiteralPath $p -Force } else { $kept++; Write-Warn "Changed since the install, left in place: $($f.path)" }
}
# What the loader and the mod wrote themselves: UE4SS's log, RVNG's logs and its bridge folder
foreach ($rel in 'Game\Binaries\Win64\ue4ss\UE4SS.log', 'Game\Binaries\Win64\ue4ss\Mods\ProjectRVNG\logs', 'ProjectRVNG') {
  $p = Join-Path $game $rel
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
# Folders left empty
$ue4ss = Join-Path $game 'Game\Binaries\Win64\ue4ss'
if (Test-Path -LiteralPath $ue4ss) {
  Get-ChildItem -LiteralPath $ue4ss -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | Remove-Item -Force
  if (-not (Get-ChildItem -LiteralPath $ue4ss -Force)) { Remove-Item -LiteralPath $ue4ss -Force }
}
Write-Ok 'Removed'

Write-Step 'Putting back backed-up files'
$back = 0; $skip = 0
$dirs = @(Get-ChildItem -LiteralPath (Join-Path $Here 'backup') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
foreach ($d in $dirs) {
  $j = Join-Path $d.FullName 'backup.json'
  if (-not (Test-Path -LiteralPath $j)) { continue }
  foreach ($rel in (Get-Content -Raw -LiteralPath $j | ConvertFrom-Json).moved) {
    $src = Join-Rel $d.FullName $rel; $dst = Join-Rel $game $rel
    if (-not (Test-Path -LiteralPath $src)) { continue }
    if (Test-Path -LiteralPath $dst) { $skip++; Write-Warn "Already there, kept in the backup: $rel"; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Move-Item -LiteralPath $src -Destination $dst
    $back++
  }
  if (-not (Get-ChildItem -LiteralPath $d.FullName -Recurse -File | Where-Object { $_.Name -ne 'backup.json' })) { Remove-Item -LiteralPath $d.FullName -Recurse -Force }
}
Write-Ok "$back files put back$(if ($skip) { ", $skip left in $Here\backup" })"
Remove-Item -LiteralPath $GamePathFile -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'RVNG is uninstalled.' -ForegroundColor Green
Wait-Close 'Press Enter to close'
