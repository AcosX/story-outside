-- Request idempotency belongs to a session; different sessions can use the
-- same client request UUID. Preserve append-only event rows during upgrade.
ALTER TABLE session_events
  DROP INDEX IF EXISTS uq_session_events_client_request,
  ADD UNIQUE KEY uq_session_events_client_request (session_id, client_request_id);

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0007_session_event_request_scope', NULL);
