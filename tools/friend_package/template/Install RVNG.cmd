@echo off
rem Runs scripts\install.ps1 (Windows PowerShell). Bypass applies to this one run only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1"
