# bb-plugin — AiXenix Telegram Scraper AI

**English** · [Русский](#русский)

The bb plugin and all the source code of the news desk. For what it does,
setup and settings, see the [main README](../README.md).

```
src/              engine shared by both ways of running (no bb or Node-only APIs in its contract)
  engine.ts         sources, pipeline, decisions, the four work loops
  collector.ts      reads t.me/s/<channel> with a cursor per source
  tme.ts            channel page parser
  pipeline.ts       repeat check and drafting prompts
  bot.ts            Telegram bot: proposals, buttons, commands, forwarded posts
  publisher.ts      sends a post with a photo, video or album
  telegram.ts       Bot API client
  config.ts         the one config document: schema, defaults, secrets
  db.ts             SQLite: sources, posts, stories, log
  llm/              model runners: hidden bb threads, a bb server over HTTP, OpenAI-compatible API
server.ts         bb shell: settings, storage, model runner, admin page RPC, `bb newsdesk`, HTTP routes
app.tsx           admin page
skills/newsdesk/  instructions for agents in bb
standalone-src/   standalone shell (main.ts) and its build (build.mjs)
tests/            unit tests, an end-to-end scenario with a fake Telegram, and a live scenario
```

## Commands

```bash
npm ci
npm run check                                 # TypeScript
npm test                                      # all tests (Node.js 22.13+)
npm run build:standalone -- ../standalone     # rebuild the standalone script into ../standalone
bb plugin build                               # build dist/ for bb
bb plugin install .                           # install this folder into bb
```

---

## Русский

Плагин bb и весь исходный код редакции. Что она делает, как её настроить и
какие есть настройки — в [основном README](../README.ru.md).

Структура описана выше. Команды разработки те же: `npm ci`, `npm run check`,
`npm test`, `npm run build:standalone -- ../standalone`, `bb plugin build`,
`bb plugin install .`.
