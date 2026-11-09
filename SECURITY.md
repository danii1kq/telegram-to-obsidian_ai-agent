# Security policy

## The supported versions

The project is young and the versions come fast. The fix of a problem always
lands in the newest release.

| Version | Supported |
| --- | --- |
| 0.1.x | yes |
| < 0.1 | no |

## The reporting of a problem

Do not open a public issue for a problem with the security. Write to the
maintainer instead, the address is in the profile of the author of the
repository. The report should have:

- what the problem is and what an attacker gets from it,
- the steps to repeat it,
- the version of the project and of the deployment.

The maintainer answers within a few days and releases a fix as soon as it is
ready. Please give the maintainer a few days before the report becomes
public.

## What the project does with the secrets

The bot holds three secrets and none of them belongs in the repository:

| Secret | Where it lives | Who sees it |
| --- | --- | --- |
| The token of the bot | `deploy/.env` on the server, mode 600 | the bot, the server |
| The key of the model | `deploy/.env`, injected by the local proxy | the proxy, never the agent |
| The id of the allowed user | `deploy/.env` | the bot |

The keys are not written into the notes and they are redacted from the logs.

## The boundaries of the agent

The agent of the owner runs with tools, so the project keeps the boundaries
small and checks them:

- the note run has no shell and no direct file tools: it works through the
  vault MCP server and the web tools, and the vault server is the only way to a
  note,
- the vault server creates and appends, it never overwrites an existing note,
- a path is resolved to its real location before every read, write and delete,
  so a link inside the vault cannot lead outside of it. This is a check before
  the operation, not a lock: a folder that is replaced by a link between the
  check and the write is not caught by it,
- the model key is added by a local proxy, and the environment of the agent is
  an allowlist: the key, the token of the Mini App, the secret of the webhook
  and the token of the bot are not in it,
- the bot answers only the user ids from `ALLOWED_TELEGRAM_ID`,
- the API of the Mini App checks the signed data of Telegram with the token of
  the bot and then checks the id of the user against the same allowlist: a
  valid signature of a stranger is not access,
- the webhook of the bot checks the secret that Telegram sends with every
  call, and the secret is required in the webhook mode,
- the writes of the agent are atomic, so Syncthing never sees a half written
  note. Atomic is not the same as safe against a lost update: an append reads
  the note again on every attempt and checks its own block, and a note that
  another program rewrote is reported instead of being overwritten.

If you find a way around one of these rules, it is a problem with the security
of the project, please report it in private.

## What the project does not promise

- It does not promise that the agent cannot be talked into a wrong note. The
  tools are limited and the vault server refuses an overwrite, but a model can
  still write a note that is wrong, and the owner is the one who reads it.
- It does not promise exactly-once writes. A file change and a database
  transaction are not one atomic step: the bot records the run of every write
  and recovers the jobs of a stopped process, but a crash in the wrong instant
  can leave a note that the log does not know about.
- It does not promise that a link cannot be introduced between the check and
  the write. Closing that needs every file opened relative to a handle.
- It does not promise that a backup exists. The project documents how to take
  one and how to check a restore, it does not take one for you.

## The Mini App

The Mini App is a web app inside Telegram and it is open to the internet, so
it is protected in layers:

- every request of the API is checked: the signed data of Telegram, the
  session of the app or the token of the owner, and every one of them ends in
  the same checked identity,
- the session carries the identity, the reason it is trusted and the moment it
  ends; it lives in a cookie with `HttpOnly`, `SameSite=Strict` and `Secure`
  over https, it is over after a day, and the allowlist is checked again on
  every use of a session,
- the token of the owner is exchanged for a session, taken out of the address
  of the page and dropped from memory, so no later request and no image address
  repeats it,
- the expensive endpoints have a rate limit per user,
- the answers carry the security headers: the policy of the content, `nosniff`,
  the referrer policy and the policy of the permissions,
- the text of a note is cleaned with DOMPurify before it becomes html,
- a file of the owner is never a page: only the pictures are shown as
  pictures, everything else comes as a download with `nosniff`.

## The server

- The web interface of Syncthing is not open to the internet. The owner
  reaches it through an ssh tunnel: `ssh -L 8384:127.0.0.1:8384 user@server`.
  The port of the synchronisation stays open, it is protected by the keys of
  the devices.
- The health endpoint listens on `127.0.0.1` only.
- The Mini App listens on the port 8091 and is reached through the tunnel.
- The container of the bot runs as an unprivileged user, the volume of the
  notes is the only thing it may write.
- The file of the environment is mode 600 and is never in the repository.

## The audit of the 22nd of October 2026

The code was checked with the rules of the security review. The problems that
were found and what was done with them:

| Problem | What was done |
| --- | --- |
| The notes were put into the page with `dangerouslySetInnerHTML` | The html is cleaned with DOMPurify, only the marks of a note are allowed |
| A file of the owner could be sent as a page and run in the origin of the app | Only the pictures are shown as pictures, everything else comes as a download with `nosniff` |
| The webhook worked without the secret, so anybody could send updates as the owner | The secret is required in the webhook mode, the app does not start without it |
| The web interface of Syncthing was open to the internet without a password | The port is bound to `127.0.0.1`, the owner reaches it through an ssh tunnel |
| The answers of the app had no security headers | The policy of the content, `nosniff`, the referrer policy and the policy of the permissions are sent with every answer |
| The token of the owner stayed in the address of the page | It is exchanged for a session and taken out of the address |
| The cookie of the session had no flag `Secure` | The flag is set when the request comes over https |
| The token of the bot and the key of the model could land in the log | The logger hides the token of the bot, the key of the model, the header of the authorization and the token in an address |
| The search pattern of the vault had no limit | The regular expression mode is gone: a pattern is a plain substring, so a slow expression cannot take the process down |
| The sessions of the app were never thrown away | The sessions over their time are removed, there are at most fifty |
| A null byte in a message broke the start of the agent | The null bytes are cut out of the prompt |

## The audit of the 9th of November 2026

The code was checked again, with reproductions on artificial data. The
problems that were found and what was done with them:

| Problem | What was done |
| --- | --- |
| The Mini App accepted any signed Telegram user | The allowlist is passed to the API and checked before a session is opened and again on every use of a session |
| A request target that is not a URL ended the process | The parsing is inside the boundary of the server, a bad target answers 400 and the next request is served |
| The daily summary deleted the notes of the previous job | The revert by time is gone and the summary agent has no tool that writes |
| A retried append wrote a stale payload and lost an external edit | The payload is built on every attempt from the version just read, and the check looks for the id of the operation |
| A link inside the vault led outside of it | Every access resolves the real path and refuses a path outside the root, and the listing skips links |
| The agent ran with `--yolo`, the environment of the bot and no toolset limit | The environment is an allowlist, the toolsets are named, and the vault server never overwrites an existing note |
| An accepted message could be lost on a restart | The inbox is a table in SQLite, the row is written before the answer, and the jobs of a stopped process are recovered |
| The undo could not restore an overwrite and could delete an edited note | Every write of a message is kept with its text, and the delete is guarded by the hash of what the bot wrote |
| The content search held the whole vault in memory | The notes are read a few at a time and the search stops when it has enough hits |
| The images of a note were shown as text | The picture goes through the placeholder of the inline marks, and the frontend has tests |
| The search had a regular expression mode that could hang | The mode is gone, a pattern is a plain substring |
| The separate lockfile of the MCP package held a vulnerable body-parser | The dependency graph is updated and the audit of all three lockfiles runs in CI |

