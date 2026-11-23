# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-11-23

### Added

- Optional Telegram account for media, as in Telethon scripts: before the draft, the account forwards the source post (with its whole album) to the bot, which keeps Telegram's file ids; the forwarded copy is deleted at once. Large videos, every album item, GIFs and files are attached and published, whatever their size.
- Sign-in on the settings page (api_id, api_hash, phone, code, cloud password) and `newsdesk account login | status | logout | import-telethon` in the script; `bb newsdesk account status | logout` in bb.
- GIFs and files can be sent and published; albums of files are supported.

### Changed

- An album with one item the web preview cannot give keeps the rest instead of dropping all media.

## [1.1.0] - 2026-11-23

### Added

- The original news first: as soon as a story passes the filter, the bot sends the owner the original post (source, title, text, link with its picture) with a Reject button, before the draft is written. Rejecting it there skips the draft.
- The draft preview is sent as a reply to that original.

### Changed

- No daily quota: every story that passes the filter is drafted and sent at once. The `editorial.maxProposalsPerDay` setting is gone; configs that still have it load as before.
- After a decision the original news is deleted together with the preview and the buttons.

### Fixed

- A story rejected while its draft was being written no longer comes back as a proposal.

## [1.0.0] - 2026-11-21

First public release. The repository was briefly published as `AiXenix-Telegram-Scrapper-AI`; old links redirect here.

### Added

- Collector for public Telegram channels through `t.me/s/<channel>`, with a cursor per channel; new channels and a reset start from the present moment.
- Repeat detection by news hook: follow-ups about a published, proposed or rejected story are recorded in the filtered list with the story they repeat.
- "Propose all news" mode (default) and a stricter mode that also filters by channel topic and score.
- Drafts in the channel's voice with the source's links and media, Telegram HTML sanitizing and length limits.
- Telegram bot: preview plus Publish, Reject (with reasons), Another variant and Edit buttons; decided proposals collapse into one outcome line; owner pairing with a one-time code; forwarded posts drafted out of turn; source management commands.
- bb plugin with an admin page (queue, sources, history, filtered list, settings, status) and the `bb newsdesk` command.
- Standalone script for Windows, Linux and macOS built from the same code, with launchers and a single config file.
- Model backends: hidden bb threads on the Codex provider, a bb server over HTTP, any OpenAI-compatible API.
- Clean start (reset) from the admin page, `bb newsdesk reset --yes` and `newsdesk reset --yes`.
- Tests: unit tests, an end-to-end scenario with a strict fake Telegram, and a live scenario script.

[Unreleased]: https://github.com/AiXenix/AiXenix-Telegram-Scraper-AI/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/AiXenix/AiXenix-Telegram-Scraper-AI/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/AiXenix/AiXenix-Telegram-Scraper-AI/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/AiXenix/AiXenix-Telegram-Scraper-AI/releases/tag/v1.0.0
