CREATE TABLE IF NOT EXISTS story_upstream_cache (
  cache_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  source_url VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(128) NOT NULL,
  fetched_at_ms BIGINT UNSIGNED NOT NULL,
  payload_json LONGTEXT NOT NULL CHECK (JSON_VALID(payload_json)),
  format_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  INDEX idx_story_upstream_cache_fetched (fetched_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0010_story_upstream_cache', NULL);
