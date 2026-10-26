# Changelog

The format of this file follows [Keep a Changelog](https://keepachangelog.com),
the project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

### Changed

- The title of the file of the month is in the language of the owner now:
  `October 2026` for the English user, `Октябрь 2026` for the Russian one.
- The README is in English and the Russian version lives in `README-ru.md`,
  the two files link to each other at the top.

## [0.2.1] - 2026-10-22

The security review of the project: the findings are fixed and the boundaries
of the bot and of the Mini App are written down in SECURITY.md.

### Security

- The text of a note is cleaned with DOMPurify before it becomes the page of
  the Mini App. Only the marks of a note are allowed there.
- A file of the owner is never a page: only the pictures are shown as
  pictures, everything else comes as a download with `nosniff`.
- The webhook of the bot needs the secret of Telegram now, the application does
  not start without it.
- The web interface of Syncthing is not open to the internet any more, the
  owner reaches it through an ssh tunnel.
- Every answer of the Mini App carries the security headers: the policy of
  the content, `nosniff`, the referrer policy and the policy of the
  permissions.
- The token of the owner is exchanged for a session and taken out of the
  address of the page. The cookie of the session has the flag `Secure` over
  https, it is over after a day and there are at most fifty of them.
- The logger hides the token of the bot, the key of the model, the header of
  the authorization and the token in an address.
- The search pattern of the vault is cut at 200 characters, so a slow
  expression cannot take the process down.
- The null bytes are cut out of the prompt of the agent, they broke the start
  of the process.

## [0.2.0] - 2026-10-22

The second release: the notes get their own web app inside Telegram, the bot
speaks two languages and the day ends with a summary of what was written.

### Added

- The Mini App: a small web app inside Telegram with the list of the notes, the
  search, the reading of a note with its pictures and the summary of the day at
  the top of the list. The frontend is React and Vite, it follows the theme of
  Telegram and the icons are vectors, not emojis.
- The language of the bot: the command `/language` switches it between English
  and Russian, the choice is kept for every user. A new user gets English, the
  owner of the bot gets Russian. The Mini App follows the language too.
- The command `/search` for the notes, `/inbox` for the notes that are not
  sorted out and `/undo` to take back the last write of the bot.
- The tags of a message (`#idea`) in the frontmatter of the note.
- The files of the owner: a photo, a document, a video or a voice message is
  saved into the folder `attachments` and embedded into the note.
- The summary of the day: at midnight, in the time zone of the owner, the agent
  writes what was written that day into the file of the month,
  `october_2026.md`, one section per day. The chat only gets a notice with a
  button to the Mini App. A day without a note is missing in the file, and the
  summaries that were missed while the bot was down are made after the
  restart.
- The webhook mode next to the long polling, with the secret of Telegram.
- The vault tools as a package of their own, `@danii1kq/vault-mcp`, so they
  work with any MCP client and not only with the bot.
- The files of the open source project: the guide of the contributor, the code
  of conduct, the security policy, the templates of the issues and the pull
  requests.
- The image of the project in the registry of GitHub, one command to pull it.
- The tests of the whole chain: a message, the agent, the file in the vault and
  the log.
- The state of the bot in `/status`: the model, the number of the notes, the
  queue and the last summary.

### Fixed

- The agent does not get the token of Telegram any more. Hermes 0.22.4 started
  a gateway of its own with that token and polled Telegram in parallel, so the
  bot got a conflict from Telegram every half a minute.
- The healthcheck of the container waits for the agent now, so a deploy does not
  roll back a healthy image, and the rollback really uses the previous image.
- The menu button of the bot and the summaries that were missed are made before
  the bot starts polling.
- The signed data of Telegram is checked with both variants of the string of
  the check, so the Mini App opens in the desktop client as well.
- The assets of the Mini App are served from the root and the build of the
  frontend fails when the bundle is not in the image, so the app never opens as
  a blank page.
- The text of the Mini App follows the theme in the dark mode too, the muted
  text was black there.

[Unreleased]: https://github.com/danii1kq/telegram-to-obsidian_ai-agent/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/danii1kq/telegram-to-obsidian_ai-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/danii1kq/telegram-to-obsidian_ai-agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/danii1kq/telegram-to-obsidian_ai-agent/releases/tag/v0.1.0
