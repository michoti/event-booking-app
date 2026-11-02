-- Paste into the migration created by:
--   drizzle-kit generate --custom --name=hardening
-- Things Drizzle's schema DSL cannot express: triggers, append-only audit log,
-- and the baseline RBAC seed. Statement breakpoints are required by drizzle-kit.

-- ---------------------------------------------------------------------------
-- 1. Audit trigger. The app sets the actor inside each transaction with:
--      select set_config('app.actor_id', '<user uuid>', true);
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor  uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  old_j  jsonb;
  new_j  jsonb;
  ent_id text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN old_j := to_jsonb(OLD) - 'password_hash'; END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN new_j := to_jsonb(NEW) - 'password_hash'; END IF;

  ent_id := coalesce(
    coalesce(new_j, old_j)->>'id',
    (coalesce(new_j, old_j)->>'user_id') || ':' || (coalesce(new_j, old_j)->>'role_id'),
    (coalesce(new_j, old_j)->>'role_id') || ':' || (coalesce(new_j, old_j)->>'permission_id')
  );

  INSERT INTO audit_logs (actor_id, action, entity_table, entity_id, old_data, new_data)
  VALUES (actor, TG_OP, TG_TABLE_NAME, ent_id, old_j, new_j);

  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint

CREATE TRIGGER users_audit            AFTER INSERT OR UPDATE OR DELETE ON users            FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER user_roles_audit       AFTER INSERT OR UPDATE OR DELETE ON user_roles       FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER roles_permissions_audit AFTER INSERT OR UPDATE OR DELETE ON roles_permissions FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER events_audit           AFTER INSERT OR UPDATE OR DELETE ON events           FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER bookings_audit         AFTER INSERT OR UPDATE OR DELETE ON bookings         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint
CREATE TRIGGER payments_audit         AFTER INSERT OR UPDATE OR DELETE ON payments         FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Make audit_logs append-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2b. Every new user automatically gets the 'attendee' role (Auth.js creates
--     users through the adapter, so doing this in the DB is atomic and cannot be skipped).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assign_default_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_roles (user_id, role_id)
  SELECT NEW.id, r.id FROM roles r WHERE r.name = 'attendee'
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER users_default_role AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION assign_default_role();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Baseline RBAC seed (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO roles (name, description, is_system) VALUES
  ('admin',     'Full access',                              true),
  ('organizer', 'Creates and manages own events',           true),
  ('attendee',  'Browses events and manages own bookings',  true)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint

INSERT INTO permissions (key, description) VALUES
  ('event:create',       'Create events'),
  ('event:update',       'Update events'),
  ('event:delete',       'Soft-delete events'),
  ('event:publish',      'Publish or unpublish events'),
  ('booking:create',     'Create bookings'),
  ('booking:read:own',   'View own bookings'),
  ('booking:read:any',   'View any booking'),
  ('booking:cancel:own', 'Cancel own bookings'),
  ('booking:cancel:any', 'Cancel any booking'),
  ('payment:refund',     'Refund payments'),
  ('user:read',          'View users'),
  ('user:manage',        'Suspend or edit users'),
  ('role:manage',        'Assign roles and edit role permissions'),
  ('audit:read',         'View audit logs')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO roles_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO roles_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN
  ('event:create','event:update','event:delete','event:publish',
   'booking:create','booking:read:own','booking:cancel:own')
WHERE r.name = 'organizer'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO roles_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key IN
  ('booking:create','booking:read:own','booking:cancel:own')
WHERE r.name = 'attendee'
ON CONFLICT DO NOTHING;