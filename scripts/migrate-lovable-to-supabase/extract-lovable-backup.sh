#!/usr/bin/env bash
# Convert Lovable's Export data archive into a safe, transactional SQL import.
# Source is read-only. Storage files are deliberately excluded: migrate them
# through the Storage API after the database import.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./00-config.sh

BACKUP="${BACKUP:-}"
RESET="${RESET:-0}"
if [[ -z "$BACKUP" || ! -f "$BACKUP" ]]; then
  echo "Usage: BACKUP=/absolute/path/maxora.backup ./extract-lovable-backup.sh" >&2
  exit 64
fi
if [[ -z "${SOURCE_URL:-}" || -z "${TARGET_URL:-}" ]]; then
  echo "SOURCE_URL and TARGET_URL must be set in 00-config.sh" >&2
  exit 64
fi

OUT="${OUT:-$WORKDIR/import}"
STAGE="$OUT/.stage"
mkdir -p "$STAGE"
cp -f "$BACKUP" "$STAGE/source.backup"

stage_host="$STAGE"
if command -v cygpath >/dev/null 2>&1; then stage_host="$(cygpath -w "$STAGE")"; fi
# Git Bash rewrites /work to a Windows host path unless path conversion is
# disabled for Docker's container-side arguments.
pgr() { MSYS_NO_PATHCONV=1 docker run --rm -v "${stage_host}:/work" "$PG_IMAGE" pg_restore "$@"; }

echo "Extracting public schema and data..."
pgr --schema=public --no-owner -f /work/public.raw.sql /work/source.backup

# Lovable roles are not present on the target; normal Supabase API roles are
# retained because RLS/PostgREST depends on their grants.
if awk '/^COPY /{inside=1} inside&&/^\\\.$/{inside=0} inside&&/sandbox_exec/{bad=1} END{exit !bad}' "$STAGE/public.raw.sql"; then
  echo "Refusing: sandbox_exec occurred in COPY data." >&2; exit 1
fi
grep -v 'sandbox_exec' "$STAGE/public.raw.sql" \
  | grep -vE '^CREATE SCHEMA "?public"?;$' \
  | grep -vE '^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ' \
  > "$OUT/02-public.sql"

echo "Extracting Auth users and identities..."
pgr --data-only --no-owner --schema=auth --table=users -f /work/auth-users.sql /work/source.backup
pgr --data-only --no-owner --schema=auth --table=identities -f /work/auth-identities.sql /work/source.backup
cat "$STAGE/auth-users.sql" "$STAGE/auth-identities.sql" > "$OUT/01-auth.sql"

if [[ "$RESET" == 1 ]]; then
  reset_sql='DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;'
else
  reset_sql="SELECT count(*) INTO n FROM pg_tables WHERE schemaname='public'; IF n > 0 THEN RAISE EXCEPTION 'target public schema is not empty; use RESET=1 only after an intentional rehearsal reset'; END IF;"
fi

cat > "$OUT/03-preflight.sql" <<SQL
BEGIN;
DO \$preflight\$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.schemata WHERE schema_name IN ('auth','storage');
  IF n <> 2 THEN RAISE EXCEPTION 'target is not a Supabase database'; END IF;
  ${reset_sql}
END \$preflight\$;
DELETE FROM auth.identities;
DELETE FROM auth.users;
CREATE SCHEMA IF NOT EXISTS public;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
SQL

cat > "$OUT/04-rewrite-urls.sql" <<SQL
DO \$rewrite\$
DECLARE old_host text := '${SOURCE_URL}'; new_host text := '${TARGET_URL}'; changed integer;
BEGIN
  -- Text and JSON values are handled only where the column type is known.
  IF to_regclass('public.admin_settings') IS NOT NULL THEN
    EXECUTE format('UPDATE public.admin_settings SET value = replace(value, %L, %L) WHERE value LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'admin_settings URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.order_items') IS NOT NULL THEN
    EXECUTE format('UPDATE public.order_items SET product_image = replace(product_image, %L, %L) WHERE product_image LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'order_items URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.products') IS NOT NULL THEN
    EXECUTE format('UPDATE public.products SET images = ARRAY(SELECT replace(image, %L, %L) FROM unnest(images) AS image) WHERE array_to_string(images, '','') LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'products image URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.product_variations') IS NOT NULL THEN
    EXECUTE format('UPDATE public.product_variations SET image_url = replace(image_url, %L, %L) WHERE image_url LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'product_variations URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.banners') IS NOT NULL THEN
    EXECUTE format('UPDATE public.banners SET image_url = replace(image_url, %L, %L) WHERE image_url LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'banners URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.categories') IS NOT NULL THEN
    EXECUTE format('UPDATE public.categories SET image_url = replace(image_url, %L, %L) WHERE image_url LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'categories URLs rewritten: %', changed;
  END IF;
  IF to_regclass('public.landing_pages') IS NOT NULL THEN
    EXECUTE format('UPDATE public.landing_pages SET hero_image = replace(hero_image, %L, %L) WHERE hero_image LIKE %L', old_host, new_host, old_host || '%');
    GET DIAGNOSTICS changed = ROW_COUNT; RAISE NOTICE 'landing_pages URLs rewritten: %', changed;
  END IF;
END \$rewrite\$;
SQL

{
  echo '-- GENERATED FILE: contains customer data and password hashes. Do not commit.'
  cat "$OUT/03-preflight.sql"
  cat "$OUT/01-auth.sql"
  cat "$OUT/02-public.sql"
  cat "$OUT/04-rewrite-urls.sql"
  echo 'COMMIT;'
} > "$OUT/maxora-import.sql"

# pg_dump 17+ guards are not needed by psql and make some import paths fail.
sed -i.bak -E '/^\\(restrict|unrestrict)/d' "$OUT/maxora-import.sql" && rm -f "$OUT/maxora-import.sql.bak"
awk '/^COPY /{t=$2; sub(/^public\./,"",t); n=0; b=1; next} b&&/^\\\.$/{print t "=" n; b=0; next} b{n++}' "$OUT/maxora-import.sql" | sort > "$OUT/expected-counts.txt"
rm -rf "$STAGE"
echo "Prepared $OUT/maxora-import.sql"
echo "Next: psql --single-transaction -v ON_ERROR_STOP=1 -d \"\$TARGET_DB_URL\" -f \"$OUT/maxora-import.sql\""
