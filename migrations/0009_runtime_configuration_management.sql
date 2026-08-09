-- Run after locale removal so runtime configuration targets the Japanese-only schema.
ALTER TABLE directory_sources
  ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'disabled', 'retired'));

DROP TRIGGER directory_sources_revision_increment;

UPDATE directory_sources
SET lifecycle_status = status;

CREATE TRIGGER directory_sources_revision_increment
BEFORE UPDATE ON directory_sources WHEN NEW.revision <> OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'revision_increment_required');
END;

CREATE TRIGGER directory_sources_lifecycle_insert
BEFORE INSERT ON directory_sources
WHEN (NEW.lifecycle_status = 'active' AND NEW.status <> 'active')
  OR (NEW.lifecycle_status IN ('disabled', 'retired') AND NEW.status <> 'disabled')
BEGIN
  SELECT RAISE(ABORT, 'directory_source_lifecycle_invalid');
END;

CREATE TRIGGER directory_sources_lifecycle_update
BEFORE UPDATE ON directory_sources
WHEN (NEW.lifecycle_status = 'active' AND NEW.status <> 'active')
  OR (NEW.lifecycle_status IN ('disabled', 'retired') AND NEW.status <> 'disabled')
BEGIN
  SELECT RAISE(ABORT, 'directory_source_lifecycle_invalid');
END;

CREATE TRIGGER organization_settings_immutable_key
BEFORE UPDATE ON organization_settings
WHEN NEW.id <> OLD.id
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'organization_settings_key_immutable');
END;

CREATE TRIGGER directory_sources_immutable_key
BEFORE UPDATE ON directory_sources
WHEN NEW.id <> OLD.id
  OR NEW.provider <> OLD.provider
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'directory_source_key_immutable');
END;

CREATE TRIGGER provider_connections_immutable_key
BEFORE UPDATE ON provider_connections
WHEN NEW.id <> OLD.id
  OR NEW.provider <> OLD.provider
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'provider_connection_key_immutable');
END;

CREATE TRIGGER provisioning_targets_immutable_key
BEFORE UPDATE ON provisioning_targets
WHEN NEW.id <> OLD.id
  OR NEW.provider_connection_id <> OLD.provider_connection_id
  OR NEW.target_type <> OLD.target_type
  OR NEW.provider_target_id <> OLD.provider_target_id
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'provisioning_target_key_immutable');
END;
