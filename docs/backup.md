# Backup and restore

The bot keeps two things that cannot be rebuilt: the notes in the vault and the
database with the log of the writes, the jobs and the summaries. Syncthing is
not a backup: it copies a mistake to every device as faithfully as it copies a
note, and it keeps no history of a file that was deleted.

## What to back up

| What | Where | Why |
| --- | --- | --- |
| The vault | `VAULT_HOST_PATH`, `/vault` in the container | the notes and the attachments |
| The database | the `app-data` volume, `/app/data/app.db` | the log of the writes, the jobs, the summaries |
| The environment | `deploy/.env` | the token of the bot, the key of the model, the id of the owner |

The environment file holds secrets. Keep it in the backup only if the backup is
encrypted and stored like a secret, or keep it apart from the other two.

## The vault

The vault is a folder of plain files, so a copy is a backup. A copy taken while
the bot is writing can catch a note in the middle of a write, which is why the
bot writes through a temporary file and a rename: a reader sees the old note or
the new one, never half of each.

```bash
# A snapshot with the date in the name, one folder per day.
rsync -a --delete /opt/obsidian-vault/ /backup/vault-$(date +%F)/
```

A file that Syncthing renamed to a conflict copy is part of the vault and is
copied with it. Those copies are the other version of a note that two devices
wrote at once, and they are the reason the bot reports them.

## The database

SQLite has a command for a copy that is consistent while the bot runs:

```bash
# The safe copy of a live database.
sqlite3 /var/lib/docker/volumes/telegram-to-obsidian-ai-agent_app-data/_data/app.db \
  ".backup '/backup/app-$(date +%F).db'"
```

A plain `cp` of a live database can catch a write in progress. The `.backup`
command takes a lock and produces a file that opens.

## The retention

| What | How long | Why |
| --- | --- | --- |
| The snapshots of the vault | 30 days, one per day | a mistake is noticed in days, not in months |
| The copies of the database | 30 days, one per day | the log of the writes is small |
| The jobs of the bot | 30 days after they finish | the table is not a history, the log of the notes is |
| The processed updates | 30 days | a retry of Telegram arrives in minutes |

The jobs and the processed updates are pruned by the bot itself. The snapshots
are pruned by whatever takes them: a `find -mtime +30 -delete` next to the copy
is enough.

## The restore

A backup that was never restored is a guess. The restore is checked by a script
that does it into a temporary folder and compares the result:

```bash
# The restore of the vault into a folder of its own, and a check of the count.
rsync -a /backup/vault-2026-11-09/ /tmp/restore-vault/
find /tmp/restore-vault -name '*.md' | wc -l

# The restore of the database, and a check that it opens and answers.
cp /backup/app-2026-11-09.db /tmp/restore-app.db
sqlite3 /tmp/restore-app.db "select count(*) from notes_log; select count(*) from jobs;"
```

The check of the database is a query against the tables the bot writes. A file
that opens but has no `notes_log` is not a restore.

## The order of a restore

1. Stop the bot: `docker compose stop app`.
2. Restore the vault into `VAULT_HOST_PATH`.
3. Restore the database into the `app-data` volume.
4. Start the bot: `docker compose start app`.
5. Look at `/health`: the database and the vault have to answer.
6. Send one message and check that the note appears.

The jobs that were running when the bot stopped are put back into the queue by
the next start, so a message that was accepted before the stop is not lost.

## What is not covered

- The backup of the server itself, its firewall and its keys. That is the job
  of the provider or of the owner, not of this project.
- The history of the vault. The snapshots are copies of a day, not a version
  control system: a note that was changed and then copied over is only in the
  snapshot of the day before.
- Syncthing. It synchronises, it does not back up. A folder that is deleted on
  one device is deleted on every device.
