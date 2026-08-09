CREATE TABLE access_control_migration_guard (
  check_name TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER access_control_migration_guard_reject
BEFORE INSERT ON access_control_migration_guard
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'migration_guard_failed:' || NEW.check_name);
END;

INSERT INTO access_control_migration_guard (check_name, is_valid)
SELECT
  'legacy_operation_plans_must_be_reviewed',
  CASE WHEN NOT EXISTS (SELECT 1 FROM operation_plans) THEN 1 ELSE 0 END;

DROP TRIGGER access_control_migration_guard_reject;
DROP TABLE access_control_migration_guard;

ALTER TABLE operation_plans
  ADD COLUMN provisioning_state_id TEXT NOT NULL REFERENCES provisioning_states(id) ON DELETE RESTRICT;
ALTER TABLE operation_plans
  ADD COLUMN observation_id TEXT NOT NULL REFERENCES provider_observations(id) ON DELETE RESTRICT;
ALTER TABLE operation_plans
  ADD COLUMN observation_checksum TEXT NOT NULL CHECK (
    observation_checksum GLOB 'sha256:*' AND length(observation_checksum) = 71
  );
ALTER TABLE operation_plans
  ADD COLUMN effective_grant_ids_json TEXT NOT NULL CHECK (json_valid(effective_grant_ids_json));
ALTER TABLE operation_plans
  ADD COLUMN required_target_ids_json TEXT NOT NULL CHECK (json_valid(required_target_ids_json));

CREATE INDEX idx_provider_observations_latest_complete
  ON provider_observations(
    provider_connection_id,
    provisioning_target_id,
    status,
    observed_at DESC,
    id DESC
  );
