# Maxora: Lovable to Supabase migration kit

This directory prepares a one-way, rollback-safe migration from the Lovable
database to the clean target project `kawthlgchigwitlarrut`. It never writes to
Lovable. Keep the Lovable project online until the new deployment is proven.
The source URL is pre-filled; copy only its publishable key from this project's
existing private `.env` into `00-config.sh`.

## Prerequisites

1. In Lovable, export **Maxora Outlet**: **Advanced settings -> Export data**.
   Unzip it and retain the `.backup` archive outside git.
2. In target Supabase Dashboard, use **Connect** to copy the **Session pooler**
   connection string. Obtain the target service-role key from API Keys.
3. Copy `00-config.sh.example` to `00-config.sh`, fill every placeholder, and
   keep it private. The source URL/key are available from the old Lovable build.
4. Docker Desktop and Git Bash/WSL are required for `pg_restore`. Node modules
   must be installed for the Storage script (`npm ci`).

## Rehearsal

```bash
BACKUP=/absolute/path/maxora.backup ./extract-lovable-backup.sh
psql --single-transaction -v ON_ERROR_STOP=1 -d "$TARGET_DB_URL" -f "$WORKDIR/import/maxora-import.sql"
set -a; source ./00-config.sh; set +a
node ./migrate-storage.mjs
psql -d "$TARGET_DB_URL" -f ./verify.sql
```

The generated import refuses a non-empty public schema by default. After a
rehearsal, only use `RESET=1` with a fresh export while the old store is frozen.
It deliberately deletes target Auth users and drops target `public`; it must
never be pointed at a shared or production database.

## Cutover

1. Pause admin edits/orders briefly and take a **new** Lovable export.
2. Run the same commands with `RESET=1`.
3. Verify rows, RLS, functions, Storage objects, product images, login, and a
   real test order.
4. Update deployed build variables `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY`, then redeploy.
5. Keep Lovable as read-only rollback for at least several days.

Existing sessions will not transfer safely; users must sign in again after the
cutover. Do not deploy the frontend until verification succeeds.
