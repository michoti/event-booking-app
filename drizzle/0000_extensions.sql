-- pgvector: free semantic search inside Postgres. On Supabase it lives in the "extensions" schema.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
  ELSE
    CREATE EXTENSION IF NOT EXISTS vector;
  END IF;
END $$;
--> statement-breakpoint

-- uuidv7() is native in PostgreSQL 18 only. Supabase (15/17) and PGlite need this shim.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
    CREATE FUNCTION public.uuidv7() RETURNS uuid LANGUAGE sql VOLATILE AS $f$
      SELECT encode(
        set_bit(set_bit(
          overlay(uuid_send(gen_random_uuid())
                  placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                  FROM 1 FOR 6),
          52, 1), 53, 1),
        'hex')::uuid
    $f$;
  END IF;
END $$;
