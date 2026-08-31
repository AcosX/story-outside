// tests/schema-contract.test.mjs — dependency-free schema/SQL contract checks.
// Validates db/migrations/0001_initial_story_outside.sql,
// db/migrations/0002_opening_cache_generation_profile.sql, db/schema.sql, and
// docs/data-model.md without needing database credentials or a running server.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATION_0001_PATH = join(ROOT, "db/migrations/0001_initial_story_outside.sql");
const MIGRATION_0002_PATH = join(ROOT, "db/migrations/0002_opening_cache_generation_profile.sql");
const SCHEMA_PATH = join(ROOT, "db/schema.sql");
const DOCS_PATH = join(ROOT, "docs/data-model.md");

const REQUIRED_TABLES = [
  "schema_migrations",
  "stories",
  "story_versions",
  "endings",
  "story_opening_caches",
  "game_sessions",
  "session_events",
  "pending_batches",
  "session_checkpoints",
];

const REQUIRED_COLUMNS = {
  stories: [
    "story_uuid CHAR(36) NOT NULL",
    "slug VARCHAR(64) NOT NULL",
    "title VARCHAR(200) NOT NULL",
    "hook VARCHAR(500) NOT NULL",
    "status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft'",
    "meta_payload JSON NULL",
    "created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)",
  ],
  story_versions: [
    "version_uuid CHAR(36) NOT NULL",
    "story_id BIGINT UNSIGNED NOT NULL",
    "version_no INT UNSIGNED NOT NULL",
    "content_payload JSON NOT NULL",
    "roles_payload JSON NOT NULL",
    "checksum CHAR(64) NOT NULL",
  ],
  endings: [
    "ending_uuid CHAR(36) NOT NULL",
    "story_id BIGINT UNSIGNED NOT NULL",
    "story_version_id BIGINT UNSIGNED NOT NULL",
    "ending_key VARCHAR(64) NOT NULL",
    "title VARCHAR(200) NOT NULL",
    "kind ENUM('canonical', 'secret', 'failure', 'abandoned') NOT NULL DEFAULT 'canonical'",
    "conditions_payload JSON NULL",
    "is_public TINYINT(1) NOT NULL DEFAULT 1",
  ],
  story_opening_caches: [
    "cache_uuid CHAR(36) NOT NULL",
    "story_id BIGINT UNSIGNED NOT NULL",
    "story_version_id BIGINT UNSIGNED NOT NULL",
    "opening_key VARCHAR(64) NOT NULL DEFAULT 'default'",
    "generation_profile JSON NOT NULL",
    "generation_hash CHAR(64) NOT NULL",
    "status ENUM('valid', 'invalidated', 'failed') NOT NULL DEFAULT 'valid'",
    "content_payload JSON NOT NULL",
    "content_hash CHAR(64) NOT NULL",
  ],
  game_sessions: [
    "session_uuid CHAR(36) NOT NULL",
    "story_id BIGINT UNSIGNED NOT NULL",
    "story_version_id BIGINT UNSIGNED NOT NULL",
    "user_ref VARCHAR(128) NOT NULL",
    "role_id VARCHAR(64) NOT NULL",
    "status ENUM('active', 'paused', 'ended', 'abandoned') NOT NULL DEFAULT 'active'",
    "opening_cache_id BIGINT UNSIGNED NULL",
    "first_choice_at DATETIME(6) NULL",
    "ending_id BIGINT UNSIGNED NULL",
    "ended_at DATETIME(6) NULL",
  ],
  session_events: [
    "event_id CHAR(36) NOT NULL",
    "session_id BIGINT UNSIGNED NOT NULL",
    "event_seq BIGINT UNSIGNED NOT NULL",
    "prev_event_seq BIGINT UNSIGNED NULL",
    "origin ENUM('user', 'system', 'llm', 'imported') NOT NULL",
    "payload JSON NOT NULL",
    "client_request_id CHAR(36) NULL",
    "hash CHAR(64) NOT NULL",
    "occurred_at DATETIME(6) NOT NULL",
  ],
  pending_batches: [
    "batch_uuid CHAR(36) NOT NULL",
    "session_id BIGINT UNSIGNED NOT NULL",
    "status ENUM('queued', 'reserved', 'succeeded', 'failed', 'expired', 'superseded')",
    "request_uuid CHAR(36) NOT NULL",
    "request_payload JSON NOT NULL",
    "response_payload JSON NULL",
    "promoted_event_id CHAR(36) NULL",
  ],
  session_checkpoints: [
    "session_id BIGINT UNSIGNED NOT NULL",
    "checkpoint_uuid CHAR(36) NOT NULL",
    "last_event_id CHAR(36) NULL",
    "last_event_seq BIGINT UNSIGNED NULL",
    "event_count BIGINT UNSIGNED NOT NULL DEFAULT 0",
    "state_payload JSON NULL",
    "projection_status ENUM('synced', 'stale', 'rebuilding', 'failed') NOT NULL DEFAULT 'stale'",
    "is_dirty TINYINT(1) NOT NULL DEFAULT 1",
  ],
  schema_migrations: [
    "migration_name VARCHAR(255) NOT NULL",
    "applied_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)",
  ],
};

const REQUIRED_KEYS = [
  "uq_stories_uuid",
  "uq_stories_slug",
  "uq_story_versions_uuid",
  "uq_story_versions_story_no",
  "uq_story_versions_checksum",
  "uq_story_opening_caches_uuid",
  "uq_story_opening_caches_scope_generation",
  "uq_game_sessions_uuid",
  "uq_session_events_event_id",
  "uq_session_events_seq",
  "uq_session_events_client_request",
  "uq_pending_batches_batch_uuid",
  "uq_pending_batches_request_uuid",
  "uq_session_checkpoints_uuid",
  "uq_endings_uuid",
  "uq_endings_version_key",
  "uq_schema_migrations_name",
];

const LEGACY_0001_KEYS = [
  "uq_story_opening_caches_scope",
];

const REQUIRED_INDEXES = [
  "idx_story_versions_story_status",
  "idx_story_opening_caches_valid",
  "idx_game_sessions_user_status",
  "idx_session_events_session_created",
  "idx_pending_batches_queue",
  "idx_session_checkpoints_dirty",
  "idx_endings_story_version_public",
];

const REQUIRED_FKS = [
  "REFERENCES stories(id)",
  "REFERENCES story_versions(id)",
  "REFERENCES story_opening_caches(id)",
  "REFERENCES game_sessions(id)",
  "REFERENCES endings(id)",
  "REFERENCES session_events(event_id)",
  "REFERENCES session_events(session_id, event_seq)",
];

const REQUIRED_APPEND_ONLY_TRIGGERS = [
  "DROP TRIGGER IF EXISTS trg_session_events_no_update",
  "DROP TRIGGER IF EXISTS trg_session_events_no_delete",
  "DROP TRIGGER IF EXISTS trg_session_events_first_choice",
  "CREATE TRIGGER trg_session_events_no_update",
  "BEFORE UPDATE ON session_events",
  "CREATE TRIGGER trg_session_events_no_delete",
  "BEFORE DELETE ON session_events",
  "CREATE TRIGGER trg_session_events_first_choice",
  "AFTER INSERT ON session_events",
  "SIGNAL SQLSTATE '45000'",
];

const REQUIRED_0002_FRAGMENTS = [
  "ALTER TABLE story_opening_caches",
  "ADD COLUMN IF NOT EXISTS generation_profile JSON NULL",
  "ADD COLUMN IF NOT EXISTS generation_hash CHAR(64) NULL",
  "ADD UNIQUE INDEX IF NOT EXISTS uq_story_opening_caches_scope_generation",
  "DROP INDEX IF EXISTS uq_story_opening_caches_scope",
  "DROP TRIGGER IF EXISTS trg_session_events_first_choice",
  "0002_opening_cache_generation_profile",
];

const JSON_TABLES = [
  "stories",
  "story_versions",
  "endings",
  "story_opening_caches",
  "game_sessions",
  "session_events",
  "pending_batches",
  "session_checkpoints",
];

const POSTGRES_ONLY_PATTERNS = [
  /\bSERIAL\b/,
  /\bBIGSERIAL\b/,
  /\bJSONB\b/,
  /\bTIMESTAMP\s+WITH\s+TIME\s+ZONE\b/i,
  /\bGENERATED\s+ALWAYS\s+AS\s+IDENTITY\b/i,
  /\bRETURNING\b/i,
  /\bON\s+CONFLICT\b/i,
  /::/,
];

const SECRET_PATTERNS = [
  /\bpassword\b/i,
  /\bapp_key\b/i,
  /\baccess_secret\b/i,
  /\baccess_token\b/i,
  /\bsecret_key\b/i,
];

let failures = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function tableBlock(sql, table) {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = sql.indexOf(marker);
  if (start === -1) return "";
  const engineAt = sql.indexOf("ENGINE=InnoDB", start);
  if (engineAt === -1) return "";
  const end = sql.indexOf(";", engineAt);
  return sql.slice(start, end === -1 ? undefined : end);
}

function triggerBlock(sql, triggerName) {
  const marker = `CREATE TRIGGER ${triggerName}`;
  const start = sql.indexOf(marker);
  if (start === -1) return "";
  const end = sql.indexOf("DELIMITER ;", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

let migration0001 = "";
let migration0002 = "";
let schema = "";
let docs = "";

try {
  migration0001 = await readFile(MIGRATION_0001_PATH, "utf8");
  migration0002 = await readFile(MIGRATION_0002_PATH, "utf8");
  schema = await readFile(SCHEMA_PATH, "utf8");
  docs = await readFile(DOCS_PATH, "utf8");
} catch (err) {
  check("required files exist", false, String(err.message || err));
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

// Files exist and are non-empty.
check("0001 migration file is non-empty", migration0001.trim().length > 0);
check("0002 migration file is non-empty", migration0002.trim().length > 0);
check("schema file is non-empty", schema.trim().length > 0);
check("data-model doc is non-empty", docs.trim().length > 0);

// Both SQL files define the required tables and columns.
for (const table of REQUIRED_TABLES) {
  const schemaBlock = tableBlock(schema, table);
  check(`schema defines table ${table}`, schemaBlock.length > 0);
  for (const column of REQUIRED_COLUMNS[table] || []) {
    check(
      `schema ${table}.${column.split(" ")[0]} column`,
      schemaBlock.includes(column)
    );
  }
}

// 0001 still describes the historical single-generation table, while 0002
// is the upgrade that adds the public generation profile dimensions.
{
  const legacyBlock = tableBlock(migration0001, "story_opening_caches");
  check("0001 defines story_opening_caches", legacyBlock.length > 0);
  check(
    "0001 keeps the old single-generation scope key",
    legacyBlock.includes("UNIQUE KEY uq_story_opening_caches_scope (story_id, story_version_id, opening_key)")
  );
  check(
    "0002 upgrades story_opening_caches with generation columns",
    REQUIRED_0002_FRAGMENTS.every((fragment) => migration0002.includes(fragment))
  );
}

// Engine and charset invariants.
for (const [label, sql] of [
  ["0001", migration0001],
  ["0002", migration0002],
  ["schema", schema],
]) {
  const tableCount = (sql.match(/CREATE TABLE IF NOT EXISTS\s+/g) || []).length;
  const engineCount = (sql.match(/ENGINE=InnoDB/g) || []).length;
  check(`${label} uses InnoDB for every table`, tableCount === engineCount, `${tableCount} tables / ${engineCount} engines`);
  check(`${label} pins UTC timezone`, sql.includes("SET time_zone = '+00:00'"));
  if (label !== "0002") {
    check(`${label} uses utf8mb4`, tableCount >= 1 && sql.includes("utf8mb4"));
    check(`${label} uses DATETIME(6)`, sql.includes("DATETIME(6)"));
  }
  if (label !== "0002") {
    for (const table of JSON_TABLES) {
      check(
        `${label} JSON_VALID guard for ${table}`,
        tableBlock(sql, table).includes("JSON_VALID")
      );
    }
  }
}

// Unique constraints, indexes, and FKs.
for (const key of REQUIRED_KEYS) {
  check(`schema unique key ${key}`, schema.includes(key));
}
for (const key of LEGACY_0001_KEYS) {
  check(`0001 preserves historical unique key ${key}`, migration0001.includes(key));
  check(
    `schema no longer uses legacy key ${key}`,
    !/UNIQUE KEY uq_story_opening_caches_scope \(/.test(schema)
  );
}
for (const index of REQUIRED_INDEXES) {
  check(`schema index ${index}`, schema.includes(index));
}
for (const fk of REQUIRED_FKS) {
  check(`schema FK ${fk}`, schema.includes(fk));
}

// Canonical history guards + first-choice trigger semantics.
for (const trigger of REQUIRED_APPEND_ONLY_TRIGGERS) {
  check(`schema append-only ${trigger}`, schema.includes(trigger));
}
{
  const firstChoice = triggerBlock(schema, "trg_session_events_first_choice");
  check(
    "schema first-choice trigger only writes game_sessions.first_choice_at",
    firstChoice.includes("UPDATE game_sessions") &&
      !firstChoice.includes("story_opening_caches") &&
      !firstChoice.includes("invalidated")
  );
}
{
  const firstChoice0001 = triggerBlock(migration0001, "trg_session_events_first_choice");
  check(
    "0001 historically cascaded to story_opening_caches",
    firstChoice0001.includes("UPDATE story_opening_caches")
  );
  const firstChoice0002 = triggerBlock(migration0002, "trg_session_events_first_choice");
  check(
    "0002 replaces the cascade with a session-only trigger",
    firstChoice0002.includes("UPDATE game_sessions") &&
      !firstChoice0002.includes("story_opening_caches")
  );
}

// MariaDB compatibility: reject PostgreSQL-only syntax in SQL files.
for (const [label, sql] of [
  ["0001", migration0001],
  ["0002", migration0002],
  ["schema", schema],
]) {
  for (const pattern of POSTGRES_ONLY_PATTERNS) {
    check(`${label} has no PostgreSQL-only token ${pattern}`, !pattern.test(sql));
  }
}

// Secrets must never be modeled in SQL.
for (const [label, sql] of [
  ["0001", migration0001],
  ["0002", migration0002],
  ["schema", schema],
]) {
  for (const pattern of SECRET_PATTERNS) {
    check(`${label} has no secret column ${pattern}`, !pattern.test(sql));
  }
}

// Documentation coverage.
for (const table of REQUIRED_TABLES) {
  check(`docs documents table ${table}`, docs.includes(`\`${table}\``));
}
for (const fragment of [
  "db/migrations/0001_initial_story_outside.sql",
  "db/migrations/0002_opening_cache_generation_profile.sql",
  "db/schema.sql",
  "node tests/schema-contract.test.mjs",
  "append-only",
  "UTC",
  "mariadb",
  "generation_profile",
  "session-local",
  "first_choice_at",
]) {
  check(`docs covers ${fragment}`, docs.includes(fragment));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall schema contract checks passed`);
