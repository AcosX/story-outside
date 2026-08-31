-- Story Outside - opening cache generation profile and session-local first choice.
--
-- Compatibility: MariaDB 10.6+ / 11.x, InnoDB, utf8mb4.
--
-- This migration evolves the 0001 model:
--   * story_opening_caches gains generation_profile JSON and
--     generation_hash CHAR(64), and the scope unique key becomes
--     (story_id, story_version_id, opening_key, generation_hash).
--     Old 0001 rows are backfilled as one legacy generation so they remain
--     readable without being mistaken for the current generation.
--   * The 0001 first-choice trigger no longer invalidates the shared
--     opening cache. It only maintains game_sessions.first_choice_at;
--     session-local consumption is the application layer's job.
--
-- Re-runnable: every statement below uses IF NOT EXISTS / IF EXISTS or a
-- drop-before-create trigger, so 0002 can be applied multiple times.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

ALTER TABLE story_opening_caches
  ADD COLUMN IF NOT EXISTS generation_profile JSON NULL AFTER opening_key,
  ADD COLUMN IF NOT EXISTS generation_hash CHAR(64) NULL AFTER generation_profile;

-- Backfill pre-0002 rows as the documented legacy public generation. The
-- profile is intentionally not user/role/session-scoped.
UPDATE story_opening_caches
   SET generation_profile = JSON_OBJECT(
         'identifier', 'opening-default',
         'rules_version', 'legacy-0001',
         'locale', 'zh-CN',
         'variant', 'default'
       )
 WHERE generation_profile IS NULL;

UPDATE story_opening_caches
   SET generation_hash = SHA2('opening-default|legacy-0001|zh-CN|default', 256)
 WHERE generation_hash IS NULL OR CHAR_LENGTH(generation_hash) <> 64;

ALTER TABLE story_opening_caches
  ADD UNIQUE INDEX IF NOT EXISTS uq_story_opening_caches_scope_generation
    (story_id, story_version_id, opening_key, generation_hash);

-- Replace the single-generation 0001 scope key. Multiple public generation
-- profiles must be able to coexist for the same story/version/opening_key.
ALTER TABLE story_opening_caches
  DROP INDEX IF EXISTS uq_story_opening_caches_scope;

ALTER TABLE story_opening_caches
  MODIFY generation_profile JSON NOT NULL,
  MODIFY generation_hash CHAR(64) NOT NULL;

ALTER TABLE story_opening_caches
  ADD CONSTRAINT IF NOT EXISTS chk_story_opening_caches_generation_hash
    CHECK (CHAR_LENGTH(generation_hash) = 64);

-- 0001's cascade invalidated the shared cache for every session. 0002
-- replaces it with a trigger that only records the session's first choice.
DROP TRIGGER IF EXISTS trg_session_events_first_choice;

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

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0002_opening_cache_generation_profile', NULL);
