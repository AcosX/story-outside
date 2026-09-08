-- Story Outside business persistence extensions.
--
-- 0001-0005 define the canonical story/session/event model. This migration
-- adds the runtime state needed to restore the synchronous application
-- contract, plus the community, ecosystem graph, and search-cache tables
-- that were previously process-local.

ALTER TABLE game_sessions
  ADD COLUMN IF NOT EXISTS user_uuid CHAR(36) NULL AFTER generation_profile,
  ADD COLUMN IF NOT EXISTS runtime_payload JSON NULL AFTER last_compact_error;

CREATE TABLE IF NOT EXISTS story_community_profiles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  profile_uuid CHAR(36) NOT NULL,
  story_id BIGINT UNSIGNED NOT NULL,
  story_version_id BIGINT UNSIGNED NOT NULL,
  generator_version VARCHAR(255) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  profile_payload JSON NOT NULL,
  source VARCHAR(32) NOT NULL,
  generated_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_story_community_profiles_uuid (profile_uuid),
  UNIQUE KEY uq_story_community_profiles_generation (story_version_id, generator_version, content_hash),
  KEY idx_story_community_profiles_story_version (story_version_id, generated_at),
  CONSTRAINT fk_story_community_profiles_story FOREIGN KEY (story_id) REFERENCES stories(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_story_community_profiles_version FOREIGN KEY (story_version_id) REFERENCES story_versions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_story_community_profiles_story_version_pair FOREIGN KEY (story_id, story_version_id)
    REFERENCES story_versions(story_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_story_community_profiles_payload CHECK (JSON_VALID(profile_payload)),
  CONSTRAINT chk_story_community_profiles_hash CHECK (CHAR_LENGTH(content_hash) = 64)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecosystem_follow_edges (
  follower_uuid CHAR(36) NOT NULL,
  target_user_uuid CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (follower_uuid, target_user_uuid),
  KEY idx_ecosystem_follow_edges_target (target_user_uuid, created_at),
  CONSTRAINT chk_ecosystem_follow_edges_no_self CHECK (follower_uuid <> target_user_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecosystem_block_edges (
  owner_uuid CHAR(36) NOT NULL,
  target_user_uuid CHAR(36) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (owner_uuid, target_user_uuid),
  KEY idx_ecosystem_block_edges_target (target_user_uuid, created_at),
  CONSTRAINT chk_ecosystem_block_edges_no_self CHECK (owner_uuid <> target_user_uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecosystem_shared_sessions (
  session_uuid CHAR(36) NOT NULL,
  owner_user_uuid CHAR(36) NOT NULL,
  title VARCHAR(200) NULL,
  story_uuid CHAR(36) NULL,
  story_version_uuid CHAR(36) NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (session_uuid),
  KEY idx_ecosystem_shared_sessions_owner (owner_user_uuid, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ecosystem_search_cache (
  cache_key VARCHAR(512) NOT NULL,
  story_uuid CHAR(36) NOT NULL,
  story_version_uuid CHAR(36) NOT NULL,
  community_profile_version VARCHAR(255) NOT NULL,
  query_id VARCHAR(128) NOT NULL,
  query_text VARCHAR(500) NOT NULL,
  value JSON NOT NULL,
  fetched_at_ms BIGINT UNSIGNED NOT NULL,
  expires_at_ms BIGINT UNSIGNED NOT NULL,
  swr_expires_at_ms BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (cache_key),
  KEY idx_ecosystem_search_cache_identity (story_version_uuid, community_profile_version, query_id),
  KEY idx_ecosystem_search_cache_expiry (swr_expires_at_ms),
  CONSTRAINT chk_ecosystem_search_cache_value CHECK (JSON_VALID(value)),
  CONSTRAINT chk_ecosystem_search_cache_expiry CHECK (expires_at_ms <= swr_expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0006_business_persistence', NULL);
