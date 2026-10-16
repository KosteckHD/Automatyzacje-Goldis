#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
if [ -n "${DB_PASSWORD_FILE:-}" ]; then DB_PASSWORD="$(cat "$DB_PASSWORD_FILE")"; fi
if [ -n "${MIGRATOR_DB_PASSWORD_FILE:-}" ]; then MIGRATOR_DB_PASSWORD="$(cat "$MIGRATOR_DB_PASSWORD_FILE")"; fi
if [ -n "${API_DB_PASSWORD_FILE:-}" ]; then API_DB_PASSWORD="$(cat "$API_DB_PASSWORD_FILE")"; fi
if [ -n "${WORKER_DB_PASSWORD_FILE:-}" ]; then WORKER_DB_PASSWORD="$(cat "$WORKER_DB_PASSWORD_FILE")"; fi
if [ -n "${ENRICHMENT_DB_PASSWORD_FILE:-}" ]; then ENRICHMENT_DB_PASSWORD="$(cat "$ENRICHMENT_DB_PASSWORD_FILE")"; fi
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${MIGRATOR_DB_PASSWORD:?MIGRATOR_DB_PASSWORD is required}"
: "${API_DB_PASSWORD:?API_DB_PASSWORD is required}"
: "${WORKER_DB_PASSWORD:?WORKER_DB_PASSWORD is required}"
: "${ENRICHMENT_DB_PASSWORD:?ENRICHMENT_DB_PASSWORD is required}"
export PGPASSWORD="$DB_PASSWORD"

ensure_role() {
  role_name="$1"
  role_password="$2"
  exists="$(psql --no-align --tuples-only --quiet --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "SELECT 1 FROM pg_roles WHERE rolname = '$role_name'")"
  if [ "$exists" = "1" ]; then
    psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
      --set=role_name="$role_name" --set=role_password="$role_password" --file=- <<'SQL'
ALTER ROLE :"role_name" LOGIN PASSWORD :'role_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SQL
  else
    psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
      --set=role_name="$role_name" --set=role_password="$role_password" --file=- <<'SQL'
CREATE ROLE :"role_name" LOGIN PASSWORD :'role_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
SQL
  fi
}

ensure_role goldis_migrator "$MIGRATOR_DB_PASSWORD"
ensure_role goldis_api "$API_DB_PASSWORD"
ensure_role goldis_worker "$WORKER_DB_PASSWORD"
ensure_role goldis_enrichment "$ENRICHMENT_DB_PASSWORD"

# Remove every inherited membership and prior broad/default grant before rebuilding the allowlist.
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" --file=- <<'SQL'
DO $$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
      FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
     WHERE member.rolname IN ('goldis_api', 'goldis_worker', 'goldis_enrichment')
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
GRANT CONNECT ON DATABASE :"database_name" TO goldis_migrator, goldis_api, goldis_worker, goldis_enrichment;
GRANT TEMPORARY ON DATABASE :"database_name" TO goldis_migrator;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
ALTER SCHEMA public OWNER TO goldis_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO goldis_migrator;
GRANT USAGE ON SCHEMA public TO goldis_api, goldis_worker, goldis_enrichment;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;
ALTER DEFAULT PRIVILEGES FOR ROLE goldis_migrator IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, goldis_api, goldis_worker, goldis_enrichment;

DO $$
DECLARE object record;
BEGIN
  FOR object IN
    SELECT n.nspname, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND pg_get_userbyid(c.relowner) IN ('goldis', 'goldis_api', 'goldis_worker', 'goldis_enrichment')
       AND (c.relkind <> 'S' OR NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
       ))
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO goldis_migrator',
      CASE object.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      object.nspname, object.relname);
  END LOOP;
END $$;

DO $$
DECLARE object record;
BEGIN
  FOR object IN
    SELECT p.oid, n.nspname, p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) IN ('goldis', 'goldis_api', 'goldis_worker', 'goldis_enrichment')
  LOOP
    IF object.prokind = 'p' THEN
      EXECUTE format('ALTER PROCEDURE %I.%I(%s) OWNER TO goldis_migrator', object.nspname, object.proname, object.args);
    ELSIF object.prokind = 'a' THEN
      EXECUTE format('ALTER AGGREGATE %I.%I(%s) OWNER TO goldis_migrator', object.nspname, object.proname, object.args);
    ELSE
      EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO goldis_migrator', object.nspname, object.proname, object.args);
    END IF;
  END LOOP;
END $$;
SQL
