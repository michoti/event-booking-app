-- ---------------------------------------------------------------------------
-- Ephemeral carts: UNLOGGED = no WAL, very fast, emptied after a crash. That is
-- acceptable ONLY because a cart is a convenience (restores a selection after
-- sign-in). Real inventory holds are rows in the logged `bookings` table.
-- ---------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS ephemeral_carts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid,
  event_id   uuid NOT NULL,
  items      jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ephemeral_carts_expires_idx ON ephemeral_carts (expires_at);
--> statement-breakpoint
ALTER TABLE ephemeral_carts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Sweeper. `asof` defaults to now() (pg_cron); the app passes its injected clock.
-- Single source of truth for expiry; callable from pg_cron (primary),
-- the Vercel Cron route (fallback) or the local cron runner (Docker/offline).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_expired_holds(asof timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer := 0;
BEGIN
  -- One sweeper at a time (also fixes lock ordering between concurrent sweeps).
  IF NOT pg_try_advisory_xact_lock(7101) THEN RETURN 0; END IF;

  WITH expired AS (
    UPDATE bookings
       SET status = 'expired', updated_at = now(), version = version + 1
     WHERE status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < asof
    RETURNING id
  ), released AS (
    SELECT bi.ticket_type_id, sum(bi.quantity)::int AS qty
      FROM booking_items bi JOIN expired e ON e.id = bi.booking_id
     GROUP BY bi.ticket_type_id
  ), restock AS (
    UPDATE ticket_types tt
       SET quantity_sold = tt.quantity_sold - r.qty, version = tt.version + 1, updated_at = now()
      FROM released r WHERE tt.id = r.ticket_type_id
    RETURNING 1
  )
  SELECT count(*) INTO n FROM expired;
  RETURN n;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION purge_expired_carts(asof timestamptz DEFAULT now()) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  DELETE FROM ephemeral_carts WHERE expires_at < asof;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION sweep_expired(asof timestamptz DEFAULT now()) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('released_bookings', release_expired_holds(asof), 'purged_carts', purge_expired_carts(asof));
$$;
--> statement-breakpoint

-- These must not be callable through the Supabase Data API (/rest/v1/rpc/...).
REVOKE ALL ON FUNCTION release_expired_holds(timestamptz), purge_expired_carts(timestamptz), sweep_expired(timestamptz) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION release_expired_holds(timestamptz), purge_expired_carts(timestamptz), sweep_expired(timestamptz) FROM anon, authenticated';
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- pg_cron schedule. Enabled on Supabase (free). Anywhere else (PGlite, plain
-- Docker Postgres) this is a notice, and scripts/cron-local.sh or the Vercel
-- Cron route does the same job.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_cron;
      PERFORM cron.schedule('eb-sweep-expired', '30 seconds', 'select public.sweep_expired()');
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'pg_cron not scheduled (%): use the cron fallbacks', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'pg_cron not available: use the cron fallbacks';
  END IF;
END $$;
