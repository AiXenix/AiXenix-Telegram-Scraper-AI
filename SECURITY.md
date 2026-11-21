# Security policy

**English** · [Русский](#русский)

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI/security/advisories/new)
instead (the *Report a vulnerability* button on the *Security* tab). If that
does not work for you, use the contacts at [aixenix.com](https://aixenix.com). You will get an answer within a few days.

## Never post secrets

Bot tokens, API keys, bb plugin tokens, `newsdesk.config.json`, the `data/`
folder and Telegram session files must never appear in issues, pull requests or
logs you attach. If you posted one by mistake, revoke it right away: a new bot
token in [@BotFather](https://t.me/BotFather) (`/revoke`), a new key at your
model provider, a new plugin token with `bb plugin token newsdesk --rotate`.

## Supported versions

Only the latest release is supported.

---

## Русский

**Об уязвимости** сообщайте не в открытом issue, а через
[закрытое сообщение об уязвимости на GitHub](https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI/security/advisories/new).
Если так не получается, воспользуйтесь контактами на
[aixenix.com](https://aixenix.com). Ответ — в течение нескольких дней.

**Никогда не публикуйте секреты**: токены ботов, ключи API, токены плагина bb,
файл `newsdesk.config.json`, папку `data/` и файлы сессий Telegram. Если такое
случайно попало в открытый доступ, сразу отзовите: новый токен бота в
[@BotFather](https://t.me/BotFather) (`/revoke`), новый ключ у поставщика
моделей, новый токен плагина командой `bb plugin token newsdesk --rotate`.

Поддерживается только последняя версия.
