-- Story Outside - session playback and canonical event provenance.
--
-- Compatibility: MariaDB 10.6+ / 11.x, InnoDB, utf8mb4.
-- This migration pins the model/prompt/profile used by a session, records its
-- playback cursor/state/revision, and makes event provenance addressable.
-- It also adds composite foreign keys so a session cannot pair a story with a
-- version or opening cache belonging to a different story/version.
--
-- Re-runnable: columns and indexes use IF NOT EXISTS; named foreign keys and
-- checks are dropped by name before being recreated because MariaDB does not
-- support IF NOT EXISTS for ADD FOREIGN KEY. Existing events receive a neutral
-- legacy source and use their canonical event_seq as source_sequence before
-- those columns become NOT NULL.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- MariaDB requires the referenced columns to be covered by a parent index.
-- The primary id remains the identity; these ordinary indexes only expose the
-- parent scope and deliberately do not add redundant uniqueness.
ALTER TABLE story_versions
  ADD INDEX IF NOT EXISTS idx_story_versions_story_id_id (story_id, id);

ALTER TABLE story_opening_caches
  ADD INDEX IF NOT EXISTS idx_story_opening_caches_story_version_id
    (story_id, story_version_id, id);

ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS model VARCHAR(128) NULL AFTER role_id,
  ADD COLUMN IF NOT EXISTS prompt TEXT NULL AFTER model,
  ADD COLUMN IF NOT EXISTS generation_profile JSON NULL AFTER prompt,
  ADD COLUMN IF NOT EXISTS opening_cursor BIGINT UNSIGNED NULL DEFAULT 0 AFTER first_choice_at,
  ADD COLUMN IF NOT EXISTS opening_state ENUM('opening', 'awaiting_first_choice', 'realtime') NULL DEFAULT 'opening' AFTER opening_cursor,
  ADD COLUMN IF NOT EXISTS session_revision BIGINT UNSIGNED NULL DEFAULT 0 AFTER opening_state;

-- Existing 0001/0002 rows have no playback metadata. Backfill only NULLs so a
-- rerun never overwrites an application's session snapshot.
UPDATE game_sessions
   SET model = COALESCE(model, 'legacy'),
       prompt = COALESCE(prompt, ''),
       generation_profile = COALESCE(
         generation_profile,
         JSON_OBJECT('identifier', 'opening-default', 'rules_version', 'legacy-0001', 'locale', locale, 'variant', 'default')
       ),
       opening_cursor = COALESCE(opening_cursor, 0),
       opening_state = COALESCE(opening_state, CASE WHEN first_choice_at IS NULL THEN 'opening' ELSE 'realtime' END),
       session_revision = COALESCE(session_revision, 0);

ALTER TABLE game_sessions
  MODIFY model VARCHAR(128) NOT NULL,
  MODIFY prompt TEXT NOT NULL,
  MODIFY generation_profile JSON NOT NULL,
  MODIFY opening_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  MODIFY opening_state ENUM('opening', 'awaiting_first_choice', 'realtime') NOT NULL DEFAULT 'opening',
  MODIFY session_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD KEY IF NOT EXISTS idx_game_sessions_playback (opening_state, session_revision, updated_at),
  ADD KEY IF NOT EXISTS idx_game_sessions_story_version_cache (story_id, story_version_id, opening_cache_id);

-- Extend the event contract without changing nullability or removing any
-- value accepted by 0001. Existing rows contain only these retained values.
ALTER TABLE session_events
  MODIFY event_type ENUM(
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
  MODIFY origin ENUM('user', 'system', 'llm', 'imported') NOT NULL;

-- MariaDB 10.6+/11.x accepts IF NOT EXISTS for checks but not for foreign
-- keys. Drop/recreate by stable names makes this block safe on every rerun.
ALTER TABLE game_sessions
  DROP CONSTRAINT IF EXISTS chk_game_sessions_model,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_generation_profile,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_opening_cursor,
  DROP CONSTRAINT IF EXISTS chk_game_sessions_revision,
  DROP FOREIGN KEY IF EXISTS fk_game_sessions_story_version_pair,
  DROP FOREIGN KEY IF EXISTS fk_game_sessions_opening_cache_scope;

ALTER TABLE game_sessions
  ADD CONSTRAINT chk_game_sessions_model CHECK (CHAR_LENGTH(model) > 0),
  ADD CONSTRAINT chk_game_sessions_generation_profile CHECK (JSON_VALID(generation_profile)),
  ADD CONSTRAINT chk_game_sessions_opening_cursor CHECK (opening_cursor >= 0),
  ADD CONSTRAINT chk_game_sessions_revision CHECK (session_revision >= 0),
  ADD CONSTRAINT fk_game_sessions_story_version_pair
    FOREIGN KEY (story_id, story_version_id) REFERENCES story_versions(story_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT fk_game_sessions_opening_cache_scope
    FOREIGN KEY (story_id, story_version_id, opening_cache_id)
    REFERENCES story_opening_caches(story_id, story_version_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE story_opening_caches
  DROP CONSTRAINT IF EXISTS fk_story_opening_caches_story_version_pair;

ALTER TABLE story_opening_caches
  ADD CONSTRAINT fk_story_opening_caches_story_version_pair
    FOREIGN KEY (story_id, story_version_id) REFERENCES story_versions(story_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- source is deliberately a bounded label rather than a closed ENUM: future
-- DAO implementations may add a documented producer without rebuilding data.
-- source_sequence preserves the producer-local sequence (opening payloads are
-- 0-based), while event_seq remains the canonical 1-based session chain.
ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS source VARCHAR(64) NULL AFTER origin,
  ADD COLUMN IF NOT EXISTS source_sequence BIGINT UNSIGNED NULL AFTER source;

-- 0001's append-only trigger also blocks this one-time provenance backfill.
-- Temporarily remove only that guard, backfill NULLs, then restore it before
-- making the columns NOT NULL. No application writes should run during a DDL
-- migration.
DROP TRIGGER IF EXISTS trg_session_events_no_update;

UPDATE session_events
   SET source = COALESCE(source, 'legacy'),
       source_sequence = COALESCE(source_sequence, event_seq);

DELIMITER $$
CREATE TRIGGER trg_session_events_no_update
BEFORE UPDATE ON session_events
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'session_events is append-only: UPDATE is forbidden';
END$$
DELIMITER ;

ALTER TABLE session_events
  MODIFY source VARCHAR(64) NOT NULL,
  MODIFY source_sequence BIGINT UNSIGNED NOT NULL,
  ADD UNIQUE INDEX IF NOT EXISTS uq_session_events_source_sequence
    (session_id, source, source_sequence),
  ADD KEY IF NOT EXISTS idx_session_events_source_sequence
    (source, source_sequence);

ALTER TABLE session_events
  DROP CONSTRAINT IF EXISTS chk_session_events_source,
  DROP CONSTRAINT IF EXISTS chk_session_events_source_sequence;

ALTER TABLE session_events
  ADD CONSTRAINT chk_session_events_source CHECK (CHAR_LENGTH(source) > 0),
  ADD CONSTRAINT chk_session_events_source_sequence CHECK (source_sequence >= 0);

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0003_session_playback', NULL);
