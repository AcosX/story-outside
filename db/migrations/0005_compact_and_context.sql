-- db/migrations/0005_compact_and_context.sql — long-context compact & agent
-- context state (Story 10).
--
-- DEPENDENCY NOTE — in-memory vs SQL boundary:
-- This migration is purely additive: it never truncates session_events and
-- never relaxes the append-only triggers defined by 0001. The compact
-- summary lives on game_sessions (a column + audit log); the canonical
-- event stream is untouched. Rebuilding a compact from history is always
-- possible by re-reading session_events in event_seq order.
--
-- Invariants:
--   1. session_events remains append-only (0001 triggers stay).
--   2. pending_batches / pending_batch_items (owned by 07/08) are not
--      touched here; compact never folds staged/pending items.
--   3. All changes use IF NOT EXISTS / drop-by-name guards (columns,
--      indexes, tables, named CHECKs and the trigger) so the migration is
--      safe to run twice against the same database.
--   4. compact_compacted_events is an audit/log of which event_seqs were
--      folded into a given compact record. It is append-only at the
--      application level; it does NOT modify session_events.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- ---------------------------------------------------------------------------
-- 1. game_sessions context columns
-- ---------------------------------------------------------------------------

-- context_compact_text holds the rendered compact summary that the agent
-- runtime prepends to its provider request. context_compact_payload holds
-- the structured payload (sections + counts) so we can rebuild the
-- rendered text without re-reading session_events.
ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS context_compact_text MEDIUMTEXT NULL,
  ADD COLUMN IF NOT EXISTS context_compact_payload JSON NULL,
  ADD COLUMN IF NOT EXISTS compacted_through_seq BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS compacted_event_count INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS token_estimate INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS context_window INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS context_safety_ratio DECIMAL(5,4) NULL,
  ADD COLUMN IF NOT EXISTS reserved_completion_tokens INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS context_schema_version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prompt_version INT UNSIGNED NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_compact_at DATETIME(6) NULL,
  ADD COLUMN IF NOT EXISTS last_compact_attempt_at DATETIME(6) NULL,
  ADD COLUMN IF NOT EXISTS last_compact_status ENUM('idle', 'compacted', 'skipped', 'failed') NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS last_compact_error VARCHAR(500) NULL;

-- game_sessions context CHECKs. These five named constraints mirror
-- db/schema.sql exactly (chk_game_sessions_token_estimate /
-- context_window / safety_ratio / compact_seq / compact_payload) so a
-- 0001→0005 upgrade ends up equivalent to a fresh install. MariaDB lacks
-- ADD CONSTRAINT IF NOT EXISTS, so the named constraints are dropped by
-- name before being recreated (same re-runnable pattern as 0003/0004).
ALTER TABLE game_sessions
  DROP CONSTRAINT IF EXISTS chk_game_sessions_token_estimate,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_context_window,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_safety_ratio,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_compact_seq,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_compact_payload;

ALTER TABLE game_sessions
  ADD CONSTRAINT chk_game_sessions_token_estimate CHECK (token_estimate IS NULL OR token_estimate >= 0),
  ADD CONSTRAINT chk_game_sessions_context_window CHECK (context_window IS NULL OR context_window > 0),
  ADD CONSTRAINT chk_game_sessions_safety_ratio CHECK (context_safety_ratio IS NULL OR (context_safety_ratio >= 0 AND context_safety_ratio < 1)),
  ADD CONSTRAINT chk_game_sessions_compact_seq CHECK (compacted_through_seq IS NULL OR compacted_through_seq > 0),
  ADD CONSTRAINT chk_game_sessions_compact_payload CHECK (context_compact_payload IS NULL OR JSON_VALID(context_compact_payload));

-- compact_through_seq on game_sessions is monotonically advancing: a
-- later compact never undoes an earlier fold. The compact pipeline can
-- advance it forward or leave it unchanged; it cannot go backwards. The
-- trigger name matches db/schema.sql; the pre-review name
-- trg_game_sessions_no_compact_overwrite is dropped first so databases
-- that already ran an earlier revision of this migration upgrade cleanly
-- and the migration stays re-runnable.
DROP TRIGGER IF EXISTS trg_game_sessions_no_compact_overwrite;
DROP TRIGGER IF EXISTS trg_game_sessions_compact_monotonic;

DELIMITER $$
CREATE TRIGGER trg_game_sessions_compact_monotonic
BEFORE UPDATE ON game_sessions
FOR EACH ROW
BEGIN
  IF NEW.compacted_through_seq IS NOT NULL
     AND OLD.compacted_through_seq IS NOT NULL
     AND NEW.compacted_through_seq < OLD.compacted_through_seq THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'game_sessions.compacted_through_seq is monotonically advancing';
  END IF;
END$$
DELIMITER ;

-- Index for finding sessions that need compact (last_compact_status, model).
ALTER TABLE game_sessions
  ADD INDEX IF NOT EXISTS idx_game_sessions_compact_status (last_compact_status, model, last_compact_attempt_at);

-- ---------------------------------------------------------------------------
-- 2. compact_compacted_events: per-session audit log of folded events
-- ---------------------------------------------------------------------------
--
-- One row per (session, compact_attempt). It records which event_seqs were
-- folded into a particular compact record. It is strictly additive: rows
-- are INSERT-only and never UPDATE / DELETE (enforced by trigger below).
-- Rows from FAILED attempts are kept so operators can debug; only
-- SUCCEEDED rows count when picking the most recent good compact.

CREATE TABLE IF NOT EXISTS compact_compacted_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  attempt_uuid CHAR(36) NOT NULL,
  status ENUM('compacted', 'skipped', 'failed') NOT NULL,
  compacted_through_seq BIGINT UNSIGNED NOT NULL,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_protected INT UNSIGNED NOT NULL DEFAULT 0,
  estimated_tokens INT UNSIGNED NULL,
  context_window INT UNSIGNED NULL,
  prompt_version INT UNSIGNED NOT NULL DEFAULT 1,
  context_schema_version INT UNSIGNED NOT NULL DEFAULT 1,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(500) NULL,
  folded_event_seqs JSON NOT NULL,           -- JSON array of BIGINTs
  summary_excerpt VARCHAR(500) NULL,         -- first 500 chars of context_compact_text for grep
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_compact_compacted_events_attempt (attempt_uuid),
  KEY idx_compact_compacted_events_session (session_id, created_at),
  KEY idx_compact_compacted_events_status (status, created_at),
  KEY idx_compact_compacted_events_session_status (session_id, status, created_at),
  CONSTRAINT fk_compact_compacted_events_session FOREIGN KEY (session_id) REFERENCES game_sessions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_compact_compacted_events_event_count CHECK (event_count >= 0),
  CONSTRAINT chk_compact_compacted_events_through_seq CHECK (compacted_through_seq >= 0),
  CONSTRAINT chk_compact_compacted_events_folded_seqs CHECK (JSON_VALID(folded_event_seqs)),
  CONSTRAINT chk_compact_compacted_events_excerpt CHECK (summary_excerpt IS NULL OR CHAR_LENGTH(summary_excerpt) <= 500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- compact_compacted_events is append-only at the application level. We do
-- NOT add UPDATE/DELETE-blocking triggers here (those belong on the
-- canonical session_events table per 0001); the table is meant to be
-- inspectable for ops/debug. We DO enforce folded_event_seqs is always a
-- valid JSON array via the CHECK above.

-- ---------------------------------------------------------------------------
-- 3. model_context_windows: registry of known model context windows
-- ---------------------------------------------------------------------------
--
-- Per-model window + safety_ratio + reserved_completion_tokens used by the
-- compact pipeline. The default rows match DEFAULT_MODEL_CONTEXT_WINDOWS
-- in src/agent/tokenEstimator.mjs but the table is the source of truth for
-- future SQL-backed deployments. Updates here are NOT versioned; the
-- application caches the snapshot at compact time on game_sessions so the
-- historical decision is still auditable.

CREATE TABLE IF NOT EXISTS model_context_windows (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model VARCHAR(128) NOT NULL,
  context_window INT UNSIGNED NOT NULL,
  safety_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.1000,
  reserved_completion_tokens INT UNSIGNED NOT NULL DEFAULT 1024,
  notes VARCHAR(255) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_model_context_windows_model (model),
  KEY idx_model_context_windows_active (is_active, model),
  CONSTRAINT chk_model_context_windows_window CHECK (context_window > 0),
  CONSTRAINT chk_model_context_windows_safety CHECK (safety_ratio >= 0 AND safety_ratio < 1),
  CONSTRAINT chk_model_context_windows_reserved CHECK (reserved_completion_tokens >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed defaults that mirror src/agent/tokenEstimator.mjs. INSERT IGNORE
-- makes the migration re-runnable.
INSERT IGNORE INTO model_context_windows (model, context_window, safety_ratio, reserved_completion_tokens, notes, is_active)
VALUES
  ('anthropic/claude-sonnet-4.5', 200000, 0.1000, 1024, 'Default for Anthropic Claude Sonnet 4.5', 1),
  ('anthropic/claude-opus-4',     200000, 0.1000, 1024, 'Default for Anthropic Claude Opus 4', 1),
  ('anthropic/claude-3.5-sonnet', 200000, 0.1000, 1024, 'Default for Anthropic Claude 3.5 Sonnet', 1),
  ('openai/gpt-4o',               128000, 0.1000, 1024, 'Default for OpenAI GPT-4o', 1),
  ('openai/gpt-4o-mini',          128000, 0.1000, 1024, 'Default for OpenAI GPT-4o mini', 1),
  ('openai/gpt-4.1',              1000000, 0.1000, 1024, 'Default for OpenAI GPT-4.1', 1),
  ('openai/o1-preview',           128000, 0.1000, 1024, 'Default for OpenAI o1-preview', 1),
  ('openai/o3-mini',              200000, 0.1000, 1024, 'Default for OpenAI o3-mini', 1),
  ('qwen/qwen-3.5-72b',           32000, 0.1000, 1024, 'Default for Qwen 3.5 72B', 1),
  ('qwen/qwen-long',              1000000, 0.1000, 1024, 'Default for Qwen Long', 1),
  ('deepseek/deepseek-v4-flash',  64000, 0.1000, 1024, 'Default for DeepSeek V4 Flash', 1),
  ('mock/test',                   8000, 0.1000, 1024, 'Mock provider used by tests', 1);

-- ---------------------------------------------------------------------------
-- 4. Schema ledger
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0005_compact_and_context', NULL);
