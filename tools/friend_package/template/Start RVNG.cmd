@echo off
rem Runs scripts\start.ps1 (Windows PowerShell). Bypass applies to this one run only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
