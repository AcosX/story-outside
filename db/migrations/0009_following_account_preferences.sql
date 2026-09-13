CREATE TABLE IF NOT EXISTS ecosystem_account_preferences (
  user_uuid CHAR(36) NOT NULL PRIMARY KEY,
  url_token VARCHAR(64) NULL,
  visible BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO schema_migrations (migration_name, applied_by)
VALUES ('0009_following_account_preferences', NULL);
