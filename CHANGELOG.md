# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-21

First public release.

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

[Unreleased]: https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AiXenix/AiXenix-Telegram-Scrapper-AI/releases/tag/v1.0.0
