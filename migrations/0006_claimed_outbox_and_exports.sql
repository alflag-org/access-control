CREATE TABLE delivery_claim_migration_guard (
  check_name TEXT PRIMARY KEY,
  is_valid INTEGER NOT NULL
) STRICT;

CREATE TRIGGER delivery_claim_migration_guard_reject
BEFORE INSERT ON delivery_claim_migration_guard
WHEN NEW.is_valid <> 1
BEGIN
  SELECT RAISE(ABORT, 'migration_guard_failed:' || NEW.check_name);
END;

INSERT INTO delivery_claim_migration_guard (check_name, is_valid)
SELECT
  'running_exports_must_be_reviewed',
  CASE WHEN NOT EXISTS (SELECT 1 FROM exports WHERE status = 'running') THEN 1 ELSE 0 END;

INSERT INTO delivery_claim_migration_guard (check_name, is_valid)
SELECT
  'duplicate_outbox_receipts_must_be_reviewed',
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM outbox_delivery_receipts
    GROUP BY outbox_id
    HAVING count(*) > 1
  ) THEN 1 ELSE 0 END;

DROP TRIGGER delivery_claim_migration_guard_reject;
DROP TABLE delivery_claim_migration_guard;

DROP TRIGGER outbox_immutable_payload;

CREATE TABLE outbox_next (
  id TEXT PRIMARY KEY,
  audit_event_id TEXT NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'delivered', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error_code TEXT,
  UNIQUE (audit_event_id, topic)
) STRICT;

INSERT INTO outbox_next (
  id, audit_event_id, topic, payload_json, status, attempts,
  created_at, updated_at, delivered_at, last_error_code
)
SELECT
  id, audit_event_id, topic, payload_json, status, attempts,
  created_at, updated_at, delivered_at, last_error_code
FROM outbox;

CREATE TABLE outbox_delivery_receipts_next (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox_next(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('processing', 'delivered', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  claimed_at TEXT NOT NULL,
  claim_expires_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error_code TEXT
) STRICT;

INSERT INTO outbox_delivery_receipts_next (
  outbox_id, message_id, status, attempts, claimed_at, claim_expires_at,
  delivered_at, last_error_code
)
SELECT
  receipt.outbox_id,
  receipt.message_id,
  'delivered',
  1,
  receipt.delivered_at,
  receipt.delivered_at,
  receipt.delivered_at,
  NULL
FROM outbox_delivery_receipts receipt
WHERE receipt.message_id = (
  SELECT min(candidate.message_id)
  FROM outbox_delivery_receipts candidate
  WHERE candidate.outbox_id = receipt.outbox_id
);

DROP TABLE outbox_delivery_receipts;
DROP TABLE outbox;
ALTER TABLE outbox_next RENAME TO outbox;
ALTER TABLE outbox_delivery_receipts_next RENAME TO outbox_delivery_receipts;

CREATE INDEX idx_outbox_pending ON outbox(created_at) WHERE status = 'pending';

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

CREATE TRIGGER outbox_status_transition
BEFORE UPDATE ON outbox
WHEN OLD.status <> NEW.status
  AND NOT (
    (OLD.status = 'pending' AND NEW.status = 'dispatching')
    OR (OLD.status = 'dispatching' AND NEW.status IN ('delivered', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'pending')
  )
BEGIN
  SELECT RAISE(ABORT, 'outbox_status_transition_invalid');
END;

ALTER TABLE exports
  ADD COLUMN claim_id TEXT REFERENCES outbox(id) ON DELETE RESTRICT;

CREATE TRIGGER exports_running_claim_required
BEFORE UPDATE ON exports
WHEN NEW.status = 'running' AND NEW.claim_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'export_claim_required');
END;

CREATE TRIGGER exports_running_insert_claim_required
BEFORE INSERT ON exports
WHEN NEW.status = 'running' AND NEW.claim_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'export_claim_required');
END;

CREATE TRIGGER exports_claim_immutable
BEFORE UPDATE ON exports
WHEN OLD.claim_id IS NOT NULL AND NEW.claim_id IS NOT OLD.claim_id
BEGIN
  SELECT RAISE(ABORT, 'export_claim_immutable');
END;

CREATE TRIGGER exports_status_transition
BEFORE UPDATE ON exports
WHEN OLD.status <> NEW.status
  AND NOT (
    (OLD.status = 'planned' AND NEW.status = 'running')
    OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed'))
  )
BEGIN
  SELECT RAISE(ABORT, 'export_status_transition_invalid');
END;
