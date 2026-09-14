-- One site-wide hot-list snapshot. The stable cache_key is intentional:
-- category, story identity, and relevance are not cache dimensions.
CREATE TABLE IF NOT EXISTS ecosystem_hot_cache (
  cache_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value JSON NOT NULL,
  fetched_at_ms BIGINT UNSIGNED NOT NULL,
  expires_at_ms BIGINT UNSIGNED NOT NULL,
  swr_expires_at_ms BIGINT UNSIGNED NOT NULL,
  source VARCHAR(32) NOT NULL DEFAULT 'unknown',
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (cache_key),
  KEY idx_ecosystem_hot_cache_expiry (expires_at_ms),
  CONSTRAINT chk_ecosystem_hot_cache_value CHECK (JSON_VALID(value)),
  CONSTRAINT chk_ecosystem_hot_cache_expiry CHECK (expires_at_ms <= swr_expires_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0011_ecosystem_hot_cache', NULL);
