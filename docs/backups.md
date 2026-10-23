# Backups and restore

(backups)=

The production stack (`deploy/server/compose.yaml`) includes a `backup` service. It dumps the Postgres database on a schedule, rotates the dumps, can encrypt them with [age](https://age-encryption.org) and can copy them to S3-compatible storage. It is on by default; `docker compose stop backup` turns it off.

## What is backed up, and what is not

| What                                                 | Where it lives                                | Backed up?                                           |
| ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Projects, tasks, pools, runs, usage, access list     | Postgres (`pgdata` volume)                    | **Yes**, this is the whole application state         |
| `ORCH_ENCRYPTION_KEY` and every other `.env` value   | `deploy/server/.env`                          | **No. Keep it separately** (password manager, vault) |
| GitHub App private key                               | `deploy/server/secrets/github-app.pem`        | **No.** Keep a copy; it can also be regenerated      |
| TLS certificates                                     | `caddy_data` volume                           | No. Caddy gets new ones from Let's Encrypt           |
| Member agents, enrollment, Claude login, task clones | Each member's machine (`~/orch`, its volumes) | No. Nothing of it is stored on the server            |
| age private key (when you encrypt)                   | You                                           | **Never on the server.** Without it dumps are lost   |

The server stores no uploaded files, so the database is the only state that needs a dump.

```{warning}
`ORCH_ENCRYPTION_KEY` is not in the dump, on purpose. The encrypted columns (GitHub user access and refresh tokens) are unreadable without it: after a restore with a different key, everyone has to sign in with GitHub again. The data itself is fine. Store the key apart from the backups; a backup stored next to its key protects nothing.
```

## How it works

- **Schedule.** `BACKUP_SCHEDULE` is a five-field cron expression in UTC (default `0 3 * * *`, every day at 03:00). `*`, lists, ranges and steps are supported (`*/6` in the hour field is every six hours).
- **Format.** `pg_dump --format=custom --compress=6`, written as `orch-<UTC timestamp>.dump` (or `.dump.age` when encrypted) into the `backups` volume. A dump is written to a hidden `.partial` file first, so a crash never leaves a half-written backup under a real name.
- **Rotation.** The newest backup of each of the last `BACKUP_KEEP_DAILY` days (default 7), `BACKUP_KEEP_WEEKLY` ISO weeks (4) and `BACKUP_KEEP_MONTHLY` months (6) is kept; everything else is deleted. With the defaults that is about 17 files covering six months. Only files named `orch-*` are ever deleted.
- **Postgres version.** The backup image is built from `postgres:<POSTGRES_MAJOR>-alpine`, the same major as the database (16 by default), so `pg_dump` always matches the server. `POSTGRES_MAJOR` applies to both services; change it only as part of a dump/restore upgrade of the database.
- **Security.** The container runs as the unprivileged `postgres` user (uid 70) with a read-only root filesystem, `no-new-privileges` and no capabilities beyond the three its entrypoint needs to take ownership of an older root-owned volume. The database password and the S3 keys are only passed as environment variables and never appear in the logs.
- **Health.** `docker compose ps` shows `backup` as unhealthy when the last successful backup is older than twice the schedule interval (48 h for a daily schedule), or, before the first backup, when the container has been up that long. A failed upload counts as a failed backup.

```sh
docker compose ps backup                       # health
docker compose logs --tail 20 backup           # "backup: wrote orch-....dump (... bytes)"
docker compose exec backup orch-backup once    # take one now
docker compose exec backup ls -lh /backups     # list
```

To keep the dumps in a host directory instead of the volume, set `BACKUP_VOLUME=/srv/orch-backups` and `sudo mkdir -p /srv/orch-backups` (the container takes ownership of the directory at start, no `chown` needed).

## Encrypting backups

Generate a key pair **on your own machine** (not on the server):

```sh
age-keygen -o orch-backup.key       # prints: Public key: age1...
```

Put the public key in `.env` and recreate the service:

```sh
BACKUP_AGE_RECIPIENT=age1...
```

```sh
docker compose up -d backup
```

New dumps are `orch-<timestamp>.dump.age`. Older plain dumps stay readable until they rotate out. Several recipients can be given, separated by commas. Keep `orch-backup.key` somewhere safe and off the server: it is the only way to read the dumps.

## Off-site copy (S3-compatible storage)

A backup on the same host does not survive the loss of the host. With `BACKUP_S3_BUCKET` set, every backup is also uploaded with [rclone](https://rclone.org) to AWS S3, Backblaze B2, Scaleway, MinIO or any S3-compatible service:

```sh
BACKUP_S3_BUCKET=my-orch-backups
BACKUP_S3_PREFIX=orch                       # folder in the bucket, default "orch"
BACKUP_S3_ENDPOINT=https://s3.eu-west-3.amazonaws.com
BACKUP_S3_REGION=eu-west-3
BACKUP_S3_PROVIDER=AWS                      # AWS, Minio, Scaleway, Backblaze, Other (default)
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
```

Use a key limited to that bucket. Uploads never delete anything by default. Set `BACKUP_S3_PRUNE=true` to apply the same rotation to the bucket (the key then needs delete rights), or use the bucket's own lifecycle rules. Combine it with age encryption if the bucket is not yours alone.

## Restoring

`deploy/server/backup/restore.sh` replaces the database with a chosen dump. Run it on the host:

```sh
cd claude_orch/deploy/server
backup/restore.sh --list                          # dumps in the backups volume
backup/restore.sh                                 # newest dump, asks for confirmation
backup/restore.sh orch-20261022T030000Z.dump      # a specific one
backup/restore.sh ./downloaded.dump.age --identity ~/orch-backup.key --yes
```

| Argument          | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `DUMP`            | `latest` (default), a file name in the volume, or a path on the host (for example from S3) |
| `--identity FILE` | age private key, required for `.age` dumps (decrypted inside the backup container)         |
| `--yes`, `-y`     | skip the confirmation prompt (otherwise you must type `restore`)                           |
| `--list`          | list the dumps in the volume and exit                                                      |

The dump is staged in a private temporary directory created in `deploy/server` (`.restore.XXXXXX`, removed when the script exits), not in `/tmp`, which is often a small tmpfs. Set `ORCH_RESTORE_TMPDIR` to another directory with room for the dump to stage it there, for example `ORCH_RESTORE_TMPDIR=/srv/scratch backup/restore.sh`.

What it does, in order: checks that the file is a `pg_dump` archive (nothing is touched otherwise), asks for confirmation, **stops the server**, runs `pg_restore --clean --if-exists --single-transaction --exit-on-error` (all or nothing: a failure leaves the database as it was), and starts the server again. The server's entrypoint runs `prisma migrate deploy`, so restoring a dump from an older release upgrades the schema on start.

On a new host: install the stack as in {doc}`installation` with the same `.env` (notably the same `ORCH_ENCRYPTION_KEY`) and GitHub App key, start it once with `docker compose up -d postgres backup`, copy the dump to the host, then run `backup/restore.sh ./orch.dump`.

Test the whole chain now and then (restore into a scratch stack). A backup you have never restored is a hope, not a backup.

## Settings

All `BACKUP_*` variables are listed in the {ref}`server environment table <server-env>`.
