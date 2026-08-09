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
  'active_admin_required',
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM subjects)
      OR EXISTS (
        SELECT 1
        FROM platform_role_grants grants
        JOIN subjects ON subjects.id = grants.subject_id
        WHERE grants.role = 'admin' AND grants.active = 1 AND subjects.status = 'active'
      )
    THEN 1
    ELSE 0
  END;

DROP TRIGGER access_control_migration_guard_reject;
DROP TABLE access_control_migration_guard;

CREATE TABLE mutation_guards (
  id TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER mutation_guards_reject_invalid
BEFORE INSERT ON mutation_guards
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'mutation_guard_failed');
END;

CREATE TRIGGER subjects_first_subject_active
BEFORE INSERT ON subjects
WHEN NOT EXISTS (SELECT 1 FROM subjects)
  AND NOT (NEW.status = 'active' AND NEW.kind = 'human' AND NEW.classification = 'member')
BEGIN
  SELECT RAISE(ABORT, 'first_subject_active_member_required');
END;

CREATE TRIGGER platform_role_grants_first_admin
BEFORE INSERT ON platform_role_grants
WHEN NOT EXISTS (
  SELECT 1 FROM platform_role_grants WHERE role = 'admin' AND active = 1
)
  AND NOT (NEW.role = 'admin' AND NEW.active = 1)
BEGIN
  SELECT RAISE(ABORT, 'first_active_admin_required');
END;

CREATE TRIGGER platform_role_grants_final_admin
BEFORE UPDATE OF role, active ON platform_role_grants
WHEN OLD.role = 'admin'
  AND OLD.active = 1
  AND NOT (NEW.role = 'admin' AND NEW.active = 1)
  AND NOT EXISTS (
    SELECT 1
    FROM platform_role_grants grants
    JOIN subjects ON subjects.id = grants.subject_id
    WHERE grants.id <> OLD.id
      AND grants.role = 'admin'
      AND grants.active = 1
      AND subjects.status = 'active'
  )
BEGIN
  -- D1 remote migrations reject SELECT CASE inside a trigger body.
  SELECT RAISE(ABORT, 'sole_admin_self_change_forbidden')
  WHERE NEW.updated_by = OLD.subject_id;
  SELECT RAISE(ABORT, 'final_active_admin_required');
END;

CREATE TRIGGER subjects_final_admin
BEFORE UPDATE OF status ON subjects
WHEN OLD.status = 'active'
  AND NEW.status <> 'active'
  AND EXISTS (
    SELECT 1 FROM platform_role_grants
    WHERE subject_id = OLD.id AND role = 'admin' AND active = 1
  )
  AND NOT EXISTS (
    SELECT 1
    FROM platform_role_grants grants
    JOIN subjects other_subject ON other_subject.id = grants.subject_id
    WHERE grants.subject_id <> OLD.id
      AND grants.role = 'admin'
      AND grants.active = 1
      AND other_subject.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'sole_admin_self_change_forbidden')
  WHERE NEW.updated_by = OLD.id;
  SELECT RAISE(ABORT, 'final_active_admin_required');
END;

CREATE TRIGGER guest_profiles_active_sponsor_insert
BEFORE INSERT ON guest_profiles
WHEN NOT EXISTS (
  SELECT 1 FROM subjects WHERE id = NEW.sponsor_subject_id AND status = 'active'
)
  OR NOT EXISTS (
    SELECT 1 FROM subjects
    WHERE id = NEW.subject_id AND kind = 'human' AND classification = 'managed_guest'
  )
BEGIN
  SELECT RAISE(ABORT, 'guest_active_sponsor_and_classification_required');
END;

CREATE TRIGGER guest_profiles_active_sponsor_update
BEFORE UPDATE ON guest_profiles
WHEN NOT EXISTS (
  SELECT 1 FROM subjects WHERE id = NEW.sponsor_subject_id AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'guest_active_sponsor_required');
END;

CREATE TRIGGER external_identities_immutable_key
BEFORE UPDATE ON external_identities
WHEN NEW.id <> OLD.id
  OR NEW.subject_id <> OLD.subject_id
  OR NEW.provider <> OLD.provider
  OR NEW.issuer <> OLD.issuer
  OR NEW.provider_subject <> OLD.provider_subject
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'identity_key_immutable');
END;

CREATE TRIGGER applications_immutable_key
BEFORE UPDATE ON applications
WHEN NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'application_key_immutable');
END;

CREATE TRIGGER application_entitlements_immutable_key
BEFORE UPDATE ON application_entitlements
WHEN NEW.id <> OLD.id
  OR NEW.application_id <> OLD.application_id
  OR NEW.key <> OLD.key
  OR NEW.created_at <> OLD.created_at
  OR NEW.created_by <> OLD.created_by
BEGIN
  SELECT RAISE(ABORT, 'entitlement_key_immutable');
END;

CREATE TRIGGER source_groups_immutable_key
BEFORE UPDATE ON source_groups
WHEN NEW.id <> OLD.id
  OR NEW.directory_source_id <> OLD.directory_source_id
  OR NEW.provider_group_id <> OLD.provider_group_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source_group_key_immutable');
END;

CREATE TRIGGER provider_accounts_immutable_key
BEFORE UPDATE ON provider_accounts
WHEN NEW.id <> OLD.id
  OR NEW.provider_connection_id <> OLD.provider_connection_id
  OR NEW.external_id <> OLD.external_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'provider_account_key_immutable');
END;

CREATE TRIGGER operation_plans_immutable
BEFORE UPDATE ON operation_plans
BEGIN
  SELECT RAISE(ABORT, 'plan_immutable');
END;

CREATE TRIGGER operation_plan_changes_immutable_update
BEFORE UPDATE ON operation_plan_changes
BEGIN
  SELECT RAISE(ABORT, 'plan_immutable');
END;

CREATE TRIGGER operation_plan_changes_immutable_delete
BEFORE DELETE ON operation_plan_changes
BEGIN
  SELECT RAISE(ABORT, 'plan_immutable');
END;

CREATE TRIGGER audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_append_only');
END;

CREATE TRIGGER audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_append_only');
END;

CREATE TRIGGER outbox_immutable_payload
BEFORE UPDATE ON outbox
WHEN NEW.id <> OLD.id
  OR NEW.audit_event_id <> OLD.audit_event_id
  OR NEW.topic <> OLD.topic
  OR NEW.payload_json <> OLD.payload_json
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'outbox_payload_immutable');
END;

CREATE TRIGGER subjects_revision_increment
BEFORE UPDATE ON subjects WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER external_identities_revision_increment
BEFORE UPDATE ON external_identities WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER guest_profiles_revision_increment
BEFORE UPDATE ON guest_profiles WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER platform_role_grants_revision_increment
BEFORE UPDATE ON platform_role_grants WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER organization_settings_revision_increment
BEFORE UPDATE ON organization_settings WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER directory_sources_revision_increment
BEFORE UPDATE ON directory_sources WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER source_groups_revision_increment
BEFORE UPDATE ON source_groups WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER applications_revision_increment
BEFORE UPDATE ON applications WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER application_entitlements_revision_increment
BEFORE UPDATE ON application_entitlements WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER entitlement_mappings_revision_increment
BEFORE UPDATE ON entitlement_mappings WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER provider_connections_revision_increment
BEFORE UPDATE ON provider_connections WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER provider_accounts_revision_increment
BEFORE UPDATE ON provider_accounts WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER provisioning_targets_revision_increment
BEFORE UPDATE ON provisioning_targets WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER provisioning_states_revision_increment
BEFORE UPDATE ON provisioning_states WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER operations_revision_increment
BEFORE UPDATE ON operations WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER operation_steps_revision_increment
BEFORE UPDATE ON operation_steps WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;
CREATE TRIGGER exports_revision_increment
BEFORE UPDATE ON exports WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'revision_increment_required'); END;

CREATE TRIGGER subjects_no_delete BEFORE DELETE ON subjects
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER external_identities_no_delete BEFORE DELETE ON external_identities
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER guest_profiles_no_delete BEFORE DELETE ON guest_profiles
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER platform_role_grants_no_delete BEFORE DELETE ON platform_role_grants
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER directory_sources_no_delete BEFORE DELETE ON directory_sources
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER directory_sync_runs_no_delete BEFORE DELETE ON directory_sync_runs
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER source_groups_no_delete BEFORE DELETE ON source_groups
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER source_group_memberships_no_delete BEFORE DELETE ON source_group_memberships
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER applications_no_delete BEFORE DELETE ON applications
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER application_entitlements_no_delete BEFORE DELETE ON application_entitlements
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER entitlement_mappings_no_delete BEFORE DELETE ON entitlement_mappings
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER effective_grants_no_delete BEFORE DELETE ON effective_grants
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER provider_connections_no_delete BEFORE DELETE ON provider_connections
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER provider_accounts_no_delete BEFORE DELETE ON provider_accounts
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER provisioning_targets_no_delete BEFORE DELETE ON provisioning_targets
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER provisioning_states_no_delete BEFORE DELETE ON provisioning_states
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER provider_observations_no_delete BEFORE DELETE ON provider_observations
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER operation_plans_no_delete BEFORE DELETE ON operation_plans
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER operations_no_delete BEFORE DELETE ON operations
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER operation_steps_no_delete BEFORE DELETE ON operation_steps
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
CREATE TRIGGER exports_no_delete BEFORE DELETE ON exports
BEGIN SELECT RAISE(ABORT, 'hard_delete_forbidden'); END;
