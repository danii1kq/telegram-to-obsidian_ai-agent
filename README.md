# Telegram to Obsidian AI Agent

**English** | [Русский](README-ru.md)

A private Telegram bot that turns short thoughts into notes of an Obsidian
vault. The bot is the front end, [Hermes Agent](https://hermes-agent.nousresearch.com)
is the brain, and the vault is the memory. The vault is synchronised between
the server and your laptop with Syncthing, so the notes are available
everywhere and are never locked by the bot.

The bot also keeps a small web app inside Telegram, so the notes can be read
from the phone without opening Obsidian, and it writes a summary of every day
into the file of the month.

## What it does

- You send a text message to the bot in Telegram.
- The bot passes it to Hermes Agent, which works with the vault through a set
  of MCP tools:
  - it searches the notes for something on the same topic,
  - it appends the thought to that note, or creates a new note,
  - every new note starts with the Obsidian frontmatter
    (`date` and `tags: [inbox, telegram]`),
  - names of notes that already exist become `[[wiki links]]`.
- When the message needs facts (an unknown term, prices, news, a question),
  the agent searches the web through the DuckDuckGo MCP server first and puts
  what it found into the note together with the source link.
- The bot answers with one short line: `Created note "Business ideas"`.
- A file that comes with the message (a photo, a document, a video, a voice
  message) is saved into the `attachments` folder of the vault and embedded
  into the note as `![[2026-10-22_photo_abc.jpg]]`.
- At midnight the agent writes the summary of the day into the file of the
  month, and the chat gets a short notice with a button to the Mini App.
- The notes are a small web app inside Telegram: the button in the menu of the
  chat opens the list of the notes, the search and the reading of a note.

Only the owner of the bot is allowed to use it: every message from another
user id is dropped without an answer.

## Commands

| Command | What it does |
| --- | --- |
| `/start`, `/help` | the short description of the bot |
| `/status` | the last notes the bot wrote |
| `/search coffee` | searches the vault by the name of a note and by the text inside the notes |
| `/inbox` | lists the notes that still carry the `inbox` tag |
| `/undo` | undoes the last write of the bot: an appended block is removed, an overwritten note gets its old content back, a created note is deleted |
| `/undo confirm` | deletes a created note that was changed after the bot wrote it |
| `/summary` | makes the summary of yesterday right now |
| `/summary 2026-10-20` | makes the summary of that day |
| `/language` | shows the two languages of the bot |
| `/language ru` | switches the bot to Russian, `/language en` to English |

The language of the bot is kept per user in the database. A new user gets
English, the owner of the bot gets Russian. The Mini App follows the language
of the user too.

Tags are written in the message itself: `#idea #work` end up in the
`tags` field of the frontmatter of the note, next to `inbox` and `telegram`.

## The daily summary

At midnight, in the time zone of the owner, the agent looks at the notes of
the day that is over and writes a summary of it into the file of the month,
`october_2026.md` for example:

```markdown
---
date: 2026-10-01
tags: [journal, daily]
---

# October 2026

## 2026-10-21

Note "Business ideas": a thought about coffee in the neighbourhood.
Note "Diary": an entry about a walk and a book.
```

The summary tells what was written that day, note by note. It is in the
language of the owner: an English user gets English, a Russian user gets
Russian. Every day is a section of its own, a day without a note is simply
missing in the file.

The chat only gets a short notice with a button to the Mini App. The whole
summary lives in the file of the month and in the Mini App, where it is shown
at the top of the list of the notes. When the bot was down at midnight, the
missing summaries are made after the restart.

## How the notes stay safe

The vault is synchronised by Syncthing while the agent writes into it, so a
blind write could destroy a note. Every write therefore goes through the vault
guard:

- the content is written to a temporary file and renamed over the target, so
  a reader never sees a half written note,
- when the file was just changed (the fs.watch based watcher sees it) the
  write waits a second before it starts,
- when the write fails because the file is locked, it is repeated every 500 ms,
- after the write the file is read back: if somebody changed it in the
  meantime, the write is repeated, and for an append the existing content is
  never lost,
- Syncthing conflict copies (`*.sync-conflict-*`) are reported.

The paths of the tools are resolved against the root of the vault, so a tool
call of the agent cannot write outside of it. The agent of the daily summary
gets the same tools, but every write it does is taken back: only the file of
the month is changed by the summary.

## Stack

| Part | Technology |
| --- | --- |
| Bot | [grammY](https://grammy.dev), TypeScript, long polling or a webhook |
| Agent | Hermes Agent (installed in the image), one shot mode |
| Vault tools | MCP server in Node, safe writes |
| The vault MCP server as a package | [`@danii1kq/vault-mcp`](packages/vault-mcp), it works with any MCP client |
| Web search | DuckDuckGo MCP server (`uvx duckduckgo-mcp-server`) |
| Model | OpenCode Go relay through a local proxy |
| Database | SQLite (libSQL + Drizzle ORM), audit log of the notes |
| Sync | Syncthing (linuxserver image) |
| The Mini App | React and Vite, served by the bot |
| Tests | Vitest, Biome, husky + lint-staged, GitHub Actions |

## Installation on a server

Requirements: a Linux server with Docker and Docker Compose.

1. Clone the repository and go to the deploy folder:

   ```bash
   git clone https://github.com/danii1kq/telegram-to-obsidian_ai-agent.git
   cd telegram-to-obsidian_ai-agent/deploy
   ```

2. Create the environment file and fill in the values:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

   | Variable | Meaning |
   | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | token from [@BotFather](https://t.me/BotFather) |
   | `ALLOWED_TELEGRAM_ID` | your Telegram user id, only this id is served |
   | `TELEGRAM_MODE` | `polling` by default, `webhook` when the bot has a public https address |
   | `TELEGRAM_WEBHOOK_URL` | the public https address of the webhook, for the webhook mode |
   | `TELEGRAM_WEBHOOK_SECRET` | the secret that Telegram sends with every webhook call |
   | `VAULT_HOST_PATH` | folder of the vault on the server, for example `/opt/obsidian-vault` |
   | `LLM_API_KEY` | key of the model provider |
   | `HERMES_MODEL` | model, `beam-free` by default |
   | `HERMES_FALLBACK_MODEL` | model used when the first one fails |
   | `MINI_APP_URL` | the public https address of the Mini App, for the menu button |
   | `MINI_APP_TOKEN` | the token for the browser, the address of the app carries it |
   | `DEFAULT_LANGUAGE` | the language of a user that never chose one, `en` by default |
   | `OWNER_LANGUAGE` | the language of the owner of the bot, `ru` by default |
   | `PUID` / `PGID` | owner of the notes, `1000` by default |

3. Prepare the vault folder and build the containers:

   ```bash
   mkdir -p /opt/obsidian-vault
   sudo chown -R 1000:1000 /opt/obsidian-vault
   docker compose up -d --build
   ```

4. Check that everything works:

   ```bash
   docker compose ps
   docker compose logs -f app
   ```

The first build installs Hermes Agent and takes a while. Later builds reuse
the cached layers.

The image is in the registry as well, so a deployment can skip the build:

```bash
docker pull ghcr.io/danii1kq/telegram-to-obsidian_ai-agent:latest
```

## The Mini App

The notes are also a small web app inside Telegram. The button in the menu of
the chat opens it: the list of the notes, the search and the reading of a note
with its pictures. The app follows the theme of Telegram, so it looks the same
in the light and in the dark mode.

The data is never given away: the Mini App sends the signed data of Telegram
and the backend checks it with the token of the bot. Outside of Telegram there
is no signed data, so the address of the app carries the token of the owner:

```
https://<your-host>/?token=<MINI_APP_TOKEN>
```

The frontend lives in `web/`, it is built with Vite and served by the same
process that runs the bot.

Telegram accepts only https links for a Mini App, so the app is published
through a Cloudflare tunnel. The script `deploy/tunnel.sh` starts the tunnel,
watches its address and writes it into the environment file of the deployment:

```bash
bash deploy/tunnel.sh --install
```

The same tunnel can carry the webhook of the bot: set `TELEGRAM_MODE=webhook`
and `TELEGRAM_WEBHOOK_URL=https://<the address of the tunnel>/webhook`.

## The vault MCP server as a package

The tools of the vault work with any MCP client, not only with the bot. They
are published as a separate package:

```bash
npm install -g @danii1kq/vault-mcp
OBSIDIAN_VAULT_PATH=/path/to/vault vault-mcp
```

The description of the package is in [packages/vault-mcp](packages/vault-mcp).

## Syncthing and your laptop

1. The web interface of Syncthing is on the port 8384 of the server. It is
   not open to the internet, the owner reaches it through a tunnel:

   ```bash
   ssh -L 8384:127.0.0.1:8384 user@your-server
   # then open http://127.0.0.1:8384
   ```

2. In the web interface: `Actions` -> `Show ID`, this is the id of the server.

3. On your laptop: install Syncthing, add the server as a remote device with
   that id, accept the device on the server.

4. On the server: `Actions` -> `Add Folder`, path `/vault`, give it a name
   (for example `obsidian`) and share it with the laptop.

5. On the laptop: accept the folder and point your Obsidian vault to it.

After that the notes appear on the laptop within seconds, and the bot keeps
working on the server.

## Updates

```bash
git pull
docker compose up -d --build
```

The script `deploy/deploy.sh` does exactly that, and it rolls back to the
previous image when the new container does not become healthy.

## Local development

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

The frontend of the Mini App lives in `web/`:

```bash
cd web
npm install
npm run dev     # the dev server on the port 5173
npm run build
```

The MCP server of the vault is a package of its own, it is built like this:

```bash
npm run build --prefix packages/vault-mcp
```

The bot needs a Telegram token, a model key and the Hermes Agent binary. The
smoke test of a deployment runs the whole pipeline without Telegram:

```bash
node dist/selftest.js "an idea for a business"
```

## The project

- [CONTRIBUTING.md](CONTRIBUTING.md) - how to work with the project, the rules
  of the code and the commits.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - the rules of the behaviour.
- [SECURITY.md](SECURITY.md) - how to report a problem with the security.
- [CHANGELOG.md](CHANGELOG.md) - what changed in every version.
- The releases are made with a tag: the workflow builds the image, puts it in
  the registry of GitHub and publishes the notes of the release.

## Security

- The bot answers only the ids from `ALLOWED_TELEGRAM_ID`.
- The keys live in `deploy/.env` on the server, the file is not in git.
- The model key is injected by the local proxy, the agent never sees it.
- The MCP tools cannot write outside of the vault.
- The API of the Mini App checks the signed data of Telegram with the token of
  the bot, outside of Telegram it needs the token of the owner.
- The webhook of the bot checks the secret that Telegram sends with every
  call.
- The files of the owner are stored in the vault, the bot never sends them
  anywhere.

## License

MIT. The Obsidian skill is a part of Hermes Agent (MIT, Teknium).

[Русская версия](README-ru.md)
