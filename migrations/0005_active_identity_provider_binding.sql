CREATE TABLE identity_binding_migration_guard (
  check_name TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER identity_binding_migration_guard_reject
BEFORE INSERT ON identity_binding_migration_guard
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'migration_guard_failed:' || NEW.check_name);
END;

INSERT INTO identity_binding_migration_guard (check_name, is_valid)
SELECT
  'duplicate_active_identity_bindings_must_be_reviewed',
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM external_identities
    WHERE status IN ('pending', 'active')
    GROUP BY subject_id, provider, issuer
    HAVING count(*) > 1
  ) THEN 1 ELSE 0 END;

DROP TRIGGER identity_binding_migration_guard_reject;
DROP TABLE identity_binding_migration_guard;

CREATE UNIQUE INDEX idx_external_identities_active_subject_provider
  ON external_identities(subject_id, provider, issuer)
  WHERE status IN ('pending', 'active');
