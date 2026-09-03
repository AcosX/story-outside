-- Story Outside - ClickUp 08 pending batch lifecycle.
--
-- Compatibility: MariaDB 10.6+ / 11.x, InnoDB, utf8mb4.
-- This migration extends pending_batches with the fields the application
-- needs to express:
--   * per-batch lifecycle state (queued, reserved, succeeded, failed,
--     expired, superseded)
--   * expected_revision for optimistic concurrency
--   * request_fingerprint (canonical hash of {request_uuid, payload}) so a
--     reused request id with a different payload fails closed
--   * source / source_sequence provenance so a batch can be traced to the
--     runtime that produced it
--   * item_count and committed_count for atomic stage/commit accounting
-- It also adds pending_batch_items: one row per ordered narrative beat so a
-- future DAO can persist exactly the ordered payload the runtime handed
-- over, and a per-item status (pending / committed / discarded) that lets a
-- mid-batch interrupt land cleanly on the SQL contract.
--
-- Re-runnable: columns and indexes use IF NOT EXISTS; named foreign keys
-- and checks are dropped by name before being recreated because MariaDB
-- does not support IF NOT EXISTS for ADD FOREIGN KEY.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- pending_batches extensions. Existing 0001/0003 rows have NULL audit
-- fields; backfill only NULLs so a rerun never overwrites an application's
-- value. The AFTER clauses reproduce the exact column order of
-- db/schema.sql (cosmetic, but keeps a 0001→0004 upgrade physically
-- identical to a fresh install).
ALTER TABLE pending_batches
  ADD COLUMN IF NOT EXISTS expected_revision BIGINT UNSIGNED NULL AFTER base_event_id,
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) NULL AFTER request_payload,
  ADD COLUMN IF NOT EXISTS committed_count INT UNSIGNED NULL AFTER completed_at,
  ADD COLUMN IF NOT EXISTS item_count INT UNSIGNED NULL AFTER committed_count,
  ADD COLUMN IF NOT EXISTS superseded_by CHAR(36) NULL AFTER promoted_event_id;

-- Source provenance is mandatory so a future audit can attribute the batch
-- to the runtime that produced it. Existing rows default to 'legacy'.
ALTER TABLE pending_batches
  ADD COLUMN IF NOT EXISTS source VARCHAR(64) NULL AFTER request_uuid;
UPDATE pending_batches
   SET source = COALESCE(source, 'legacy');
ALTER TABLE pending_batches
  MODIFY source VARCHAR(64) NOT NULL DEFAULT 'runtime';

UPDATE pending_batches
   SET expected_revision = COALESCE(expected_revision, 0),
       committed_count = COALESCE(committed_count, 0),
       item_count = COALESCE(item_count, 0);

ALTER TABLE pending_batches
  MODIFY expected_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  MODIFY committed_count INT UNSIGNED NOT NULL DEFAULT 0,
  MODIFY item_count INT UNSIGNED NOT NULL DEFAULT 0;

-- request_fingerprint enforces the same request id → same payload contract
-- the application layer enforces. Unique on batch_uuid is already in place.
ALTER TABLE pending_batches
  ADD UNIQUE INDEX IF NOT EXISTS uq_pending_batches_fingerprint (request_fingerprint),
  ADD KEY IF NOT EXISTS idx_pending_batches_fingerprint (request_fingerprint);

-- ClickUp 08 P1.4: provenance + counts guards on pending_batches. These
-- mirror db/schema.sql exactly so a 0001→0004 upgrade ends up equivalent to
-- a fresh install. Re-runnable: drop-by-name then recreate.
ALTER TABLE pending_batches
  DROP CONSTRAINT IF EXISTS chk_pending_batches_source,
  DROP CONSTRAINT IF EXISTS chk_pending_batches_counts;

ALTER TABLE pending_batches
  ADD CONSTRAINT chk_pending_batches_source CHECK (CHAR_LENGTH(source) > 0),
  ADD CONSTRAINT chk_pending_batches_counts CHECK (committed_count <= item_count);

-- Composite session-scoped index/FK (ClickUp 08 P1.4): a promoted event
-- must belong to the SAME session as the pending batch. session_events gets
-- a (session_id, event_id) index so pending_batches and pending_batch_items
-- can reference the pair, and pending_batches gains a composite FK from
-- (session_id, promoted_event_id) → session_events(session_id, event_id).
-- NULL promoted_event_id skips the FK check (MATCH SIMPLE).
ALTER TABLE session_events
  ADD KEY IF NOT EXISTS idx_session_events_session_event (session_id, event_id);

ALTER TABLE pending_batches
  ADD KEY IF NOT EXISTS idx_pending_batches_session_id_id (session_id, id),
  DROP FOREIGN KEY IF EXISTS fk_pending_batches_promoted_event_session;

ALTER TABLE pending_batches
  ADD CONSTRAINT fk_pending_batches_promoted_event_session
    FOREIGN KEY (session_id, promoted_event_id) REFERENCES session_events(session_id, event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Per-item table: one row per ordered narrative beat. item_seq is the
-- 0-based index inside the staged batch and MUST be unique per batch. The
-- status enum reflects the lifecycle from staged → committed / discarded.
CREATE TABLE IF NOT EXISTS pending_batch_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  item_uuid CHAR(36) NOT NULL,
  item_seq INT UNSIGNED NOT NULL,
  item_type ENUM(
    'narrative_beat',
    'tool_call'
  ) NOT NULL,
  status ENUM('pending', 'committed', 'discarded') NOT NULL DEFAULT 'pending',
  payload JSON NOT NULL,
  promoted_event_id CHAR(36) NULL,
  occurred_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pending_batch_items_uuid (item_uuid),
  UNIQUE KEY uq_pending_batch_items_batch_seq (batch_id, item_seq),
  KEY idx_pending_batch_items_batch_status (batch_id, status, item_seq),
  KEY idx_pending_batch_items_promoted_event (promoted_event_id),
  CONSTRAINT fk_pending_batch_items_batch
    FOREIGN KEY (batch_id) REFERENCES pending_batches(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pending_batch_items_promoted_event
    FOREIGN KEY (promoted_event_id) REFERENCES session_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_pending_batch_items_seq CHECK (item_seq >= 0),
  CONSTRAINT chk_pending_batch_items_payload CHECK (JSON_VALID(payload)),
  CONSTRAINT chk_pending_batch_items_committed CHECK (
    (status = 'committed' AND promoted_event_id IS NOT NULL AND occurred_at IS NOT NULL)
    OR status IN ('pending', 'discarded')
  ),
  CONSTRAINT chk_pending_batch_items_discarded CHECK (
    (status = 'discarded' AND occurred_at IS NULL AND promoted_event_id IS NULL) OR status IN ('pending', 'committed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Re-run guard: existing rows of pending_batch_items (created by an earlier
-- 0004 pass) also need the denormalized session scope so the composite FKs
-- below can enforce same-session promotion.
ALTER TABLE pending_batch_items
  ADD COLUMN IF NOT EXISTS session_id BIGINT UNSIGNED NULL AFTER batch_id;

UPDATE pending_batch_items pbi
  JOIN pending_batches pb ON pb.id = pbi.batch_id
   SET pbi.session_id = pb.session_id
 WHERE pbi.session_id IS NULL;

ALTER TABLE pending_batch_items
  MODIFY session_id BIGINT UNSIGNED NOT NULL;

-- Drop legacy-name constraints before re-create (kept here for symmetry with
-- 0001/0003 pattern, even though no named constraint is required).
ALTER TABLE pending_batch_items
  DROP CONSTRAINT IF EXISTS chk_pending_batch_items_committed,
  DROP CONSTRAINT IF EXISTS chk_pending_batch_items_discarded;

ALTER TABLE pending_batch_items
  ADD CONSTRAINT chk_pending_batch_items_committed CHECK (
    (status = 'committed' AND promoted_event_id IS NOT NULL AND occurred_at IS NOT NULL)
    OR status IN ('pending', 'discarded')
  ),
  ADD CONSTRAINT chk_pending_batch_items_discarded CHECK (
    (status = 'discarded' AND occurred_at IS NULL AND promoted_event_id IS NULL) OR status IN ('pending', 'committed')
  );

-- ClickUp 08 P1.4 item-state guards:
--   * chk_pending_batch_items_pending: a pending row must NOT carry a
--     promoted_event_id / occurred_at (only committed rows may).
--   * chk_pending_batch_items_tool_commit: a tool_call item can never be
--     'committed' — tool calls never become canonical events, so they have
--     no promoted_event_id to satisfy chk_pending_batch_items_committed.
--   * Composite FKs bind the item to its batch's session and force a
--     committed item's promoted_event_id to resolve to an event of that
--     SAME session (cross-session promotion is rejected by the database,
--     not just documented).
ALTER TABLE pending_batch_items
  DROP CONSTRAINT IF EXISTS chk_pending_batch_items_pending,
  DROP CONSTRAINT IF EXISTS chk_pending_batch_items_tool_commit,
  DROP FOREIGN KEY IF EXISTS fk_pending_batch_items_batch,
  DROP FOREIGN KEY IF EXISTS fk_pending_batch_items_session_batch,
  DROP FOREIGN KEY IF EXISTS fk_pending_batch_items_promoted_event,
  DROP FOREIGN KEY IF EXISTS fk_pending_batch_items_promoted_event_session;

ALTER TABLE pending_batch_items
  ADD CONSTRAINT fk_pending_batch_items_batch
    FOREIGN KEY (batch_id) REFERENCES pending_batches(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_pending_batch_items_session_batch
    FOREIGN KEY (session_id, batch_id) REFERENCES pending_batches(session_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_pending_batch_items_promoted_event
    FOREIGN KEY (promoted_event_id) REFERENCES session_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_pending_batch_items_promoted_event_session
    FOREIGN KEY (session_id, promoted_event_id) REFERENCES session_events(session_id, event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT chk_pending_batch_items_pending CHECK (
    (status = 'pending' AND promoted_event_id IS NULL AND occurred_at IS NULL)
    OR status IN ('committed', 'discarded')
  ),
  ADD CONSTRAINT chk_pending_batch_items_tool_commit CHECK (
    item_type <> 'tool_call' OR status <> 'committed'
  );

-- application_status mirrors the lifecycle for fast lookups; the existing
-- status enum already covers queued/reserved/succeeded/failed/expired/
-- superseded, so we do NOT change it. We only add a stricter check that
-- terminal rows have completed_at.
--
-- Defensive backfill FIRST: 0001-era rows may already carry a terminal
-- status without completed_at (the timestamp was only enforced from 0004
-- on). Adding chk_pending_batches_completed without this backfill would
-- make the migration fail on such pre-existing rows. Fill ONLY NULLs —
-- a rerun never overwrites an application value, keeping the migration
-- re-runnable.
UPDATE pending_batches
   SET completed_at = COALESCE(updated_at, CURRENT_TIMESTAMP(6))
 WHERE status IN ('succeeded', 'failed', 'expired', 'superseded')
   AND completed_at IS NULL;

ALTER TABLE pending_batches
  DROP CONSTRAINT IF EXISTS chk_pending_batches_completed;

ALTER TABLE pending_batches
  ADD CONSTRAINT chk_pending_batches_completed CHECK (
    (status IN ('succeeded', 'failed', 'expired', 'superseded') AND completed_at IS NOT NULL)
    OR status IN ('queued', 'reserved')
  );

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0004_pending_batch_lifecycle', NULL);
