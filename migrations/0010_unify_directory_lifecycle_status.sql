PRAGMA defer_foreign_keys = ON;

DROP TRIGGER directory_sources_lifecycle_insert;
DROP TRIGGER directory_sources_lifecycle_update;

ALTER TABLE directory_sources RENAME COLUMN status TO compatibility_status;
ALTER TABLE directory_sources RENAME COLUMN lifecycle_status TO status;
ALTER TABLE directory_sources DROP COLUMN compatibility_status;

CREATE TABLE grant_input_versions (
  name TEXT PRIMARY KEY CHECK (name = 'effective_grants'),
  revision INTEGER NOT NULL CHECK (revision > 0)
) STRICT;

INSERT INTO grant_input_versions (name, revision) VALUES ('effective_grants', 1);

PRAGMA defer_foreign_keys = OFF;
