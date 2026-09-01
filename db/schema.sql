-- Story Outside - canonical fresh-install schema.
--
-- This file is the deployment entrypoint. It creates the database and then
-- applies the same final DDL as db/migrations/0001_initial_story_outside.sql
-- followed by db/migrations/0002_opening_cache_generation_profile.sql and
-- db/migrations/0003_session_playback.sql.
-- The contract test tests/schema-contract.test.mjs keeps this body in sync
-- with the migration set.

CREATE DATABASE IF NOT EXISTS story_outside
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE story_outside;

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

CREATE TABLE IF NOT EXISTS schema_migrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  migration_name VARCHAR(255) NOT NULL,
  applied_by VARCHAR(128) NULL,
  applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_schema_migrations_name (migration_name),
  CONSTRAINT chk_schema_migrations_name CHECK (CHAR_LENGTH(migration_name) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Story catalog. A story is a stable public object; authoring changes create
-- a new story_versions row instead of mutating this table's narrative fields.
CREATE TABLE IF NOT EXISTS stories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  story_uuid CHAR(36) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  hook VARCHAR(500) NOT NULL,
  tagline VARCHAR(300) NULL,
  locale VARCHAR(16) NOT NULL DEFAULT 'zh-CN',
  status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
  meta_payload JSON NULL,
  published_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_stories_uuid (story_uuid),
  UNIQUE KEY uq_stories_slug (slug),
  KEY idx_stories_status_published (status, published_at),
  CONSTRAINT chk_stories_hook CHECK (CHAR_LENGTH(hook) > 0),
  CONSTRAINT chk_stories_meta_payload CHECK (meta_payload IS NULL OR JSON_VALID(meta_payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable authored snapshots. version_no and checksum pin exactly what a
-- session started from; role metadata is kept here as roles_payload JSON.
CREATE TABLE IF NOT EXISTS story_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_uuid CHAR(36) NOT NULL,
  story_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  hook VARCHAR(500) NOT NULL,
  content_payload JSON NOT NULL,
  roles_payload JSON NOT NULL,
  checksum CHAR(64) NOT NULL,
  source_ref VARCHAR(255) NULL,
  status ENUM('draft', 'published', 'superseded', 'archived') NOT NULL DEFAULT 'draft',
  published_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_story_versions_uuid (version_uuid),
  UNIQUE KEY uq_story_versions_story_no (story_id, version_no),
  KEY idx_story_versions_story_id_id (story_id, id),
  UNIQUE KEY uq_story_versions_checksum (checksum),
  KEY idx_story_versions_story_status (story_id, status),
  CONSTRAINT fk_story_versions_story FOREIGN KEY (story_id) REFERENCES stories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_story_versions_no CHECK (version_no > 0),
  CONSTRAINT chk_story_versions_content CHECK (JSON_VALID(content_payload)),
  CONSTRAINT chk_story_versions_roles CHECK (JSON_VALID(roles_payload)),
  CONSTRAINT chk_story_versions_checksum CHECK (CHAR_LENGTH(checksum) = 64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ending definitions for a pinned story version. A session records which
-- ending it reached on game_sessions.ending_id.
CREATE TABLE IF NOT EXISTS endings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ending_uuid CHAR(36) NOT NULL,
  story_id BIGINT UNSIGNED NOT NULL,
  story_version_id BIGINT UNSIGNED NOT NULL,
  ending_key VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  kind ENUM('canonical', 'secret', 'failure', 'abandoned') NOT NULL DEFAULT 'canonical',
  description TEXT NULL,
  badge_label VARCHAR(80) NULL,
  conditions_payload JSON NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_endings_uuid (ending_uuid),
  UNIQUE KEY uq_endings_version_key (story_version_id, ending_key),
  KEY idx_endings_story (story_id),
  KEY idx_endings_story_version_public (story_id, story_version_id, is_public),
  CONSTRAINT fk_endings_story FOREIGN KEY (story_id) REFERENCES stories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_endings_story_version FOREIGN KEY (story_version_id) REFERENCES story_versions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_endings_conditions CHECK (conditions_payload IS NULL OR JSON_VALID(conditions_payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Story-level opening cache: scoped to story+version+public generation
-- profile only, never user or role. Session first-choice consumption is
-- recorded on game_sessions.first_choice_at and must not invalidate this
-- shared cache for other sessions.
CREATE TABLE IF NOT EXISTS story_opening_caches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cache_uuid CHAR(36) NOT NULL,
  story_id BIGINT UNSIGNED NOT NULL,
  story_version_id BIGINT UNSIGNED NOT NULL,
  opening_key VARCHAR(64) NOT NULL DEFAULT 'default',
  generation_profile JSON NOT NULL,
  generation_hash CHAR(64) NOT NULL,
  status ENUM('valid', 'invalidated', 'failed') NOT NULL DEFAULT 'valid',
  content_payload JSON NOT NULL,
  content_hash CHAR(64) NOT NULL,
  use_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at DATETIME(6) NULL,
  invalidated_at DATETIME(6) NULL,
  invalidated_reason VARCHAR(128) NULL,
  expires_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_story_opening_caches_uuid (cache_uuid),
  UNIQUE KEY uq_story_opening_caches_scope_generation (story_id, story_version_id, opening_key, generation_hash),
  KEY idx_story_opening_caches_story_version_id (story_id, story_version_id, id),
  KEY idx_story_opening_caches_valid (status, expires_at, last_used_at),
  CONSTRAINT fk_story_opening_caches_story FOREIGN KEY (story_id) REFERENCES stories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_story_opening_caches_version FOREIGN KEY (story_version_id) REFERENCES story_versions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_story_opening_caches_story_version_pair FOREIGN KEY (story_id, story_version_id)
    REFERENCES story_versions(story_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_story_opening_caches_content CHECK (JSON_VALID(content_payload)),
  CONSTRAINT chk_story_opening_caches_generation CHECK (JSON_VALID(generation_profile)),
  CONSTRAINT chk_story_opening_caches_hash CHECK (CHAR_LENGTH(content_hash) = 64),
  CONSTRAINT chk_story_opening_caches_generation_hash CHECK (CHAR_LENGTH(generation_hash) = 64),
  CONSTRAINT chk_story_opening_caches_invalidated CHECK (
    (status = 'invalidated' AND invalidated_at IS NOT NULL) OR status <> 'invalidated'
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One game session per started playthrough. user_ref is an opaque external
-- identifier; never store real names, access tokens, or credentials here.
CREATE TABLE IF NOT EXISTS game_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_uuid CHAR(36) NOT NULL,
  story_id BIGINT UNSIGNED NOT NULL,
  story_version_id BIGINT UNSIGNED NOT NULL,
  user_ref VARCHAR(128) NOT NULL,
  role_id VARCHAR(64) NOT NULL,
  model VARCHAR(128) NOT NULL,
  prompt TEXT NOT NULL,
  generation_profile JSON NOT NULL,
  role_label VARCHAR(80) NULL,
  status ENUM('active', 'paused', 'ended', 'abandoned') NOT NULL DEFAULT 'active',
  opening_cache_id BIGINT UNSIGNED NULL,
  first_choice_at DATETIME(6) NULL,
  opening_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  opening_state ENUM('opening', 'awaiting_first_choice', 'realtime') NOT NULL DEFAULT 'opening',
  session_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ending_id BIGINT UNSIGNED NULL,
  ended_at DATETIME(6) NULL,
  locale VARCHAR(16) NOT NULL DEFAULT 'zh-CN',
  meta_payload JSON NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_game_sessions_uuid (session_uuid),
  KEY idx_game_sessions_user_status (user_ref, status, updated_at),
  KEY idx_game_sessions_story_version (story_id, story_version_id),
  KEY idx_game_sessions_opening_cache (opening_cache_id),
  KEY idx_game_sessions_ending (ending_id),
  KEY idx_game_sessions_playback (opening_state, session_revision, updated_at),
  KEY idx_game_sessions_story_version_cache (story_id, story_version_id, opening_cache_id),
  CONSTRAINT fk_game_sessions_story FOREIGN KEY (story_id) REFERENCES stories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_game_sessions_story_version FOREIGN KEY (story_version_id) REFERENCES story_versions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_game_sessions_story_version_pair FOREIGN KEY (story_id, story_version_id)
    REFERENCES story_versions(story_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_game_sessions_opening_cache FOREIGN KEY (opening_cache_id) REFERENCES story_opening_caches(id)
    ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT fk_game_sessions_opening_cache_scope FOREIGN KEY (story_id, story_version_id, opening_cache_id)
    REFERENCES story_opening_caches(story_id, story_version_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_game_sessions_ending FOREIGN KEY (ending_id) REFERENCES endings(id)
    ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT chk_game_sessions_role CHECK (CHAR_LENGTH(role_id) > 0),
  CONSTRAINT chk_game_sessions_model CHECK (CHAR_LENGTH(model) > 0),
  CONSTRAINT chk_game_sessions_generation_profile CHECK (JSON_VALID(generation_profile)),
  CONSTRAINT chk_game_sessions_opening_cursor CHECK (opening_cursor >= 0),
  CONSTRAINT chk_game_sessions_revision CHECK (session_revision >= 0),
  CONSTRAINT chk_game_sessions_meta CHECK (meta_payload IS NULL OR JSON_VALID(meta_payload)),
  CONSTRAINT chk_game_sessions_first_choice CHECK (first_choice_at IS NULL OR first_choice_at >= created_at),
  CONSTRAINT chk_game_sessions_ended CHECK (ended_at IS NULL OR ended_at >= created_at),
  CONSTRAINT chk_game_sessions_status_end CHECK (
    (status IN ('ended', 'abandoned') AND ended_at IS NOT NULL) OR status IN ('active', 'paused')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Canonical append-only event history. event_seq is the per-session chain
-- position, payload is the immutable event body, and hash pins its contents.
-- UPDATE/DELETE are blocked by triggers below.
CREATE TABLE IF NOT EXISTS session_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id CHAR(36) NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  event_seq BIGINT UNSIGNED NOT NULL,
  prev_event_seq BIGINT UNSIGNED NULL,
  event_type ENUM(
    'session_started',
    'role_selected',
    'story_opening',
    'ask_player_choice',
    'player_choice',
    'player_input',
    'narrative_beat',
    'chat_message',
    'ending_reached',
    'session_ended',
    'system_event'
  ) NOT NULL,
  origin ENUM('user', 'system', 'llm', 'imported') NOT NULL,
  source VARCHAR(64) NOT NULL,
  source_sequence BIGINT UNSIGNED NOT NULL,
  payload JSON NOT NULL,
  client_request_id CHAR(36) NULL,
  hash CHAR(64) NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_events_event_id (event_id),
  UNIQUE KEY uq_session_events_seq (session_id, event_seq),
  UNIQUE KEY uq_session_events_client_request (client_request_id),
  UNIQUE KEY uq_session_events_source_sequence (session_id, source, source_sequence),
  KEY idx_session_events_session_created (session_id, created_at),
  KEY idx_session_events_type_occurred (event_type, occurred_at),
  KEY idx_session_events_source_sequence (source, source_sequence),
  CONSTRAINT fk_session_events_session FOREIGN KEY (session_id) REFERENCES game_sessions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_session_events_prev FOREIGN KEY (session_id, prev_event_seq)
    REFERENCES session_events(session_id, event_seq) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_session_events_seq CHECK (event_seq > 0),
  CONSTRAINT chk_session_events_source CHECK (CHAR_LENGTH(source) > 0),
  CONSTRAINT chk_session_events_source_sequence CHECK (source_sequence >= 0),
  CONSTRAINT chk_session_events_payload CHECK (JSON_VALID(payload)),
  CONSTRAINT chk_session_events_hash CHECK (CHAR_LENGTH(hash) = 64),
  CONSTRAINT chk_session_events_prev CHECK (prev_event_seq IS NULL OR prev_event_seq < event_seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Speculative generation queue. Batches are request-scoped and may be promoted
-- to canonical session_events via promoted_event_id; superseded/failed rows
-- remain available for observability and retry accounting.
CREATE TABLE IF NOT EXISTS pending_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_uuid CHAR(36) NOT NULL,
  session_id BIGINT UNSIGNED NOT NULL,
  batch_type ENUM(
    'story_opening',
    'ask_player_choice',
    'player_choice',
    'narrative_beat',
    'chat_reply',
    'ending_reached'
  ) NOT NULL,
  status ENUM('queued', 'reserved', 'succeeded', 'failed', 'expired', 'superseded')
    NOT NULL DEFAULT 'queued',
  base_event_id CHAR(36) NULL,
  expected_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  request_uuid CHAR(36) NOT NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'runtime',
  request_payload JSON NOT NULL,
  request_fingerprint CHAR(64) NULL,
  response_payload JSON NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(500) NULL,
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  priority TINYINT UNSIGNED NOT NULL DEFAULT 100,
  available_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  reserved_at DATETIME(6) NULL,
  reserved_by VARCHAR(128) NULL,
  expires_at DATETIME(6) NULL,
  completed_at DATETIME(6) NULL,
  committed_count INT UNSIGNED NOT NULL DEFAULT 0,
  item_count INT UNSIGNED NOT NULL DEFAULT 0,
  promoted_event_id CHAR(36) NULL,
  superseded_by CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_pending_batches_batch_uuid (batch_uuid),
  UNIQUE KEY uq_pending_batches_request_uuid (request_uuid),
  UNIQUE KEY uq_pending_batches_fingerprint (request_fingerprint),
  KEY idx_pending_batches_queue (status, available_at, priority),
  KEY idx_pending_batches_session (session_id, created_at),
  KEY idx_pending_batches_base_event (base_event_id),
  KEY idx_pending_batches_promoted_event (promoted_event_id),
  KEY idx_pending_batches_fingerprint (request_fingerprint),
  CONSTRAINT fk_pending_batches_session FOREIGN KEY (session_id) REFERENCES game_sessions(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pending_batches_base_event FOREIGN KEY (base_event_id) REFERENCES session_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_pending_batches_promoted_event FOREIGN KEY (promoted_event_id) REFERENCES session_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_pending_batches_request CHECK (JSON_VALID(request_payload)),
  CONSTRAINT chk_pending_batches_response CHECK (response_payload IS NULL OR JSON_VALID(response_payload)),
  CONSTRAINT chk_pending_batches_attempts CHECK (attempts <= max_attempts),
  CONSTRAINT chk_pending_batches_expires CHECK (expires_at IS NULL OR expires_at > available_at),
  CONSTRAINT chk_pending_batches_source CHECK (CHAR_LENGTH(source) > 0),
  CONSTRAINT chk_pending_batches_counts CHECK (committed_count <= item_count),
  CONSTRAINT chk_pending_batches_completed CHECK (
    (status IN ('succeeded', 'failed', 'expired', 'superseded') AND completed_at IS NOT NULL)
    OR status IN ('queued', 'reserved')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per ordered narrative beat in a staged batch. item_seq is the
-- 0-based index inside the staged batch and is unique per batch. A future
-- DAO persists the exact ordered payload the runtime handed over, plus the
-- per-item status that lets a mid-batch interrupt land cleanly on the SQL
-- contract.
CREATE TABLE IF NOT EXISTS pending_batch_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id BIGINT UNSIGNED NOT NULL,
  item_uuid CHAR(36) NOT NULL,
  item_seq INT UNSIGNED NOT NULL,
  item_type ENUM('narrative_beat', 'tool_call') NOT NULL,
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
  CONSTRAINT fk_pending_batch_items_batch FOREIGN KEY (batch_id) REFERENCES pending_batches(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_pending_batch_items_promoted_event FOREIGN KEY (promoted_event_id) REFERENCES session_events(event_id)
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

-- Projected context/checkpoint for a session. It is derived from
-- session_events and may be rebuilt from the canonical history at any time.
CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id BIGINT UNSIGNED NOT NULL,
  checkpoint_uuid CHAR(36) NOT NULL,
  checkpoint_version INT UNSIGNED NOT NULL DEFAULT 1,
  last_event_id CHAR(36) NULL,
  last_event_seq BIGINT UNSIGNED NULL,
  event_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  context_digest CHAR(64) NULL,
  summary_text MEDIUMTEXT NULL,
  summary_tokens INT UNSIGNED NULL,
  context_tokens INT UNSIGNED NULL,
  state_payload JSON NULL,
  projection_status ENUM('synced', 'stale', 'rebuilding', 'failed') NOT NULL DEFAULT 'stale',
  is_dirty TINYINT(1) NOT NULL DEFAULT 1,
  dirty_reason VARCHAR(128) NULL,
  last_rebuilt_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_session_checkpoints_uuid (checkpoint_uuid),
  KEY idx_session_checkpoints_dirty (projection_status, is_dirty, last_rebuilt_at),
  KEY idx_session_checkpoints_last_event (last_event_id),
  CONSTRAINT fk_session_checkpoints_session FOREIGN KEY (session_id) REFERENCES game_sessions(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_session_checkpoints_last_event FOREIGN KEY (last_event_id) REFERENCES session_events(event_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_session_checkpoints_state CHECK (state_payload IS NULL OR JSON_VALID(state_payload)),
  CONSTRAINT chk_session_checkpoints_digest CHECK (context_digest IS NULL OR CHAR_LENGTH(context_digest) = 64),
  CONSTRAINT chk_session_checkpoints_event_seq CHECK (last_event_seq IS NULL OR last_event_seq > 0),
  CONSTRAINT chk_session_checkpoints_dirty CHECK (
    (is_dirty = 1 AND projection_status <> 'synced') OR (is_dirty = 0 AND projection_status = 'synced')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- session_events is canonical history: block accidental UPDATE/DELETE.
DROP TRIGGER IF EXISTS trg_session_events_no_update;
DROP TRIGGER IF EXISTS trg_session_events_no_delete;
DROP TRIGGER IF EXISTS trg_session_events_first_choice;

DELIMITER $$
CREATE TRIGGER trg_session_events_no_update
BEFORE UPDATE ON session_events
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_events is append-only: UPDATE is forbidden';
END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER trg_session_events_no_delete
BEFORE DELETE ON session_events
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_events is append-only: DELETE is forbidden';
END$$
DELIMITER ;

DELIMITER $$
CREATE TRIGGER trg_session_events_first_choice
AFTER INSERT ON session_events
FOR EACH ROW
BEGIN
  IF NEW.event_type = 'ask_player_choice' THEN
    UPDATE game_sessions
       SET first_choice_at = COALESCE(first_choice_at, NEW.occurred_at)
     WHERE id = NEW.session_id;
  END IF;
END$$
DELIMITER ;

-- Record the canonical migration set. INSERT IGNORE keeps the file
-- re-runnable.
INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0001_initial_story_outside', NULL),
       ('0002_opening_cache_generation_profile', NULL),
       ('0003_session_playback', NULL),
       ('0004_pending_batch_lifecycle', NULL);
