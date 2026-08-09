PRAGMA foreign_keys = ON;

CREATE TABLE organization_settings (
  id TEXT PRIMARY KEY,
  organization_name TEXT NOT NULL,
  title TEXT NOT NULL,
  support_url TEXT,
  brand_mark_url TEXT,
  default_locale TEXT NOT NULL CHECK (default_locale IN ('en', 'ja')),
  max_plan_changes INTEGER NOT NULL CHECK (max_plan_changes > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'service', 'workload')),
  classification TEXT NOT NULL CHECK (
    classification IN ('member', 'managed_guest', 'external_guest', 'service_account', 'automation')
  ),
  display_name TEXT NOT NULL,
  primary_email TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'retired')),
  directory_state TEXT NOT NULL CHECK (directory_state IN ('pending', 'active', 'suspended', 'missing')),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (
    provider IN ('cloudflare_access', 'google', 'github', 'proxmox', 'zabbix', 'posix')
  ),
  issuer TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  display_name TEXT,
  email TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled', 'missing')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  UNIQUE (provider, issuer, provider_subject)
) STRICT;

CREATE INDEX idx_external_identities_subject ON external_identities(subject_id);

CREATE TABLE guest_profiles (
  subject_id TEXT PRIMARY KEY REFERENCES subjects(id) ON DELETE RESTRICT,
  sponsor_subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  external_contact_email TEXT NOT NULL,
  external_organization TEXT NOT NULL,
  purpose TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > valid_from),
  next_review_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'expired', 'retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  CHECK (subject_id <> sponsor_subject_id)
) STRICT;

CREATE INDEX idx_guest_profiles_expiration ON guest_profiles(status, expires_at);

CREATE TABLE platform_role_grants (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'auditor', 'user')),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  UNIQUE (subject_id, role)
) STRICT;

CREATE INDEX idx_platform_role_grants_active_admin
  ON platform_role_grants(subject_id)
  WHERE role = 'admin' AND active = 1;

CREATE TABLE directory_sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  customer_id TEXT NOT NULL,
  delegated_admin TEXT NOT NULL,
  credential_ref TEXT NOT NULL CHECK (
    length(credential_ref) BETWEEN 1 AND 128
    AND credential_ref NOT GLOB '*[^A-Z0-9_]*'
    AND substr(credential_ref, 1, 1) GLOB '[A-Z]'
  ),
  access_group_prefix TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  UNIQUE (provider, customer_id)
) STRICT;

CREATE TABLE directory_sync_runs (
  id TEXT PRIMARY KEY,
  directory_source_id TEXT NOT NULL REFERENCES directory_sources(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  snapshot_version TEXT,
  user_count INTEGER NOT NULL CHECK (user_count >= 0),
  group_count INTEGER NOT NULL CHECK (group_count >= 0),
  membership_count INTEGER NOT NULL CHECK (membership_count >= 0),
  violation_count INTEGER NOT NULL CHECK (violation_count >= 0),
  error_code TEXT,
  request_id TEXT NOT NULL
) STRICT;

CREATE INDEX idx_directory_sync_runs_source ON directory_sync_runs(directory_source_id, started_at DESC);

CREATE TABLE directory_sync_violations (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES directory_sync_runs(id) ON DELETE RESTRICT,
  code TEXT NOT NULL CHECK (
    code IN (
      'nested_access_group',
      'unmanaged_external_member',
      'missing_subject',
      'invalid_directory_record',
      'duplicate_immutable_id'
    )
  ),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('user', 'group', 'membership')),
  entity_id TEXT NOT NULL,
  field TEXT,
  message TEXT NOT NULL,
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_groups (
  id TEXT PRIMARY KEY,
  directory_source_id TEXT NOT NULL REFERENCES directory_sources(id) ON DELETE RESTRICT,
  provider_group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'unmanaged')),
  status TEXT NOT NULL CHECK (status IN ('active', 'missing')),
  direct_member_count INTEGER NOT NULL CHECK (direct_member_count >= 0),
  last_sync_run_id TEXT NOT NULL REFERENCES directory_sync_runs(id) ON DELETE RESTRICT,
  last_observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (directory_source_id, provider_group_id)
) STRICT;

CREATE TABLE source_group_memberships (
  id TEXT PRIMARY KEY,
  source_group_id TEXT NOT NULL REFERENCES source_groups(id) ON DELETE RESTRICT,
  provider_membership_id TEXT NOT NULL,
  member_type TEXT NOT NULL CHECK (member_type IN ('user', 'group', 'external')),
  member_provider_id TEXT NOT NULL,
  member_email TEXT,
  role TEXT NOT NULL CHECK (role IN ('MEMBER', 'MANAGER', 'OWNER')),
  status TEXT NOT NULL CHECK (status IN ('active', 'missing')),
  sync_run_id TEXT NOT NULL REFERENCES directory_sync_runs(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL,
  UNIQUE (source_group_id, provider_membership_id)
) STRICT;

CREATE INDEX idx_source_group_memberships_member ON source_group_memberships(member_provider_id, status);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  launch_url TEXT NOT NULL,
  icon_json TEXT CHECK (icon_json IS NULL OR json_valid(icon_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  visibility TEXT NOT NULL CHECK (visibility IN ('entitled', 'all_active_subjects')),
  authentication_json TEXT NOT NULL CHECK (json_valid(authentication_json)),
  provisioning_mode TEXT NOT NULL CHECK (
    provisioning_mode IN ('none', 'jit', 'observe', 'plan', 'automatic')
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE application_entitlements (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  requires_provisioning INTEGER NOT NULL CHECK (requires_provisioning IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  UNIQUE (application_id, key)
) STRICT;

CREATE TABLE entitlement_mappings (
  id TEXT PRIMARY KEY,
  source_group_id TEXT NOT NULL REFERENCES source_groups(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  valid_from TEXT,
  valid_until TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until > valid_from)
) STRICT;

CREATE TABLE entitlement_mapping_entitlements (
  mapping_id TEXT NOT NULL REFERENCES entitlement_mappings(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL REFERENCES application_entitlements(id) ON DELETE RESTRICT,
  PRIMARY KEY (mapping_id, entitlement_id)
) STRICT;

CREATE TABLE effective_grants (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  source_group_id TEXT NOT NULL REFERENCES source_groups(id) ON DELETE RESTRICT,
  source_group_membership_id TEXT NOT NULL REFERENCES source_group_memberships(id) ON DELETE RESTRICT,
  mapping_id TEXT NOT NULL REFERENCES entitlement_mappings(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL REFERENCES application_entitlements(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'blocked')),
  calculated_at TEXT NOT NULL,
  valid_until TEXT
) STRICT;

CREATE INDEX idx_effective_grants_subject ON effective_grants(subject_id, status);
CREATE UNIQUE INDEX idx_effective_grants_active
  ON effective_grants(subject_id, mapping_id, entitlement_id)
  WHERE status = 'active';

CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'proxmox', 'zabbix', 'posix')),
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'plan', 'automatic')),
  credential_ref TEXT CHECK (
    credential_ref IS NULL OR (
      length(credential_ref) BETWEEN 1 AND 128
      AND credential_ref NOT GLOB '*[^A-Z0-9_]*'
      AND substr(credential_ref, 1, 1) GLOB '[A-Z]'
    )
  ),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  subject_id TEXT REFERENCES subjects(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  login TEXT,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending_invitation', 'suspended', 'missing')),
  observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_connection_id, external_id)
) STRICT;

CREATE TABLE provisioning_targets (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  application_entitlement_id TEXT NOT NULL REFERENCES application_entitlements(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (
    target_type IN (
      'github_organization_membership',
      'github_team_membership',
      'proxmox_group_membership',
      'zabbix_saml_mapping',
      'zabbix_scim_membership',
      'posix_account',
      'posix_group_membership',
      'posix_sudo'
    )
  ),
  provider_target_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe', 'plan', 'automatic')),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  UNIQUE (provider_connection_id, target_type, provider_target_id)
) STRICT;

CREATE TABLE entitlement_mapping_targets (
  mapping_id TEXT NOT NULL REFERENCES entitlement_mappings(id) ON DELETE RESTRICT,
  provisioning_target_id TEXT NOT NULL REFERENCES provisioning_targets(id) ON DELETE RESTRICT,
  PRIMARY KEY (mapping_id, provisioning_target_id)
) STRICT;

CREATE TABLE provisioning_states (
  id TEXT PRIMARY KEY,
  provisioning_target_id TEXT NOT NULL REFERENCES provisioning_targets(id) ON DELETE RESTRICT,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('present', 'absent')),
  observed_state TEXT NOT NULL CHECK (observed_state IN ('unknown', 'present', 'absent')),
  status TEXT NOT NULL CHECK (
    status IN (
      'unmanaged', 'pending', 'observed', 'planned', 'applying', 'verifying', 'converged',
      'blocked', 'failed', 'drifted', 'waiting_for_login', 'waiting_for_invitation',
      'action_required', 'expired'
    )
  ),
  last_observation_id TEXT,
  last_plan_id TEXT,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  UNIQUE (provisioning_target_id, subject_id)
) STRICT;

CREATE TABLE provider_observations (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  provisioning_target_id TEXT REFERENCES provisioning_targets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
  observed_at TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  payload_ref TEXT,
  checksum TEXT NOT NULL,
  error_code TEXT,
  CHECK (payload_json IS NOT NULL OR payload_ref IS NOT NULL)
) STRICT;

CREATE TABLE operation_plans (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  provisioning_target_id TEXT NOT NULL REFERENCES provisioning_targets(id) ON DELETE RESTRICT,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  entitlement_id TEXT NOT NULL REFERENCES application_entitlements(id) ON DELETE RESTRICT,
  plan_hash TEXT NOT NULL UNIQUE,
  destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  input_revisions_json TEXT NOT NULL CHECK (json_valid(input_revisions_json)),
  status TEXT NOT NULL CHECK (status IN ('persisted', 'superseded')),
  created_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_plan_changes (
  id TEXT PRIMARY KEY,
  operation_plan_id TEXT NOT NULL REFERENCES operation_plans(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position >= 0),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  preconditions_json TEXT NOT NULL CHECK (json_valid(preconditions_json)),
  UNIQUE (operation_plan_id, position)
) STRICT;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  operation_plan_id TEXT NOT NULL REFERENCES operation_plans(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (
    status IN ('planned', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'blocked')
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
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed', 'blocked', 'skipped')),
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

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_subject_id TEXT REFERENCES subjects(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  request_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed', 'blocked')),
  previous_revision INTEGER,
  resulting_revision INTEGER,
  provider_evidence_ref TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_events_occurred_at ON audit_events(occurred_at DESC);
CREATE INDEX idx_audit_events_target ON audit_events(target_type, target_id, occurred_at DESC);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  audit_event_id TEXT NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error_code TEXT,
  UNIQUE (audit_event_id, topic)
) STRICT;

CREATE INDEX idx_outbox_pending ON outbox(created_at) WHERE status = 'pending';

CREATE TABLE outbox_delivery_receipts (
  message_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id) ON DELETE RESTRICT,
  delivered_at TEXT NOT NULL
) STRICT;

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  object_key TEXT,
  checksum TEXT,
  entity_count INTEGER CHECK (entity_count IS NULL OR entity_count >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  requested_by TEXT NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
) STRICT;
