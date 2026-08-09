CREATE TABLE administration_role_migration_guard (
  check_name TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER administration_role_migration_guard_reject
BEFORE INSERT ON administration_role_migration_guard
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'migration_guard_failed:' || NEW.check_name);
END;

INSERT INTO administration_role_migration_guard (check_name, is_valid)
SELECT
  'obsolete_user_role_grants_must_be_reviewed',
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM platform_role_grants WHERE role = 'user') THEN 1
    ELSE 0
  END;

DROP TRIGGER administration_role_migration_guard_reject;
DROP TABLE administration_role_migration_guard;

CREATE TRIGGER platform_role_grants_administration_roles_insert
BEFORE INSERT ON platform_role_grants
WHEN NEW.role NOT IN ('admin', 'operator', 'auditor')
BEGIN
  SELECT RAISE(ABORT, 'administration_role_required');
END;

CREATE TRIGGER platform_role_grants_administration_roles_update
BEFORE UPDATE OF role ON platform_role_grants
WHEN NEW.role NOT IN ('admin', 'operator', 'auditor')
BEGIN
  SELECT RAISE(ABORT, 'administration_role_required');
END;

CREATE TRIGGER platform_role_grants_key_immutable
BEFORE UPDATE OF subject_id, role ON platform_role_grants
WHEN NEW.subject_id <> OLD.subject_id OR NEW.role <> OLD.role
BEGIN
  SELECT RAISE(ABORT, 'platform_role_grant_key_immutable');
END;
