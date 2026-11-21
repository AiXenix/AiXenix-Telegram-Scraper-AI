#!/bin/sh
# AiXenix Telegram Scrapper AI: runs the service and restarts it if it stops. Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1
# Ctrl+C or a stop request ends the loop instead of restarting the service.
trap 'exit 0' INT TERM
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 22.13 or newer: https://nodejs.org/"
  echo "Не найден Node.js. Установите Node.js 22.13 или новее: https://nodejs.org/"
  exit 1
fi
if [ ! -f newsdesk.config.json ]; then
  echo "newsdesk.config.json not found. Copy newsdesk.config.example.json to newsdesk.config.json and fill it in."
  echo "Нет файла newsdesk.config.json. Скопируйте newsdesk.config.example.json в newsdesk.config.json и заполните его."
  exit 1
fi
while true; do
  node newsdesk.mjs run --config newsdesk.config.json
  code=$?
  [ "$code" -eq 130 ] && exit 0
  echo "$(date '+%F %T') The service stopped (code $code). Restarting in 15 seconds. / Сервис остановился (код $code). Перезапуск через 15 секунд."
  sleep 15
done
