# Shared by install.ps1, start.ps1 and uninstall.ps1 (Windows PowerShell 5.1). Plain ASCII on purpose: 5.1 reads a
# script without a byte order mark in the system code page.
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSScriptRoot           # the unpacked RVNG folder
$Pkg = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'package.json') | ConvertFrom-Json
$GamePathFile = Join-Path $Here 'game-path.txt'
$Companion = Join-Path $Here 'companion'
$Creds = Join-Path $Companion 'credentials.json'
$NodeMin = 22
# Tests only: RVNG_ASSUME=1 takes every question's default answer and opens no browser; RVNG_GAME names the game folder.
$Assume = $env:RVNG_ASSUME -eq '1'

function Write-Step($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Write-Ok($t) { Write-Host "   OK  $t" -ForegroundColor Green }
function Write-Warn($t) { Write-Host "   !!  $t" -ForegroundColor Yellow }
function Write-Bad($t) { Write-Host "   XX  $t" -ForegroundColor Red }
function Read-YesNo($q, $default = $true) {
  if ($Assume) { return $default }
  $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "   $q $hint"
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim().ToLower().StartsWith('y')
}
function Stop-Script($t) { Write-Bad $t; Write-Host ''; Wait-Close; exit 1 }
function Wait-Close($t = 'Press Enter to close') { if (-not $Assume) { Read-Host $t | Out-Null } }
function Open-Site($url) { if (-not $Assume) { Start-Process $url } }

function Get-Sha256($f) { (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() }
function Join-Rel($root, $rel) { Join-Path $root ($rel -replace '/', '\') }

# Node.js: the companion app runs on it.
function Get-NodeMajor {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return 0 }
  try { $v = (& node -v) -join ''; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch {}
  return 0
}
function Update-PathFromRegistry {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$m;$u"
}

# The game folder: the one saved by the installer, else Steam's libraries, else ask.
function Test-Game($dir) { $dir -and (Test-Path -LiteralPath (Join-Path $dir 'Game\Binaries\Win64\AceCombat8.exe')) }
function Find-SteamGame {
  $steam = $null
  foreach ($k in 'HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam') {
    try { $p = Get-ItemProperty -Path $k -ErrorAction Stop; if ($p.SteamPath) { $steam = $p.SteamPath } elseif ($p.InstallPath) { $steam = $p.InstallPath } } catch {}
    if ($steam) { break }
  }
  if (-not $steam) { return $null }
  $libs = @($steam -replace '/', '\')
  $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
  if (Test-Path -LiteralPath $vdf) {
    foreach ($m in [regex]::Matches((Get-Content -Raw -LiteralPath $vdf), '"path"\s+"([^"]+)"')) { $libs += ($m.Groups[1].Value -replace '\\\\', '\') }
  }
  foreach ($lib in ($libs | Select-Object -Unique)) {
    $acf = Join-Path $lib "steamapps\appmanifest_$($Pkg.appId).acf"
    $dir = $null
    if (Test-Path -LiteralPath $acf) {
      $m = [regex]::Match((Get-Content -Raw -LiteralPath $acf), '"installdir"\s+"([^"]+)"')
      if ($m.Success) { $dir = Join-Path $lib "steamapps\common\$($m.Groups[1].Value)" }
    }
    if (-not $dir) { $dir = Join-Path $lib 'steamapps\common\ACE COMBAT 8' }
    if (Test-Game $dir) { return (Resolve-Path -LiteralPath $dir).Path }
  }
  return $null
}
function Read-GameFolder {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = 'Pick the "ACE COMBAT 8" folder (the one with the Game folder inside)'
  if ($d.ShowDialog() -ne 'OK') { return $null }
  $p = $d.SelectedPath
  if ((Split-Path -Leaf $p) -ieq 'Game') { $p = Split-Path -Parent $p }
  return $p
}
function Get-SavedGame {
  if ($env:RVNG_GAME) { if (Test-Game $env:RVNG_GAME) { return $env:RVNG_GAME } else { return $null } }
  if (Test-Path -LiteralPath $GamePathFile) { $g = (Get-Content -LiteralPath $GamePathFile -TotalCount 1).Trim(); if (Test-Game $g) { return $g } }
  return $null
}

# Steam's build id of the install (appmanifest next to steamapps\common), or $null.
function Get-SteamBuild($game) {
  $acf = Join-Path (Split-Path -Parent (Split-Path -Parent $game)) "appmanifest_$($Pkg.appId).acf"
  if (-not (Test-Path -LiteralPath $acf)) { return $null }
  $m = [regex]::Match((Get-Content -Raw -LiteralPath $acf), '"buildid"\s+"(\d+)"')
  if ($m.Success) { return $m.Groups[1].Value } else { return $null }
}
function Test-GameBuild($game) {
  if (-not $Pkg.steamBuild) { return $true }
  $b = Get-SteamBuild $game
  if (-not $b) { Write-Warn "Couldn't read your game's Steam build. RVNG $($Pkg.rvngVersion) is for build $($Pkg.steamBuild)."; return $true }
  if ($b -eq $Pkg.steamBuild) { Write-Ok "Game build $b (the one RVNG is approved for)"; return $true }
  Write-Warn "Your game is on Steam build $b, but this RVNG package is for build $($Pkg.steamBuild)."
  Write-Warn 'Let Steam finish updating the game. If it is up to date, the game had a patch: ask the RVNG admin for a new package.'
  return $false
}

# (RVNG_TEST_NOGAME=1: the package's own test, which runs while the real game may be open)
function Test-GameRunning { if ($env:RVNG_TEST_NOGAME -eq '1') { return $false }; [bool](Get-Process -Name 'AceCombat8*' -ErrorAction SilentlyContinue) }

# What a scan reads, by path only (no file is opened): the anti-cheat's folder and the protected launcher at the
# root are never listed (as in the companion's scanner), nor Saved folders, logs, dumps or RVNG's bridge folder.
function Get-ScannedFiles($game) {
  $root = (Resolve-Path -LiteralPath $game).Path.TrimEnd('\')
  $out = New-Object System.Collections.Generic.List[string]
  $loadable = '\.(pak|ucas|utoc|sig|dll|asi|exe|lua|py|js)$'
  $stack = New-Object System.Collections.Stack
  $stack.Push('')
  while ($stack.Count) {
    $rel = $stack.Pop()
    $dir = if ($rel) { Join-Path $root $rel } else { $root }
    foreach ($e in Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) {
      if (-not $rel -and $e.Name -match '^(easyanticheat|start_protected_game\.exe)$') { continue }
      $r = if ($rel) { "$rel/$($e.Name)" } else { $e.Name }
      if ($e.PSIsContainer) { $stack.Push([string]($r -replace '/', '\')); continue }
      $r = $r -replace '\\', '/'
      if ($r -notmatch $loadable -and ($r -match '^([^/]+/)?saved(/|$)' -or $r -match '^projectrvng/bridge(/|$)' -or $r -match '^\.rvng-cache\.json$' -or $r -match '\.(log|dmp)$')) { continue }
      $out.Add($r)
    }
  }
  return $out
}
