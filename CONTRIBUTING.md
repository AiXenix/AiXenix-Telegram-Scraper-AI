# Contributing

**English** · [Русский](#русский)

Thanks for helping. Issues and pull requests are welcome.

1. Fork the repository and create a branch.
2. Work in `bb-plugin/`: `npm ci`, then make your change.
3. Run `npm run check` and `npm test`. Add a test for a fix or a new behavior.
4. If you changed anything the standalone script uses, rebuild it:
   `npm run build:standalone -- ../standalone`, and commit the updated `standalone/`.
5. Open a pull request describing what changed and why.

Rules:

- No secrets, real chat ids, phone numbers, session files or private channel
  lists in code, tests, fixtures, screenshots or logs. Tests use invented data.
- Keep the engine in `bb-plugin/src/` free of bb-only and Node-only assumptions:
  both shells (`server.ts`, `standalone-src/main.ts`) must keep working.
- User-facing texts of the bot and the admin page are in Russian.

### Live scenario

`npm test` never touches the network. The live scenario checks a whole running
copy against the real `t.me` and real models, with a fake Telegram Bot API in
place of the real one, so nothing reaches your real bot or channel.

1. Start the fake Bot API: `node tests/support/mock-telegram.mjs 8089`.
2. Point a test copy at it. Use a separate config (for the script) or a
   separate bb profile (for the plugin): `telegram.apiBase` =
   `http://127.0.0.1:8089`, any token in the right format such as
   `123456:TEST`, `telegram.channel` = `@test_channel`, real public source
   channels and a working `llm` section. Start the copy.
3. Take the pairing code from `status` (or the Status tab) and run
   `node tests/e2e/live-scenario.mjs --mock http://127.0.0.1:8089 --code <code> --label standalone`.
   Add `--footer @YourFooter` if the copy has a footer.

It pairs the owner, waits for proposals (up to 8 minutes, `--proposal-timeout`
in ms), publishes, rejects, asks for another variant and checks every message
the bot sent. Exit code 0 means every step passed.

---

## Русский

Спасибо за помощь, issues и pull requests приветствуются.

1. Сделайте форк и ветку.
2. Работайте в `bb-plugin/`: `npm ci`, затем ваши изменения.
3. Запустите `npm run check` и `npm test`. Для исправления или нового поведения добавьте тест.
4. Если изменилось то, что использует отдельный скрипт, пересоберите его:
   `npm run build:standalone -- ../standalone` и закоммитьте обновлённую `standalone/`.
5. Откройте pull request с описанием, что и зачем изменено.

Правила: никаких секретов, настоящих ID чатов, телефонов, файлов сессий и
личных списков каналов в коде, тестах, примерах, скриншотах и логах; ядро в
`bb-plugin/src/` не должно зависеть от bb или Node.js, обе оболочки должны
продолжать работать; тексты бота и админки — на русском.

### Живой сценарий

`npm test` не ходит в сеть. Живой сценарий проверяет работающую копию целиком
на настоящем `t.me` и настоящих моделях, но вместо Bot API — имитация, поэтому
до вашего настоящего бота и канала ничего не доходит.

1. Запустите имитацию Bot API: `node tests/support/mock-telegram.mjs 8089`.
2. Направьте на неё тестовую копию — с отдельным конфигом (скрипт) или в
   отдельном профиле bb (плагин): `telegram.apiBase` = `http://127.0.0.1:8089`,
   любой токен правильного вида, например `123456:TEST`, `telegram.channel` =
   `@test_channel`, настоящие открытые каналы-источники и рабочий раздел `llm`.
   Запустите копию.
3. Возьмите код привязки из `status` (или вкладки «Состояние») и выполните
   `node tests/e2e/live-scenario.mjs --mock http://127.0.0.1:8089 --code <код> --label standalone`.
   Если у копии есть подпись, добавьте `--footer @ВашаПодпись`.

Сценарий привязывает владельца, ждёт предложений (до 8 минут,
`--proposal-timeout` в мс), публикует, отклоняет, просит другой вариант и
проверяет каждое сообщение бота. Код выхода 0 — все шаги прошли.
