CREATE TABLE operation_execution_migration_guard (
  check_name TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER operation_execution_migration_guard_reject
BEFORE INSERT ON operation_execution_migration_guard
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'migration_guard_failed:' || NEW.check_name);
END;

INSERT INTO operation_execution_migration_guard (check_name, is_valid)
SELECT
  'legacy_operations_must_be_reviewed',
  CASE WHEN NOT EXISTS (SELECT 1 FROM operations) THEN 1 ELSE 0 END;

DROP TRIGGER operation_execution_migration_guard_reject;
DROP TABLE operation_execution_migration_guard;

DROP TRIGGER operations_revision_increment;
DROP TRIGGER operation_steps_revision_increment;
DROP TRIGGER operations_no_delete;
DROP TRIGGER operation_steps_no_delete;

DROP TABLE locks;
DROP TABLE operation_steps;
DROP TABLE operations;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  operation_plan_id TEXT NOT NULL UNIQUE REFERENCES operation_plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN (
      'planned',
      'running',
      'applying',
      'verifying',
      'waiting_for_invitation',
      'action_required',
      'completed',
      'failed',
      'cancelled',
      'blocked'
    )
  ),
  explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT
) STRICT;

CREATE TABLE operation_steps (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'running', 'completed', 'failed', 'blocked', 'skipped')
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  UNIQUE (operation_id, position)
) STRICT;

CREATE TABLE locks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > acquired_at),
  released_at TEXT
) STRICT;

CREATE TRIGGER operations_revision_increment
BEFORE UPDATE ON operations WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;

CREATE TRIGGER operation_steps_revision_increment
BEFORE UPDATE ON operation_steps WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;

CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;

CREATE TRIGGER operation_steps_no_delete BEFORE DELETE ON operation_steps
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
