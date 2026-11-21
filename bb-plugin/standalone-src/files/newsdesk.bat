@echo off
chcp 65001 >nul
rem One-off commands, for example: newsdesk status, newsdesk add @channel, newsdesk queue, newsdesk help
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else if exist "%ProgramFiles%\node\node.exe" (
    set "NODE=%ProgramFiles%\node\node.exe"
  ) else (
    echo Node.js not found. Install Node.js 22.13 or newer: https://nodejs.org/
    echo Не найден Node.js. Установите Node.js 22.13 или новее: https://nodejs.org/
    exit /b 1
  )
)
"%NODE%" "%~dp0newsdesk.mjs" %* --config "%~dp0newsdesk.config.json"
