# AiXenix Telegram Scrapper AI — standalone

**English** · [Русский](#русский)

The news desk as one Node.js file. It watches public Telegram channels, drops
repeats of news you already have, drafts posts in your channel's voice and
publishes them after you press **Publish** in your bot. Full documentation:
<https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI>.

## What is here

| File | What it is |
|---|---|
| `newsdesk.mjs` | The whole program, dependencies included. |
| `newsdesk.config.example.json` | Every setting with its default and placeholders. |
| `start.bat` | Windows: runs the service and restarts it if it stops. |
| `newsdesk.bat` | Windows: one-off commands (`newsdesk status`, `newsdesk add @channel`, …). |
| `start.sh` | Linux and macOS: runs the service and restarts it if it stops. |

You need **Node.js 22.13 or newer**: <https://nodejs.org/>.

## Start

1. Copy `newsdesk.config.example.json` to **`newsdesk.config.json`** in this folder. All settings live in this one file.
2. Fill in at least:
   - `telegram.botToken` — the token from [@BotFather](https://t.me/BotFather);
   - `telegram.channel` — `"@your_channel"`; make the bot an admin of the channel with the right to post;
   - `sources` — public channels to watch;
   - `llm` — `backend: "openai"`, `apiBaseUrl` (ending in `/v1`), `apiKey`, `filterModel`, `writerModel`.
     For example OpenRouter: `https://openrouter.ai/api/v1` and a key from <https://openrouter.ai/keys>;
   - `editorial.footer` — the signature under each post, or `""`.

   Then run `newsdesk config check`: it lists every value that is still a placeholder or cannot work.
3. Run `start.bat` (Windows) or `./start.sh` (Linux, macOS).
4. The window shows `/start <code>`: send it to your bot. From then on the bot works only with you.

Telegram blocked on your network? Set `network.proxy` to `"http://user:password@host:port"` or to `"env"`.

`newsdesk.config.json` holds your tokens in plain text: never share or commit it. History and memory are in the `data` folder next to it.

## Commands

```
newsdesk status            what is going on, and any problems
newsdesk sources           source channels
newsdesk add @channel      add a channel (remove, pause, resume work the same way)
newsdesk queue             proposals waiting for a decision (queue filtered: what was dropped)
newsdesk show 12           draft and sources of story 12
newsdesk publish 12        publish
newsdesk reject 12 reason  reject
newsdesk restore 12        bring a dropped or failed story back
newsdesk reset --yes       clean start: watch only what appears from now on
newsdesk llm-test          check that the model answers
newsdesk config check      check the config file
newsdesk help              every command
```

On Windows open a console in this folder (type `cmd` in the Explorer address bar and press Enter); in PowerShell write `.\newsdesk status`. On Linux and macOS use `node newsdesk.mjs <command>`. The commands work while the service is running in another window.

Only one copy of the service may run with a given bot token.

---

## Русский

ИИ-редакция одним файлом для Node.js. Следит за открытыми Telegram-каналами,
не предлагает повторно то, что у вас уже было, пишет посты в стиле вашего канала
и публикует их после того, как вы нажмёте **«Разместить»** в боте. Полная
документация: <https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI/blob/main/README.ru.md>.

### Что здесь лежит

| Файл | Что это |
|---|---|
| `newsdesk.mjs` | Вся программа, зависимости внутри. |
| `newsdesk.config.example.json` | Все настройки со значениями по умолчанию и заглушками. |
| `start.bat` | Windows: запускает сервис и перезапускает, если он остановится. |
| `newsdesk.bat` | Windows: разовые команды (`newsdesk status`, `newsdesk add @канал`, …). |
| `start.sh` | Linux и macOS: запускает сервис и перезапускает, если он остановится. |

Нужен **Node.js 22.13 или новее**: <https://nodejs.org/>.

### Запуск

1. Скопируйте `newsdesk.config.example.json` в **`newsdesk.config.json`** в этой же папке. Все настройки — в этом одном файле.
2. Заполните как минимум:
   - `telegram.botToken` — токен от [@BotFather](https://t.me/BotFather);
   - `telegram.channel` — `"@ваш_канал"`; сделайте бота администратором канала с правом публикации;
   - `sources` — открытые каналы, за которыми следить;
   - `llm` — `backend: "openai"`, `apiBaseUrl` (с `/v1` на конце), `apiKey`, `filterModel`, `writerModel`.
     Например, OpenRouter: `https://openrouter.ai/api/v1` и ключ с <https://openrouter.ai/keys>;
   - `editorial.footer` — подпись под каждым постом или `""`.

   Затем выполните `newsdesk config check`: он перечислит все значения, которые остались заглушками или не смогут работать.
3. Запустите `start.bat` (Windows) или `./start.sh` (Linux, macOS).
4. В окне появится `/start <код>`: отправьте это своему боту. После этого бот работает только с вами.

Telegram заблокирован в вашей сети? Укажите `network.proxy`: `"http://логин:пароль@адрес:порт"` или `"env"`.

В `newsdesk.config.json` ваши токены лежат открытым текстом: никому его не передавайте и не выкладывайте. История и память — в папке `data` рядом с ним.

### Команды

```
newsdesk status            что происходит и какие есть проблемы
newsdesk sources           каналы-источники
newsdesk add @канал        добавить канал (так же работают remove, pause, resume)
newsdesk queue             что ждёт решения (queue filtered — что отсеяно)
newsdesk show 12           черновик и источники сюжета №12
newsdesk publish 12        опубликовать
newsdesk reject 12 причина отклонить
newsdesk restore 12        вернуть в работу отсеянный или неудавшийся сюжет
newsdesk reset --yes       начать с чистого листа: следить только за новым с этого момента
newsdesk llm-test          проверить, что модель отвечает
newsdesk config check      проверить файл настроек
newsdesk help              все команды
```

На Windows откройте консоль в этой папке (введите `cmd` в адресной строке Проводника и нажмите Enter); в PowerShell пишите `.\newsdesk status`. На Linux и macOS: `node newsdesk.mjs <команда>`. Команды работают, пока сервис запущен в другом окне.

С одним токеном бота может работать только одна копия сервиса.
