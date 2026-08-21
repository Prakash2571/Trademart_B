# Backup and recovery

## What is at risk, and why it is not "just a cache"

Shopify is the source of truth for products, prices and orders. It is **not** the
source of truth for anything below, all of which lives only in Trademart's
MongoDB:

| Collection | What it holds | What losing it costs |
|---|---|---|
| `automation_runs` | Every automation run: the plan, the rules used, each action's **previous** value, and the reasons | The audit trail. "Who changed this price, why, and what was it before?" becomes unanswerable, and no run can be rolled back |
| `cost_records` | Manual cost overrides, entered by hand | Real numbers that exist nowhere else. Products silently fall back to `UNKNOWN` cost and stop being priced |
| `automation_settings` | The saved rule set | Automatic (webhook) runs revert to defaults, which price nothing |
| `webhook_events` | Delivery records, dedupe keys, retry state | In-flight retries are lost; duplicate deliveries stop being recognised |
| `audit_logs` | Operator mutations | The record of who did what |
| `automation_previews` | Preview tokens | Harmless — short-lived by design |
| `automation_locks` | Concurrency locks | Harmless — self-healing on lease expiry |

The first four are irreplaceable. Nothing reconstructs a hand-entered cost or a
history of what a price used to be.

---

## Which mechanism applies to you

Trademart supports two database topologies, and they need different backup
strategies.

### A. MongoDB Atlas (the default in `deploy/.env.example`)

Atlas provides managed backups. **Use them as the primary mechanism** — they are
consistent, off-box, and restorable to a point in time, which a `mongodump` loop
is not.

Configure once, in the Atlas UI:

1. **Cluster → Backup → Enable Cloud Backup.**
   Free/M0 and M2/M5 tiers do **not** support Cloud Backup. If you are on one,
   you have **no backups at all** — use mechanism B below, or upgrade to M10+.
2. **Snapshot schedule.** The default (daily snapshot, retained 7 days) is the
   minimum acceptable setting. Recommended, matching the local policy:
   - hourly snapshots retained 2 days
   - daily retained 7 days
   - weekly retained 4 weeks
   - monthly retained 3 months
3. **Continuous Cloud Backup (PITR)** if the tier allows it. This is what turns
   "restore to last night" into "restore to 14:32, just before the bad run".
4. Record the settings you chose in your own runbook, and re-check them after any
   cluster tier change — changing tier can silently drop backup features.

Verify what is actually configured, rather than assuming:

```
Atlas UI → Cluster → Backup → Snapshots
# You are looking for: at least one snapshot from the last 24h, and a
# retention policy that is not "none".
```

Also run mechanism B as a **second, portable copy**. Atlas snapshots cannot be
restored anywhere except Atlas; a `mongodump` archive can be restored onto a
laptop, which is what you want when debugging or migrating.

### B. Mongo inside the Compose stack, or a portable second copy

The stack ships an opt-in backup service. Enable it in `deploy/.env`:

```
COMPOSE_FILE=docker-compose.yml:docker-compose.local-db.yml:docker-compose.backup.yml

# WHERE THE BACKUPS GO. Read the warning below before leaving this as the default.
BACKUP_HOST_DIR=/mnt/backup-disk/trademart

BACKUP_KEEP_DAILY=7
BACKUP_KEEP_WEEKLY=4
BACKUP_KEEP_MONTHLY=3
BACKUP_HOUR_UTC=3
```

Then:

```
cd Trademart_B/deploy
docker compose up -d mongo-backup
docker compose logs -f mongo-backup      # the first dump runs immediately
```

Retention is **7 daily, 4 weekly, 3 monthly**, implemented by
`deploy/scripts/mongo-backup.sh`.

#### ⚠️ Do not leave backups on the same disk as Mongo

`BACKUP_HOST_DIR` defaults to `./backups` so the stack works out of the box. That
directory is on the **same physical disk as the Mongo volume**. It protects you
from a bad migration or a dropped collection. It does **not** protect you from a
disk failure, an accidental `docker volume rm`, or losing the host — the failures
where you most need a backup.

Point it at another device, and get a copy off the machine entirely:

```bash
# Separate physical disk on the same host
BACKUP_HOST_DIR=/mnt/backup-disk/trademart

# Off-box, nightly. Run on the HOST (not in a container), after the 03:00 dump.
30 3 * * *  rsync -az --delete /mnt/backup-disk/trademart/ backups@offsite:/trademart/

# Or object storage
30 3 * * *  rclone sync /mnt/backup-disk/trademart remote:trademart-backups
```

---

## Safety properties of the backup script

These are deliberate, and each exists because of a way backups usually fail:

- **Written to `.partial`, renamed only on success.** A truncated archive that
  looks complete is worse than no archive, because it will be trusted.
- **Every archive is verified before it is kept** (`mongorestore --dryRun`, or a
  `gzip -t` integrity test where `--dryRun` is unavailable). An unverified backup
  is a guess.
- **Implausibly small archives are rejected.** A near-empty dump usually means
  authentication succeeded against the wrong database.
- **Retention runs only after a verified new backup exists.** A job that has
  started failing can never age out the last good copy.
- **The healthcheck fails when no backup is newer than 48h.** A backup job that
  has been silently dying looks exactly like one that is working, right up until
  the day you need it.
- **Credentials are passed via the environment, never argv,** so the URI does not
  appear in `ps`.

---

## Restore procedure

> Restoring **overwrites data**. Read the whole procedure before starting.

### 0. Stop writing first

```bash
cd Trademart_B/deploy
docker compose stop backend
```

Leave `nginx` and `frontend` running if you want the site to stay up; `/api`
routes will fail while the backend is down, which is preferable to restoring
underneath a live writer.

### 1. Choose an archive

```bash
ls -lh /mnt/backup-disk/trademart/daily/
# trademart-20260821T030000Z.archive.gz
```

### 2. Take a safety copy of the CURRENT state

Non-negotiable. If the restore turns out to be the wrong archive, this is the
only way back.

```bash
docker compose run --rm \
  -v /mnt/backup-disk/trademart:/backups \
  mongo-backup \
  mongodump --uri="$MONGODB_URI" \
            --archive=/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).archive.gz --gzip
```

### 3. Dry-run the restore

```bash
docker compose run --rm \
  -v /mnt/backup-disk/trademart:/backups \
  mongo-backup \
  mongorestore --uri="$MONGODB_URI" \
               --archive=/backups/trademart-20260821T030000Z.archive.gz \
               --gzip --dryRun --verbose
```

Read the output. It lists the collections and document counts it would write.
If a count is wildly different from what you expect, stop.

### 4. Restore

```bash
docker compose run --rm \
  -v /mnt/backup-disk/trademart:/backups \
  mongo-backup \
  mongorestore --uri="$MONGODB_URI" \
               --archive=/backups/trademart-20260821T030000Z.archive.gz \
               --gzip --drop
```

`--drop` replaces each collection in the archive. Collections **not** in the
archive are left alone — so if you are recovering from a partial loss, confirm
the archive actually contains what you are trying to restore (step 3 tells you).

### 5. Verify before letting traffic back in

```bash
docker compose up -d backend
docker compose logs --tail=50 backend      # expect "MongoDB connected"

curl -s localhost:4000/api/health/ready | jq .
# database.status must be "connected"
```

Then check the restored data is actually there, via the API rather than by
assuming:

```bash
curl -s -H "Authorization: Bearer $OPERATOR_API_KEY" \
     localhost:4000/api/automation/runs?limit=5 | jq '.data.runs | length'
curl -s -H "Authorization: Bearer $OPERATOR_API_KEY" \
     localhost:4000/api/costs | jq '.data.costs | length'
```

Finally, run the integrity check — a restore can leave Trademart's records
disagreeing with Shopify's current state, which is exactly what it reports:

```bash
curl -s -H "Authorization: Bearer $OPERATOR_API_KEY" \
     localhost:4000/api/diagnostics/integrity | jq '.data.counts'
```

### Atlas restore

Atlas UI → Cluster → **Backup → Snapshots → Restore**. Restore to a **new
cluster** rather than in place when you can: it lets you inspect the data before
committing, and leaves a way back. Then repoint `MONGODB_URI` and restart the
backend.

---

## Testing the restore

An untested restore procedure is a document, not a capability. Test it **once
now** and after any schema change, against a scratch database — never against
production:

```bash
# 1. Point at a throwaway database on the same server
export TEST_URI="mongodb://user:pass@host:27017/trademart_restore_test?authSource=admin"

# 2. Restore a real archive into it
docker compose run --rm -v /mnt/backup-disk/trademart:/backups mongo-backup \
  mongorestore --uri="$TEST_URI" \
               --archive=/backups/daily/$(ls -t /mnt/backup-disk/trademart/daily | head -1) \
               --gzip --drop

# 3. Confirm the collections that matter are populated
docker compose run --rm mongo-backup mongosh "$TEST_URI" --quiet --eval '
  ["automation_runs","cost_records","automation_settings","audit_logs"]
    .forEach(c => print(c + ": " + db.getCollection(c).countDocuments()));
'

# 4. Throw it away
docker compose run --rm mongo-backup mongosh "$TEST_URI" --quiet --eval 'db.dropDatabase()'
```

Record the date of the last successful restore test somewhere you will see it.

> **Note on this repository:** the restore test above has **not** been executed
> by the change that introduced this document — the environment it was written in
> had no Docker daemon and no MongoDB. It is written to be run as-is on the
> deployment host, and should be run once before relying on it.

---

## Backups before migrations

Trademart does **not** transform existing data at startup, and it must not start
doing so — an app that migrates opportunistically on boot will eventually migrate
during a crash loop, repeatedly, unsupervised.

If a future change needs a data migration, the order is:

1. **Back up** and verify the archive (steps above).
2. **Dry-run** the migration against a restored copy in a scratch database.
3. **Run** the migration as an explicit, separate command — never on app start.
4. **Verify** with `GET /api/diagnostics/integrity` plus a targeted query.
5. Keep the pre-migration archive until the change has been live long enough to
   trust.

---

## Retention policy summary

Also see the per-collection TTLs, which are configuration rather than backup
policy (`RETENTION_*` in `.env.example`):

| Data | Retention | Mechanism |
|---|---|---|
| Operator sessions | `SESSION_TTL_HOURS` (default 12h) | Cookie expiry; stateless |
| Automation previews | 15 min (`AUTOMATION_PREVIEW_TTL_MINUTES`) | Mongo TTL index |
| Automation locks | 15 min lease | Lease expiry |
| Idempotency keys | 48h (`RETENTION_IDEMPOTENCY_HOURS`) | Mongo TTL index |
| Webhook events | 45 days (`RETENTION_WEBHOOK_EVENT_DAYS`) | Mongo TTL index |
| Audit log | 730 days (`RETENTION_AUDIT_DAYS`) | Mongo TTL index |
| Automation runs | Kept indefinitely | Deliberate — this is the audit trail |
| Container logs | 10 MB × 5 files per service | Compose `json-file` limits |
| Backups | 7 daily / 4 weekly / 3 monthly | `mongo-backup.sh` |
