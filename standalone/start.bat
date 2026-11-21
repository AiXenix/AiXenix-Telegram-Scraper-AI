@echo off
chcp 65001 >nul
rem AiXenix Telegram Scraper AI: runs the service and restarts it if it stops. Close the window to stop.
cd /d "%~dp0"
title AiXenix Telegram Scraper AI
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
    pause
    exit /b 1
  )
)
if not exist "newsdesk.config.json" (
  echo newsdesk.config.json not found. Copy newsdesk.config.example.json to newsdesk.config.json and fill it in.
  echo Нет файла newsdesk.config.json. Скопируйте newsdesk.config.example.json в newsdesk.config.json и заполните его.
  pause
  exit /b 1
)
:loop
"%NODE%" newsdesk.mjs run --config newsdesk.config.json
echo.
echo [%date% %time%] The service stopped. Restarting in 15 seconds; close the window to stop.
echo [%date% %time%] Сервис остановился. Перезапуск через 15 секунд; чтобы остановить, закройте окно.
timeout /t 15 /nobreak >nul
goto loop
