-- Application request ids are opaque idempotency keys, not UUID-only values.
-- Public clients currently use prefixes such as "opening-<session UUID>-0",
-- which exceed the historical CHAR(36) storage inherited from 0001.
ALTER TABLE session_events
  MODIFY COLUMN client_request_id VARCHAR(255) NULL;

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0008_client_request_id_width', NULL);
