# Installs RVNG into ACE COMBAT 8: UE4SS and the RVNG mod, exactly the approved files. Anything else in the loader's
# folder, and files the scan would flag, are moved to this folder's backup\ (never deleted); "Uninstall RVNG.cmd"
# puts them back.
. (Join-Path $PSScriptRoot 'common.ps1')
Write-Host "RVNG $($Pkg.rvngVersion) installer (for ACE COMBAT 8 $($Pkg.gameVersion))" -ForegroundColor White

# 1. Node.js
Write-Step 'Node.js (runs the RVNG companion app)'
if ((Get-NodeMajor) -lt $NodeMin) {
  Write-Warn "Node.js $NodeMin or newer is needed and isn't installed."
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Read-YesNo 'Install Node.js LTS now with winget?')) {
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    Update-PathFromRegistry
  }
  if ((Get-NodeMajor) -lt $NodeMin) {
    Open-Site 'https://nodejs.org/en/download'
    Stop-Script 'Install Node.js (the LTS version) from nodejs.org, then run "Install RVNG.cmd" again.'
  }
}
Write-Ok "Node.js $(& node -v)"

# 2. The game folder
Write-Step 'Finding ACE COMBAT 8'
$game = Get-SavedGame
if (-not $game) { $game = Find-SteamGame }
if ($game) {
  Write-Host "   Found: $game"
  if (-not (Read-YesNo 'Install RVNG there?')) { $game = $null }
}
if (-not $game) { $game = Read-GameFolder }
if (-not (Test-Game $game)) { Stop-Script "That isn't the ACE COMBAT 8 folder (no Game\Binaries\Win64\AceCombat8.exe in it)." }
$game = (Resolve-Path -LiteralPath $game).Path
Write-Ok $game
while (Test-GameRunning) {
  Write-Warn 'ACE COMBAT 8 is running. Close the game first.'
  if ($Assume -or -not (Read-YesNo 'Closed it? Try again')) { Stop-Script 'Close the game, then run the installer again.' }
}
if (-not (Test-GameBuild $game)) {
  if (-not (Read-YesNo 'Install anyway? (it will not pass the scan until the builds match)' $false)) { Stop-Script 'Nothing was changed.' }
}

$backupRoot = Join-Path $Here ('backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$moved = New-Object System.Collections.Generic.List[string]
function Move-Aside($rel) {
  $src = Join-Rel $game $rel; $dst = Join-Rel $backupRoot $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Move-Item -LiteralPath $src -Destination $dst
  $moved.Add($rel)
}
function Save-Backup {
  if ($moved.Count) {
    @{ game = $game; moved = @($moved) } | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $backupRoot 'backup.json')
  }
}

# 3. Other loader files and mods: the loader's folder must hold exactly RVNG's files
Write-Step 'Checking the mod loader folder'
$ours = @{}; foreach ($f in $Pkg.install) { $ours[$f.path.ToLower()] = $f }
$ue4ss = Join-Path $game 'Game\Binaries\Win64\ue4ss'
$others = @()
if (Test-Path -LiteralPath $ue4ss) {
  foreach ($f in Get-ChildItem -LiteralPath $ue4ss -Recurse -File -Force) {
    $rel = 'Game/Binaries/Win64/ue4ss/' + $f.FullName.Substring($ue4ss.Length + 1).Replace('\', '/')
    if ($rel -match '\.(log|dmp)$' -and $rel -notmatch '\.(dll|lua)$') { continue }
    if (-not $ours.ContainsKey($rel.ToLower())) { $others += $rel }
  }
}
if ($others.Count) {
  Write-Warn "Other mods or loader files are installed. A ranked scan rejects them, so they go to the backup folder:"
  $others | Select-Object -First 15 | ForEach-Object { Write-Host "       $_" }
  if ($others.Count -gt 15) { Write-Host "       ...and $($others.Count - 15) more" }
  if (-not (Read-YesNo 'Move them to the backup folder? ("Uninstall RVNG.cmd" puts them back)')) { Stop-Script 'Nothing was changed.' }
  foreach ($r in $others) { Move-Aside $r }
  Write-Ok "Moved $($others.Count) files to $backupRoot"
} else { Write-Ok 'Nothing else in it' }

# 4. Copy RVNG's files (a different file already in its place is backed up first)
Write-Step 'Installing UE4SS and RVNG'
foreach ($f in $Pkg.install) {
  $src = Join-Rel (Join-Path $Here 'files') $f.path
  $dst = Join-Rel $game $f.path
  if ((Get-Sha256 $src) -ne $f.sha256) { Save-Backup; Stop-Script "The package is damaged ($($f.path)). Download it again." }
  if (Test-Path -LiteralPath $dst) {
    if ((Get-Sha256 $dst) -eq $f.sha256) { continue }
    Move-Aside $f.path
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst
  if ((Get-Sha256 $dst) -ne $f.sha256) { Save-Backup; Stop-Script "Copying $($f.path) failed (the copy doesn't match). Is the disk full?" }
}
foreach ($b in $Pkg.builds) { Write-Ok "$($b.name) $($b.version) ($($b.files) files)" }

# 5. Anything else the scan would flag (other mods, tool leftovers), and clean files that are missing
Write-Step 'Checking the game files (names only, nothing is opened)'
$known = @{}; foreach ($p in $Pkg.clean) { $known[$p.ToLower()] = $true }; foreach ($k in $ours.Keys) { $known[$k] = $true }
$present = @{}; $extra = @()
foreach ($r in (Get-ScannedFiles $game)) { $present[$r.ToLower()] = $true; if (-not $known.ContainsKey($r.ToLower())) { $extra += $r } }
if ($extra.Count) {
  Write-Warn 'These files are not part of the clean game. The scan will reject them:'
  $extra | Select-Object -First 20 | ForEach-Object { Write-Host "       $_" }
  if ($extra.Count -gt 20) { Write-Host "       ...and $($extra.Count - 20) more" }
  if (Read-YesNo 'Move them to the backup folder too?') {
    foreach ($r in $extra) { Move-Aside $r }
    Write-Ok "Moved $($extra.Count) files"
  } else { Write-Warn 'Left in place: remove them before you play ranked.' }
} else { Write-Ok 'No extra files' }
$missing = @($Pkg.clean | Where-Object { -not $present.ContainsKey($_.ToLower()) })
if ($missing.Count) {
  Write-Warn "$($missing.Count) game files are missing (for example $($missing[0]))."
  Write-Warn 'In Steam: right-click ACE COMBAT 8 > Properties > Installed Files > Verify integrity of game files.'
}
Save-Backup

# 6. Remember the game folder for Start and Uninstall
Set-Content -Encoding ASCII -LiteralPath $GamePathFile -Value $game

# 7. The pilot's account
Write-Step 'Your RVNG account'
if (-not (Test-Path -LiteralPath $Creds)) {
  $dl = Join-Path $env:USERPROFILE 'Downloads'
  $found = Get-ChildItem -LiteralPath $dl -Filter 'credentials*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
    Where-Object { try { $j = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json; $j.apiKey -and $j.apiSecret -and $j.server } catch { $false } } |
    Select-Object -First 1
  if ($found -and (Read-YesNo "Use $($found.Name) from your Downloads folder (account: $((Get-Content -Raw -LiteralPath $found.FullName | ConvertFrom-Json).name))?")) {
    Move-Item -LiteralPath $found.FullName -Destination $Creds
  }
}
if (Test-Path -LiteralPath $Creds) {
  Write-Ok "Signed in as $((Get-Content -Raw -LiteralPath $Creds | ConvertFrom-Json).name)"
} else {
  Write-Warn "No account yet. Sign up at $($Pkg.site) and download credentials.json."
  Write-Warn '"Start RVNG.cmd" picks it up from your Downloads folder.'
  Open-Site $Pkg.site
}

Write-Host ''
Write-Host 'RVNG is installed. Next: run "Start RVNG.cmd", then start ACE COMBAT 8 from Steam.' -ForegroundColor Green
if ($moved.Count) { Write-Host "Backed-up files: $backupRoot" }
Write-Host ''
Wait-Close 'Press Enter to close'
