---
name: newsdesk
description: Manage the news desk for the user's Telegram channel with the `bb newsdesk` command - watched source channels, the queue of proposed posts, publishing and rejecting, settings. Use when the user asks to add or remove a source channel, asks what the bot proposed or published, wants a proposal published, rejected or rewritten, asks why a story was filtered out, or says the news bot is not working ("редакция", "новостной бот", "добавь канал", "что в очереди", "опубликуй", "почему не предложил").
---

# News desk (`bb newsdesk`)

The newsdesk plugin watches public Telegram channels, drops repeats of news
the owner already has (and, only when `editorial.proposeAll` is `false`,
off-topic or low-scoring posts), writes drafts in the voice of the user's
channel, and sends each draft to the owner in Telegram with Publish and Reject
buttons. Nothing
is published without the owner's decision. The admin page is "Редакция
новостей" in the bb sidebar.

## Commands

| Command | What it does |
|---|---|
| `bb newsdesk status` | Sources, bot, queue sizes, current problems. Start here. |
| `bb newsdesk sources` | Source channels with their state and counts |
| `bb newsdesk source add <@name or t.me link>...` | Add channels |
| `bb newsdesk source remove <channel>` | Remove a channel |
| `bb newsdesk source pause <channel>` / `source resume <channel>` | Stop and restart watching one channel |
| `bb newsdesk collect` | Check all channels now and report new posts per channel |
| `bb newsdesk queue [--status <s>] [--limit <n>]` | Stories by status; default `proposed` |
| `bb newsdesk show <id>` | Draft, notes and source posts of one story |
| `bb newsdesk publish <id>` | Publish a proposed story to the channel |
| `bb newsdesk reject <id> [--reason <text>]` | Reject a story |
| `bb newsdesk regenerate <id> [--instruction <text>]` | Ask for another draft; it is written in the background |
| `bb newsdesk restore <id>` | Bring a filtered, rejected or failed story back for drafting |
| `bb newsdesk reset --yes` | Clean start: forget collected posts, proposals, the filtered list and History (rejected stories too, so their repeats may come back), delete pending proposals from the chat, watch only what appears from now on. Published stories stay only as posts of the channel |
| `bb newsdesk config export [--with-secrets]` | Print the settings as one JSON document |
| `bb newsdesk config import <path>` | Load settings from a JSON file on the bb server |
| `bb newsdesk llm-test [--which filter\|writer]` | Check that the model answers |

`status`, `sources`, `queue` and `show` take `--json`. Statuses:
`candidate` (waiting for a draft), `proposed` (waiting for the owner),
`publishing` (being sent to the channel), `published`, `rejected`, `filtered`
(dropped, with the reason), `own` (already on the channel), `failed` (drafting
failed three times; `restore` brings it back).

## Rules

- `publish` posts to the user's real channel. Run it only when the user asks
  for that story to be published.
- Publishing, rejecting and removing sources are the owner's decisions. Do not
  make them to tidy up the queue.
- `config export --with-secrets` prints the bot token. Do not paste its output
  into the conversation; write it to a file when the user needs the file.
- `config import` replaces the config: missing `sources`, `editorial`,
  `schedule` and `network` go back to defaults, missing `telegram` and `llm`
  keep their current values, and secrets shown as `***` keep their value.
  Import a full export, not a fragment.

## How it works, for diagnosis

- Sources are read through the public web preview `t.me/s/<channel>`. A
  private channel, or one with the preview turned off, cannot be read; the
  source then shows the error in `sources`.
- With `llm.backend` `auto` or `bb-threads` (the default), model requests run
  as hidden bb threads on the Codex provider, on the subscriptions connected
  to bb; check accounts with `bb pool status`. With `llm.backend` `openai`
  they go to `llm.apiBaseUrl`; check the key, the address and the model ids.
  In both cases `status` shows the last model error and `llm-test` the exact one.
- Default mode (`editorial.proposeAll: true`): every new
  news hook is proposed; the service does not judge what is interesting. It
  drops only repeats of a hook it already knows (published, proposed,
  rejected, or already on the channel), and each repeat appears in the
  filtered list saying which story it repeats. Other details about the same
  hook count as a repeat; a new event about the same product does not.
  Posts marked as advertising are dropped too (`skipAds`).
- A new source, and every source after `reset`, starts at its latest post:
  nothing published before that moment is collected.
- A repeat is a post about the same event as a story from the last
  `editorial.memoryDays` days, whatever its status. The owner's own channel is
  read too, so posts published by hand also block repeats.
- The bot answers only its owner. Pairing: the owner sends `/start <code>`;
  the code is in `status` while no owner is set.
- If `status` says the bot is polled by another program, a second copy of the
  service (or the old script) is running with the same bot token. Only one
  may run.

## Standalone script

The same service runs outside bb as a Node.js 22.13+ script, from the same
config document. Its source is `standalone-src/` in the plugin folder;
`npm run build:standalone -- <outDir>` writes `newsdesk.mjs`, the launchers,
an example config and the README into `<outDir>` (default
`standalone-src/dist`). With `llm.backend: "bb-remote"` (or `auto` plus
`llm.bbUrl` and `llm.bbToken`) the script sends its model requests to this
plugin and uses the same subscriptions; that needs a direct network route to
the bb server, because the public bb address asks for an account login. Get
the token with `bb plugin token newsdesk`. Otherwise it uses any
OpenAI-compatible API (`llm.backend: "openai"`).

Only one copy of the service may poll a given bot token. Buttons carry the
tag of the copy that sent them, and a copy that sees another poller sends
nothing.
