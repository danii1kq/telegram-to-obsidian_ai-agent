# Telegram to Obsidian AI Agent

**English** | [Русский](README-ru.md)

A personal Telegram bot that turns messages, ideas and files into structured
Obsidian notes.

Telegram is the entry point, Hermes Agent processes the messages, and the
Obsidian vault keeps your knowledge. The bot finds the right notes, adds to
them or creates new ones, adds tags and links the entries to each other.

The vault is synchronised between the server and the laptop with Syncthing. You
can work with the notes in Obsidian while the bot keeps saving new entries on
the server.

For reading on the phone there is a Mini App inside Telegram: the list of the
notes, the search and the attachments are there. At midnight the bot sums up
the day and writes the summary into the monthly journal.

## What it does

### Saving thoughts and ideas

Send the bot a message - it does the rest:

- passes the text to Hermes Agent;
- finds a note about the same topic in the vault;
- adds to the existing note or creates a new one;
- adds the date and the tags to the frontmatter - the block of metadata at the
  top of the file;
- turns the mentions of existing notes into `[[wiki links]]`.

New notes get the tags `inbox` and `telegram` by default. Extra tags can be
written in the message itself: for example, `#idea #work`.

After saving the bot answers with a short confirmation:

```
Created the note "Business ideas".
```

### Searching for information on the web

If the message needs outside information - for example, it has a question, an
unknown term or a request about prices and news - the agent searches through
the DuckDuckGo MCP server.

The found information is saved in the note together with the link to the
source.

### Attachments

The bot saves photos, documents, videos and voice messages into the
`attachments` folder inside the vault and adds a link to the file into the
note:

```text
![[2026-10-22_photo_abc.jpg]]
```

### Daily summaries

Every day at midnight, in the time zone of the owner, the bot collects the
information about the entries of the day that is over and adds a short summary
to the file of the current month.

Telegram gets a notice with a button to open the Mini App. The summary itself
stays in the vault.

### The Mini App in Telegram

Open the notes right from the menu of the chat with the bot, without starting
Obsidian. The Mini App has:

- the list of the notes;
- the search;
- the reading of the notes and the pictures;
- the daily summaries at the top of the list;
- the look that follows the light or the dark theme of Telegram.

### Access for the owner only

The bot processes messages only from the allowed Telegram ID. The messages of
other users are silently ignored.

## Commands

| Command | Description |
| --- | --- |
| `/start`, `/help` | a short help about the bot |
| `/status` | the last saved notes |
| `/search coffee` | the search by the names and the content of the notes |
| `/inbox` | the notes with the `inbox` tag |
| `/undo` | undoes the last write of the bot |
| `/undo confirm` | confirms the deletion of a note the bot created, when the note was changed after that |
| `/summary` | makes the summary of yesterday |
| `/summary 2026-10-20` | makes the summary of that date |
| `/language` | the languages of the interface |
| `/language ru` | switches to Russian |
| `/language en` | switches to English |

The `/undo` command takes the kind of the last change into account:

- if the bot added text, the added block is removed;
- if the bot overwrote a note, the old content comes back;
- if the bot created a note, it is deleted.

If a note the bot created was changed in the meantime, its deletion needs a
separate confirmation: `/undo confirm`.

The language is kept in the database for every user. English is the default,
and the owner of the bot gets Russian. The Mini App uses the same language as
the bot.

## The daily summary

At midnight, in the time zone of the owner, the agent looks at the entries of
the day that is over and saves the summary into the monthly file, for example
`october_2026.md`:

```markdown
---
date: 2026-10-01
tags: [journal, daily]
---

# October 2026

## 2026-10-21

Note "Business ideas": an idea to open a coffee shop in the neighbourhood.
Note "Diary": an entry about a walk and a book.
```

The summary has a short description of what was written in every note of the
day.

- Every day is a section of its own.
- Days without entries are skipped.
- The language of the summaries is the language of the owner.
- The chat gets only a short notice with a button to the Mini App.
- In the Mini App the summaries are shown above the list of the notes.

If the bot was down at midnight, the missed summaries are made after the next
start.

## The safety of the notes during the sync

Syncthing can update the files at the same time as the agent. To lower the risk
of a damaged note and a lost change, every write goes through several layers of
protection:

- **Atomic write.** The new content is first saved to a temporary file, which
  is then renamed over the target. This avoids reading a half written note.
- **Waiting after a change.** If `fs.watch` sees a recent change of the file,
  the write is put off for a second.
- **Retries.** If the file is locked, the bot repeats the write every 500 ms.
- **Checking the result.** After the write the file is read back. If the
  synchroniser changed its content in the meantime, the operation is repeated.
  An append takes the existing content into account.
- **Watching the conflicts.** Syncthing conflict copies with names like
  `*.sync-conflict-*` are shown in the report.

The paths of the MCP tools are resolved against the root of the vault: the
agent cannot write files outside of it.

The agent that makes the daily summary uses the same tools, but its
intermediate changes are taken back. Only the update of the file of the month
stays.

## Stack

| Component | Technology |
| --- | --- |
| Telegram bot | grammY, TypeScript; long polling or a webhook |
| AI agent | Hermes Agent installed in the Docker image; a separate run for every task |
| Vault tools | MCP server in Node.js with the protected write |
| The separate MCP package | [`@danii1kq/vault-mcp`](packages/vault-mcp), it works with any MCP client |
| Web search | DuckDuckGo MCP server: `uvx duckduckgo-mcp-server` |
| Access to the model | OpenCode Go through a local proxy |
| Database | SQLite: libSQL and Drizzle ORM; the log of the operations with the notes |
| Sync | Syncthing, the LinuxServer image |
| The Mini App | React and Vite; served by the process of the bot |
| Testing and the quality of the code | Vitest, Biome, husky, lint-staged, GitHub Actions |

## Installation on a server

A Linux server with Docker and Docker Compose is needed.

### 1. Clone the repository

```bash
git clone https://github.com/danii1kq/telegram-to-obsidian_ai-agent.git
cd telegram-to-obsidian_ai-agent/deploy
```

### 2. Set the environment variables

Create `.env` from the example and limit the access to the file:

```bash
cp .env.example .env
chmod 600 .env
```

Fill in the values:

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | the token of the bot from [@BotFather](https://t.me/BotFather) |
| `ALLOWED_TELEGRAM_ID` | the Telegram ID of the owner, the only one allowed to use the bot |
| `TELEGRAM_MODE` | how the bot gets the messages: `polling` by default or `webhook` with a public HTTPS address |
| `TELEGRAM_WEBHOOK_URL` | the public HTTPS address of the webhook |
| `TELEGRAM_WEBHOOK_SECRET` | the secret that checks the webhook calls of Telegram |
| `VAULT_HOST_PATH` | the path of the vault on the server, for example `/opt/obsidian-vault` |
| `LLM_API_KEY` | the API key of the model provider |
| `HERMES_MODEL` | the main model; `beam-free` by default |
| `HERMES_FALLBACK_MODEL` | the reserve model, used when the main one does not answer |
| `MINI_APP_URL` | the public HTTPS address of the Mini App |
| `MINI_APP_TOKEN` | the token that opens the Mini App from a usual browser; it travels in the URL |
| `DEFAULT_LANGUAGE` | the language of a user that has not chosen one yet; `en` by default |
| `OWNER_LANGUAGE` | the language of the owner; `ru` by default |
| `PUID` / `PGID` | the UID and the GID of the owner of the files of the vault; `1000` by default |

### 3. Prepare the vault and start the containers

If you use the default values of `PUID` and `PGID`:

```bash
mkdir -p /opt/obsidian-vault
sudo chown -R 1000:1000 /opt/obsidian-vault
docker compose up -d --build
```

The path of the folder has to match `VAULT_HOST_PATH`, and the rights have to
match `PUID` and `PGID`.

### 4. Check the start

```bash
docker compose ps
docker compose logs -f app
```

The first build can take a while: Hermes Agent is installed into the image.
Later builds use the cached layers.

The ready image is in the GitHub Container Registry as well:

```bash
docker pull ghcr.io/danii1kq/telegram-to-obsidian_ai-agent:latest
```

## The Mini App

The Mini App opens with the button in the menu of the chat with the bot. It
lets you search and read the notes, look at the pictures and the daily
summaries.

The frontend is in the `web/` folder, it is built with Vite and served by the
same process as the bot.

### Authorization

Inside Telegram the Mini App sends the signed data of the user. The backend
checks the signature with the token of the bot.

For the access from a usual browser the token of the owner is used:

```text
https://<your-host>/?token=<MINI_APP_TOKEN>
```

### Publishing over HTTPS

The Mini App needs a public HTTPS address. The project has a script that sets
up a Cloudflare tunnel.

From the root of the repository run:

```bash
bash deploy/tunnel.sh --install
```

The script starts the tunnel, watches its address and writes it into the
environment file of the deployment.

The same tunnel can be used for the webhook of the bot. Set:

```text
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_URL=https://<the address of the tunnel>/webhook
```

## The MCP server of the vault

The tools that work with the vault are also a separate package
`@danii1kq/vault-mcp`. They can be used with any MCP client, apart from the
Telegram bot.

Install and run:

```bash
npm install -g @danii1kq/vault-mcp
OBSIDIAN_VAULT_PATH=/path/to/vault vault-mcp
```

The details are in the documentation of the package.

## Synchronisation with the laptop

The vault is synchronised with Syncthing. The bot works with the copy on the
server, and Obsidian on the laptop works with the local one.

### 1. Open the Syncthing interface on the server

The web interface works on the port 8384 and is not open to the internet. For
the connection make an SSH tunnel:

```bash
ssh -L 8384:127.0.0.1:8384 user@your-server
```

Then open in the browser:

```text
http://127.0.0.1:8384
```

### 2. Pair the devices

- In the interface of the server choose `Actions` -> `Show ID` and copy the ID
  of the device.
- Install Syncthing on the laptop.
- Add the server as a remote device with that ID.
- Accept the laptop in the interface of the server.

### 3. Set up the shared folder

- On the server add a folder with the path `/vault`, for example with the name
  `obsidian`.
- Give the laptop access to that folder.
- On the laptop accept the invitation and choose the local folder for the
  synchronisation.
- Open that folder in Obsidian as a vault.

After the synchronisation the notes are available on the laptop, and the bot
keeps working on the server.

## Updates

In the `deploy` folder run:

```bash
git pull
docker compose up -d --build
```

The script `deploy/deploy.sh` does the update automatically. If the new
container does not pass the check, the script puts the previous image back.

## Local development

### The application

From the root of the repository:

```bash
npm install
npm test
npm run lint
npm run typecheck
npm run build
```

### The Mini App

```bash
cd web
npm install
npm run dev
```

The dev server starts on the port 5173.

The build of the frontend:

```bash
npm run build
```

### The MCP server

From the root of the repository:

```bash
npm run build --prefix packages/vault-mcp
```

### A check without Telegram

To check the processing of a message without sending it through Telegram:

```bash
node dist/selftest.js "an idea for a business"
```

## The project

- [CONTRIBUTING.md](CONTRIBUTING.md) - the setup of the environment, the rules
  of the code and of the commits.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) - the rules of the behaviour of the
  contributors.
- [SECURITY.md](SECURITY.md) - how to report a vulnerability.
- [CHANGELOG.md](CHANGELOG.md) - the history of the changes.

A release is published by creating a tag. GitHub Actions builds the Docker
image, pushes it to the GitHub Container Registry and publishes the notes of
the release.

## Security

The project has the following layers of protection:

- The bot processes messages only from the Telegram ID in
  `ALLOWED_TELEGRAM_ID`.
- The secrets live in `deploy/.env` on the server and are not in Git.
- The API key of the model is added by the local proxy; the agent never gets it
  directly.
- The MCP tools are limited by the folder of the vault and cannot write files
  outside of it.
- The API of the Mini App checks the signed data of Telegram, and the access
  from a browser needs the token of the owner.
- The webhook checks the secret that Telegram sends with every call.
- The files of the notes and of the attachments live in the vault of the
  owner.

## License

The project is distributed under the MIT license.

The Obsidian skill is a part of Hermes Agent and is distributed under the MIT
license as well. The author is Teknium.

[Русская версия](README-ru.md)
