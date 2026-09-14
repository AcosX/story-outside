// tests/schema-contract.test.mjs — dependency-free schema/SQL contract checks.
// Validates db/migrations/0001_initial_story_outside.sql,
// db/migrations/0002_opening_cache_generation_profile.sql,
// db/migrations/0003_session_playback.sql, db/migrations/0004_pending_batch_lifecycle.sql,
// db/migrations/0005_compact_and_context.sql, db/migrations/0006_business_persistence.sql,
// db/migrations/0007_session_event_request_scope.sql, db/migrations/0008_client_request_id_width.sql,
// db/schema.sql, and
// docs/data-model.md without needing database credentials or a running server.
// The point of this suite is to keep the migration set and the canonical
// schema.sql entrypoint in lockstep — column drift, a missing CHECK, or a
// renamed trigger in either direction turns the suite red.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATION_0001_PATH = join(ROOT, "db/migrations/0001_initial_story_outside.sql");
const MIGRATION_0002_PATH = join(ROOT, "db/migrations/0002_opening_cache_generation_profile.sql");
const MIGRATION_0003_PATH = join(ROOT, "db/migrations/0003_session_playback.sql");
const MIGRATION_0004_PATH = join(ROOT, "db/migrations/0004_pending_batch_lifecycle.sql");
const MIGRATION_0005_PATH = join(ROOT, "db/migrations/0005_compact_and_context.sql");
const MIGRATION_0006_PATH = join(ROOT, "db/migrations/0006_business_persistence.sql");
const MIGRATION_0007_PATH = join(ROOT, "db/migrations/0007_session_event_request_scope.sql");
const MIGRATION_0008_PATH = join(ROOT, "db/migrations/0008_client_request_id_width.sql");
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
  "pending_batch_items",
  "session_checkpoints",
  "compact_compacted_events",
  "model_context_windows",
  "story_community_profiles",
  "ecosystem_follow_edges",
  "ecosystem_block_edges",
  "ecosystem_shared_sessions",
  "ecosystem_search_cache",
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
    "model VARCHAR(128) NOT NULL",
    "prompt TEXT NOT NULL",
    "generation_profile JSON NOT NULL",
    "user_uuid CHAR(36) NULL",
    "status ENUM('active', 'paused', 'ended', 'abandoned') NOT NULL DEFAULT 'active'",
    "opening_cache_id BIGINT UNSIGNED NULL",
    "first_choice_at DATETIME(6) NULL",
    "opening_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0",
    "opening_state ENUM('opening', 'awaiting_first_choice', 'realtime') NOT NULL DEFAULT 'opening'",
    "session_revision BIGINT UNSIGNED NOT NULL DEFAULT 0",
    "ending_id BIGINT UNSIGNED NULL",
    "ended_at DATETIME(6) NULL",
    "context_compact_text MEDIUMTEXT NULL",
    "context_compact_payload JSON NULL",
    "compacted_through_seq BIGINT UNSIGNED NULL",
    "compacted_event_count INT UNSIGNED NULL",
    "token_estimate INT UNSIGNED NULL",
    "context_window INT UNSIGNED NULL",
    "context_safety_ratio DECIMAL(5,4) NULL",
    "reserved_completion_tokens INT UNSIGNED NULL",
    "context_schema_version INT UNSIGNED NOT NULL DEFAULT 1",
    "prompt_version INT UNSIGNED NOT NULL DEFAULT 1",
    "last_compact_status ENUM('idle', 'compacted', 'skipped', 'failed') NOT NULL DEFAULT 'idle'",
    "runtime_payload JSON NULL",
  ],
  session_events: [
    "event_id CHAR(36) NOT NULL",
    "event_type ENUM(",
    "    'player_input',",
    "origin ENUM('user', 'system', 'llm', 'imported') NOT NULL",
    "session_id BIGINT UNSIGNED NOT NULL",
    "event_seq BIGINT UNSIGNED NOT NULL",
    "prev_event_seq BIGINT UNSIGNED NULL",
    "source VARCHAR(64) NOT NULL",
    "source_sequence BIGINT UNSIGNED NOT NULL",
    "payload JSON NOT NULL",
    "client_request_id VARCHAR(255) NULL",
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
    "expected_revision BIGINT UNSIGNED NOT NULL DEFAULT 0",
    "request_fingerprint CHAR(64) NULL",
    "committed_count INT UNSIGNED NOT NULL DEFAULT 0",
    "item_count INT UNSIGNED NOT NULL DEFAULT 0",
    "source VARCHAR(64) NOT NULL DEFAULT 'runtime'",
    "superseded_by CHAR(36) NULL",
  ],
  pending_batch_items: [
    "batch_id BIGINT UNSIGNED NOT NULL",
    "session_id BIGINT UNSIGNED NOT NULL",
    "item_uuid CHAR(36) NOT NULL",
    "item_seq INT UNSIGNED NOT NULL",
    "item_type ENUM('narrative_beat', 'tool_call') NOT NULL",
    "status ENUM('pending', 'committed', 'discarded') NOT NULL DEFAULT 'pending'",
    "payload JSON NOT NULL",
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
  compact_compacted_events: [
    "session_id BIGINT UNSIGNED NOT NULL",
    "attempt_uuid CHAR(36) NOT NULL",
    "status ENUM('compacted', 'skipped', 'failed') NOT NULL",
    "compacted_through_seq BIGINT UNSIGNED NOT NULL",
    "event_count INT UNSIGNED NOT NULL DEFAULT 0",
    "context_window INT UNSIGNED NULL",
    "folded_event_seqs JSON NOT NULL",
    "summary_excerpt VARCHAR(500) NULL",
  ],
  model_context_windows: [
    "model VARCHAR(128) NOT NULL",
    "context_window INT UNSIGNED NOT NULL",
    "safety_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.1000",
    "reserved_completion_tokens INT UNSIGNED NOT NULL DEFAULT 1024",
    "is_active TINYINT(1) NOT NULL DEFAULT 1",
  ],
  story_community_profiles: [
    "profile_uuid CHAR(36) NOT NULL",
    "story_id BIGINT UNSIGNED NOT NULL",
    "story_version_id BIGINT UNSIGNED NOT NULL",
    "generator_version VARCHAR(255) NOT NULL",
    "content_hash CHAR(64) NOT NULL",
    "profile_payload JSON NOT NULL",
    "source VARCHAR(32) NOT NULL",
    "generated_at DATETIME(6) NOT NULL",
  ],
  ecosystem_follow_edges: [
    "follower_uuid CHAR(36) NOT NULL",
    "target_user_uuid CHAR(36) NOT NULL",
    "created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)",
  ],
  ecosystem_block_edges: [
    "owner_uuid CHAR(36) NOT NULL",
    "target_user_uuid CHAR(36) NOT NULL",
    "created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)",
  ],
  ecosystem_shared_sessions: [
    "session_uuid CHAR(36) NOT NULL",
    "owner_user_uuid CHAR(36) NOT NULL",
    "title VARCHAR(200) NULL",
    "story_uuid CHAR(36) NULL",
    "story_version_uuid CHAR(36) NULL",
  ],
  ecosystem_search_cache: [
    "cache_key VARCHAR(512) NOT NULL",
    "story_uuid CHAR(36) NOT NULL",
    "story_version_uuid CHAR(36) NOT NULL",
    "community_profile_version VARCHAR(255) NOT NULL",
    "query_id VARCHAR(128) NOT NULL",
    "query_text VARCHAR(500) NOT NULL",
    "value JSON NOT NULL",
    "fetched_at_ms BIGINT UNSIGNED NOT NULL",
    "expires_at_ms BIGINT UNSIGNED NOT NULL",
    "swr_expires_at_ms BIGINT UNSIGNED NOT NULL",
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
  "uq_session_events_source_sequence",
  "uq_pending_batches_batch_uuid",
  "uq_pending_batches_request_uuid",
  "uq_pending_batches_fingerprint",
  "uq_pending_batch_items_uuid",
  "uq_pending_batch_items_batch_seq",
  "uq_session_checkpoints_uuid",
  "uq_compact_compacted_events_attempt",
  "uq_model_context_windows_model",
  "uq_endings_uuid",
  "uq_endings_version_key",
  "uq_schema_migrations_name",
];

const LEGACY_0001_KEYS = [
  "uq_story_opening_caches_scope",
];

const REQUIRED_INDEXES = [
  "idx_story_versions_story_status",
  "idx_story_versions_story_id_id",
  "idx_story_opening_caches_valid",
  "idx_story_opening_caches_story_version_id",
  "idx_game_sessions_user_status",
  "idx_game_sessions_playback",
  "idx_game_sessions_story_version_cache",
  "idx_game_sessions_compact_status",
  "idx_session_events_session_created",
  "idx_session_events_source_sequence",
  "idx_session_events_session_event",
  "idx_pending_batches_queue",
  "idx_pending_batches_session_id_id",
  "idx_pending_batches_fingerprint",
  "idx_pending_batch_items_batch_status",
  "idx_session_checkpoints_dirty",
  "idx_compact_compacted_events_session_status",
  "idx_endings_story_version_public",
  "idx_story_community_profiles_story_version",
  "idx_ecosystem_follow_edges_target",
  "idx_ecosystem_block_edges_target",
  "idx_ecosystem_shared_sessions_owner",
  "idx_ecosystem_search_cache_identity",
  "idx_ecosystem_search_cache_expiry",
];

const REQUIRED_FKS = [
  "REFERENCES stories(id)",
  "REFERENCES story_versions(id)",
  "REFERENCES story_versions(story_id, id)",
  "REFERENCES story_opening_caches(id)",
  "REFERENCES story_opening_caches(story_id, story_version_id, id)",
  "REFERENCES game_sessions(id)",
  "REFERENCES endings(id)",
  "REFERENCES session_events(event_id)",
  "REFERENCES session_events(session_id, event_id)",
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

const REQUIRED_0003_FRAGMENTS = [
  "ALTER TABLE game_sessions",
  "ADD COLUMN IF NOT EXISTS model VARCHAR(128) NULL",
  "ADD COLUMN IF NOT EXISTS prompt TEXT NULL",
  "ADD COLUMN IF NOT EXISTS generation_profile JSON NULL",
  "ADD COLUMN IF NOT EXISTS opening_cursor BIGINT UNSIGNED NULL DEFAULT 0",
  "ADD COLUMN IF NOT EXISTS opening_state ENUM('opening', 'awaiting_first_choice', 'realtime') NULL DEFAULT 'opening'",
  "ADD COLUMN IF NOT EXISTS session_revision BIGINT UNSIGNED NULL DEFAULT 0",
  "ADD INDEX IF NOT EXISTS idx_story_versions_story_id_id",
  "ADD INDEX IF NOT EXISTS idx_story_opening_caches_story_version_id",
  "ADD UNIQUE INDEX IF NOT EXISTS uq_session_events_source_sequence",
  "ADD COLUMN IF NOT EXISTS source VARCHAR(64) NULL",
  "ADD COLUMN IF NOT EXISTS source_sequence BIGINT UNSIGNED NULL",
  "DROP TRIGGER IF EXISTS trg_session_events_no_update",
  "CREATE TRIGGER trg_session_events_no_update",
  "MODIFY event_type ENUM(",
  "    'player_input',",
  "MODIFY origin ENUM('user', 'system', 'llm', 'imported') NOT NULL",
  "DROP FOREIGN KEY IF EXISTS fk_game_sessions_story_version_pair",
  "DROP FOREIGN KEY IF EXISTS fk_game_sessions_opening_cache_scope",
  "ADD CONSTRAINT fk_game_sessions_story_version_pair",
  "ADD CONSTRAINT fk_game_sessions_opening_cache_scope",
  "ADD CONSTRAINT fk_story_opening_caches_story_version_pair",
  "ADD CONSTRAINT chk_session_events_source",
  "0003_session_playback",
];

const REQUIRED_0004_FRAGMENTS = [
  "ALTER TABLE pending_batches",
  "ADD COLUMN IF NOT EXISTS expected_revision BIGINT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64) NULL",
  "ADD COLUMN IF NOT EXISTS committed_count INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS item_count INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS superseded_by CHAR(36) NULL",
  "ADD COLUMN IF NOT EXISTS source VARCHAR(64) NULL",
  "ADD UNIQUE INDEX IF NOT EXISTS uq_pending_batches_fingerprint",
  "MODIFY expected_revision BIGINT UNSIGNED NOT NULL DEFAULT 0",
  "chk_pending_batches_source",
  "chk_pending_batches_counts",
  "ADD COLUMN IF NOT EXISTS session_id BIGINT UNSIGNED NULL",
  "idx_session_events_session_event",
  "idx_pending_batches_session_id_id",
  "fk_pending_batches_promoted_event_session",
  "fk_pending_batch_items_session_batch",
  "fk_pending_batch_items_promoted_event_session",
  "chk_pending_batch_items_pending",
  "chk_pending_batch_items_tool_commit",
  "CREATE TABLE IF NOT EXISTS pending_batch_items",
  "UNIQUE KEY uq_pending_batch_items_uuid",
  "UNIQUE KEY uq_pending_batch_items_batch_seq (batch_id, item_seq)",
  "fk_pending_batch_items_batch",
  "fk_pending_batch_items_promoted_event",
  "chk_pending_batch_items_seq",
  "chk_pending_batch_items_payload",
  "chk_pending_batch_items_committed",
  "chk_pending_batch_items_discarded",
  "0004_pending_batch_lifecycle",
];

// 0005 is the compact/context upgrade. Every fragment below must appear in
// the migration, and the CHECK expressions / trigger must be textually
// identical to db/schema.sql (checked further down) so a 0001→0005 upgrade
// ends up equivalent to a fresh install.
const REQUIRED_0005_FRAGMENTS = [
  "ALTER TABLE game_sessions",
  "ADD COLUMN IF NOT EXISTS context_compact_text MEDIUMTEXT NULL",
  "ADD COLUMN IF NOT EXISTS context_compact_payload JSON NULL",
  "ADD COLUMN IF NOT EXISTS compacted_through_seq BIGINT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS compacted_event_count INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS token_estimate INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS context_window INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS context_safety_ratio DECIMAL(5,4) NULL",
  "ADD COLUMN IF NOT EXISTS reserved_completion_tokens INT UNSIGNED NULL",
  "ADD COLUMN IF NOT EXISTS context_schema_version INT UNSIGNED NOT NULL DEFAULT 1",
  "ADD COLUMN IF NOT EXISTS prompt_version INT UNSIGNED NOT NULL DEFAULT 1",
  "ADD COLUMN IF NOT EXISTS last_compact_at DATETIME(6) NULL",
  "ADD COLUMN IF NOT EXISTS last_compact_attempt_at DATETIME(6) NULL",
  "ADD COLUMN IF NOT EXISTS last_compact_status ENUM('idle', 'compacted', 'skipped', 'failed') NOT NULL DEFAULT 'idle'",
  "ADD COLUMN IF NOT EXISTS last_compact_error VARCHAR(500) NULL",
  "ADD INDEX IF NOT EXISTS idx_game_sessions_compact_status",
  "CREATE TABLE IF NOT EXISTS compact_compacted_events",
  "CREATE TABLE IF NOT EXISTS model_context_windows",
  "UNIQUE KEY uq_compact_compacted_events_attempt",
  "UNIQUE KEY uq_model_context_windows_model",
  "KEY idx_compact_compacted_events_session_status (session_id, status, created_at)",
  "fk_compact_compacted_events_session",
  "chk_compact_compacted_events_folded_seqs",
  "INSERT IGNORE INTO model_context_windows",
  "INSERT IGNORE INTO schema_migrations (migration_name, applied_by)",
  "0005_compact_and_context",
];

const REQUIRED_0006_FRAGMENTS = [
  "ALTER TABLE game_sessions",
  "ADD COLUMN IF NOT EXISTS user_uuid CHAR(36) NULL AFTER generation_profile",
  "ADD COLUMN IF NOT EXISTS runtime_payload JSON NULL AFTER last_compact_error",
  "CREATE TABLE IF NOT EXISTS story_community_profiles",
  "CREATE TABLE IF NOT EXISTS ecosystem_follow_edges",
  "CREATE TABLE IF NOT EXISTS ecosystem_block_edges",
  "CREATE TABLE IF NOT EXISTS ecosystem_shared_sessions",
  "CREATE TABLE IF NOT EXISTS ecosystem_search_cache",
  "chk_story_community_profiles_payload",
  "chk_ecosystem_search_cache_expiry",
  "INSERT IGNORE INTO schema_migrations (migration_name, applied_by)",
  "0006_business_persistence",
];

// The exact CHECK expressions both schema.sql AND 0005 must carry, verbatim
// (this is the drift the 0005 review caught: the migration previously skipped
// these five CHECKs while schema.sql had them).
const REQUIRED_GAME_SESSIONS_COMPACT_CHECK_EXPRESSIONS = [
  "chk_game_sessions_token_estimate CHECK (token_estimate IS NULL OR token_estimate >= 0)",
  "chk_game_sessions_context_window CHECK (context_window IS NULL OR context_window > 0)",
  "chk_game_sessions_safety_ratio CHECK (context_safety_ratio IS NULL OR (context_safety_ratio >= 0 AND context_safety_ratio < 1))",
  "chk_game_sessions_compact_seq CHECK (compacted_through_seq IS NULL OR compacted_through_seq > 0)",
  "chk_game_sessions_compact_payload CHECK (context_compact_payload IS NULL OR JSON_VALID(context_compact_payload))",
];

const COMPACT_MONOTONIC_TRIGGER = "trg_game_sessions_compact_monotonic";
const LEGACY_COMPACT_TRIGGER = "trg_game_sessions_no_compact_overwrite";

const JSON_TABLES = [
  "stories",
  "story_versions",
  "endings",
  "story_opening_caches",
  "game_sessions",
  "session_events",
  "pending_batches",
  "pending_batch_items",
  "session_checkpoints",
  "compact_compacted_events",
  "story_community_profiles",
  "ecosystem_search_cache",
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

function columnLabel(fragment) {
  return fragment.trim().split(/\s+/)[0] || "fragment";
}

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

// Strip comments and collapse whitespace so two SQL blocks can be compared
// semantically (the migration may carry inline comments schema.sql lacks).
function normalizedSql(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\s+/g, " ");
}

let migration0001 = "";
let migration0002 = "";
let migration0003 = "";
let migration0004 = "";
let migration0005 = "";
let migration0006 = "";
let migration0007 = "";
let migration0008 = "";
let schema = "";
let docs = "";

try {
  migration0001 = await readFile(MIGRATION_0001_PATH, "utf8");
  migration0002 = await readFile(MIGRATION_0002_PATH, "utf8");
  migration0003 = await readFile(MIGRATION_0003_PATH, "utf8");
  migration0004 = await readFile(MIGRATION_0004_PATH, "utf8");
  migration0005 = await readFile(MIGRATION_0005_PATH, "utf8");
  migration0006 = await readFile(MIGRATION_0006_PATH, "utf8");
  migration0007 = await readFile(MIGRATION_0007_PATH, "utf8");
  migration0008 = await readFile(MIGRATION_0008_PATH, "utf8");
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
check("0003 migration file is non-empty", migration0003.trim().length > 0);
check("0004 migration file is non-empty", migration0004.trim().length > 0);
check("0005 migration file is non-empty", migration0005.trim().length > 0);
check("0006 migration file is non-empty", migration0006.trim().length > 0);
check("0007 upgrades request ID uniqueness to session scope", migration0007.includes("(session_id, client_request_id)") && migration0007.includes("DROP INDEX IF EXISTS uq_session_events_client_request"));
check("0008 widens opaque request IDs", migration0008.includes("MODIFY COLUMN client_request_id VARCHAR(255) NULL") && migration0008.includes("0008_client_request_id_width"));
check("schema request ID uniqueness is session scoped", schema.includes("UNIQUE KEY uq_session_events_client_request (session_id, client_request_id)"));
check("schema records 0007", schema.includes("'0007_session_event_request_scope', NULL"));
check("schema records 0008", schema.includes("'0008_client_request_id_width', NULL"));
check("schema file is non-empty", schema.trim().length > 0);
check("data-model doc is non-empty", docs.trim().length > 0);

// Both SQL files define the required tables and columns.
for (const table of REQUIRED_TABLES) {
  const schemaBlock = tableBlock(schema, table);
  check(`schema defines table ${table}`, schemaBlock.length > 0);
  for (const column of REQUIRED_COLUMNS[table] || []) {
    check(
      `schema ${table}.${columnLabel(column)} contract`,
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

// 0003 is the session playback/canonical provenance upgrade and is safe to
// repeat after 0001 then 0002.
check(
  "0003 contains session playback and provenance fragments",
  REQUIRED_0003_FRAGMENTS.every((fragment) => migration0003.includes(fragment))
);
check(
  "0003 backfills nullable columns before NOT NULL conversion",
  migration0003.indexOf("UPDATE game_sessions") < migration0003.indexOf("MODIFY model VARCHAR(128) NOT NULL") &&
    migration0003.indexOf("UPDATE session_events") < migration0003.indexOf("MODIFY source VARCHAR(64) NOT NULL")
);
check(
  "0003 records its migration ledger entry",
  migration0003.includes("INSERT IGNORE INTO schema_migrations")
);

// 0004 adds the pending batch lifecycle columns and pending_batch_items
// table; both must round-trip through the canonical schema.sql entrypoint.
check(
  "0004 contains pending batch lifecycle fragments",
  REQUIRED_0004_FRAGMENTS.every((fragment) => migration0004.includes(fragment))
);
check(
  "0004 backfills nullable columns before NOT NULL conversion",
  migration0004.indexOf("UPDATE pending_batches") < migration0004.indexOf("MODIFY expected_revision BIGINT UNSIGNED NOT NULL")
);
check(
  "0004 records its migration ledger entry",
  migration0004.includes("INSERT IGNORE INTO schema_migrations (migration_name, applied_by)")
);
// Story 08 P1.4: the discarded CHECK constraint must reject any row
// where status='discarded' but promoted_event_id/occurred_at are set.
check(
  "0004 discarded CHECK rejects promoted_event_id on discarded rows",
  migration0004.includes("status = 'discarded' AND occurred_at IS NULL AND promoted_event_id IS NULL")
);
check(
  "schema.sql discarded CHECK also rejects promoted_event_id on discarded rows",
  schema.includes("status = 'discarded' AND occurred_at IS NULL AND promoted_event_id IS NULL")
);
check(
  "docs/data-model.md documents the discarded CHECK contract",
  docs.includes("discarded") && docs.includes("promoted_event_id")
);
// 0004 must backfill terminal rows' completed_at BEFORE adding
// chk_pending_batches_completed, or the CHECK would reject pre-existing
// 0001-era rows and the migration would fail.
{
  const backfillAt = migration0004.indexOf("SET completed_at = COALESCE(updated_at");
  check(
    "0004 backfills terminal completed_at before chk_pending_batches_completed",
    backfillAt !== -1 && backfillAt < migration0004.indexOf("ADD CONSTRAINT chk_pending_batches_completed")
  );
}
// 0004's AFTER clauses must reproduce schema.sql's pending_batches column
// order so a 0001→0004 upgrade lands physically identical to a fresh install.
check(
  "0004 pending_batches column order matches schema.sql (AFTER chain)",
  [
    "expected_revision BIGINT UNSIGNED NULL AFTER base_event_id",
    "superseded_by CHAR(36) NULL AFTER promoted_event_id",
    "source VARCHAR(64) NULL AFTER request_uuid",
    "request_fingerprint CHAR(64) NULL AFTER request_payload",
    "committed_count INT UNSIGNED NULL AFTER completed_at",
    "item_count INT UNSIGNED NULL AFTER committed_count",
  ].every((fragment) => migration0004.includes(fragment))
);
check(
  "0004 pending_batch_items session scope column order matches schema.sql",
  migration0004.includes("session_id BIGINT UNSIGNED NULL AFTER batch_id")
);

// 0005 is the compact/context upgrade; it must keep every game_sessions
// column, CHECK, and the compact-monotonic trigger in lockstep with
// schema.sql (this exact drift — a missing CHECK + a renamed trigger — is
// what the review caught).
check(
  "0005 contains the compact/context fragments",
  REQUIRED_0005_FRAGMENTS.every((fragment) => migration0005.includes(fragment))
);
check(
  "0005 records its migration ledger entry",
  migration0005.includes("INSERT IGNORE INTO schema_migrations (migration_name, applied_by)")
);

check(
  "0006 contains business persistence fragments",
  REQUIRED_0006_FRAGMENTS.every((fragment) => migration0006.includes(fragment))
);
check(
  "0006 records its migration ledger entry",
  migration0006.includes("INSERT IGNORE INTO schema_migrations (migration_name, applied_by)")
);
for (const table of [
  "story_community_profiles",
  "ecosystem_follow_edges",
  "ecosystem_block_edges",
  "ecosystem_shared_sessions",
  "ecosystem_search_cache",
]) {
  const schemaBlock = tableBlock(schema, table);
  const migrationBlock = tableBlock(migration0006, table);
  check(`0006 defines table ${table}`, migrationBlock.length > 0);
  check(
    `0006 ${table} matches schema.sql exactly (comments/whitespace aside)`,
    migrationBlock.length > 0 && schemaBlock.length > 0 &&
      normalizedSql(migrationBlock) === normalizedSql(schemaBlock)
  );
}
check(
  "schema records the 0006 migration ledger entry",
  schema.includes("'0006_business_persistence', NULL")
);
for (const expression of REQUIRED_GAME_SESSIONS_COMPACT_CHECK_EXPRESSIONS) {
  check(`schema game_sessions constraint ${expression.split(" ")[0]}`, schema.includes(expression));
  check(
    `0005 adds the same CHECK as schema: ${expression.split(" ")[0]}`,
    migration0005.includes(expression)
  );
}
{
  const schemaTrigger = triggerBlock(schema, COMPACT_MONOTONIC_TRIGGER);
  const migrationTrigger = triggerBlock(migration0005, COMPACT_MONOTONIC_TRIGGER);
  check("schema defines trg_game_sessions_compact_monotonic", schemaTrigger.length > 0);
  check(
    "0005 recreates the compact-monotonic trigger under the schema.sql name",
    migrationTrigger.length > 0 &&
      migrationTrigger.includes("BEFORE UPDATE ON game_sessions") &&
      migrationTrigger.includes("compacted_through_seq is monotonically advancing")
  );
  check(
    "0005 compact-monotonic trigger body matches schema.sql exactly",
    migrationTrigger.length > 0 &&
      normalizedSql(migrationTrigger) === normalizedSql(schemaTrigger)
  );
  // The pre-review trigger name must never be created again; 0005 keeps a
  // DROP for databases that already ran the earlier revision.
  check(
    `schema does not carry the legacy trigger ${LEGACY_COMPACT_TRIGGER}`,
    !schema.includes(`CREATE TRIGGER ${LEGACY_COMPACT_TRIGGER}`)
  );
  check(
    `0005 drops (but never creates) the legacy trigger ${LEGACY_COMPACT_TRIGGER}`,
    migration0005.includes(`DROP TRIGGER IF EXISTS ${LEGACY_COMPACT_TRIGGER}`) &&
      !migration0005.includes(`CREATE TRIGGER ${LEGACY_COMPACT_TRIGGER}`)
  );
}
// The two tables 0005 owns must be byte-identical (comments/whitespace
// aside) to their schema.sql counterparts. When a future migration ALTERs
// one of them, move this comparison to the latest defining migration.
for (const table of ["compact_compacted_events", "model_context_windows"]) {
  const schemaBlock = tableBlock(schema, table);
  const migrationBlock = tableBlock(migration0005, table);
  check(`0005 defines table ${table}`, migrationBlock.length > 0);
  check(
    `0005 ${table} matches schema.sql exactly (comments/whitespace aside)`,
    migrationBlock.length > 0 && schemaBlock.length > 0 &&
      normalizedSql(migrationBlock) === normalizedSql(schemaBlock)
  );
}

// Engine and charset invariants.
for (const [label, sql] of [
  ["0001", migration0001],
  ["0002", migration0002],
  ["0003", migration0003],
  ["0004", migration0004],
  ["0005", migration0005],
  ["schema", schema],
]) {
  const tableCount = (sql.match(/CREATE TABLE IF NOT EXISTS\s+/g) || []).length;
  const engineCount = (sql.match(/ENGINE=InnoDB/g) || []).length;
  // 0004 adds one new table (pending_batch_items) and alters pending_batches.
  // It uses CREATE TABLE IF NOT EXISTS exactly once.
  if (label === "0004") {
    check(`${label} uses InnoDB for every table`, engineCount >= tableCount && engineCount > 0, `${tableCount} tables / ${engineCount} engines`);
  } else {
    check(`${label} uses InnoDB for every table`, tableCount === engineCount, `${tableCount} tables / ${engineCount} engines`);
  }
  check(`${label} pins UTC timezone`, sql.includes("SET time_zone = '+00:00'"));
  if (!["0002", "0003", "0004"].includes(label)) {
    check(`${label} uses utf8mb4`, tableCount >= 1 && sql.includes("utf8mb4"));
    check(`${label} uses DATETIME(6)`, sql.includes("DATETIME(6)"));
  }
  if (label === "0004") {
    // 0004 only creates pending_batch_items; other tables are inherited
    // from 0001/0002/0003.
    check(`${label} JSON_VALID guard for pending_batch_items`, sql.includes("JSON_VALID(payload)"));
  } else if (label === "0001" || label === "schema") {
    for (const table of JSON_TABLES) {
      // Tables created by later migrations are not part of 0001.
      if (label === "0001" && [
        "pending_batch_items",
        "compact_compacted_events",
        "story_community_profiles",
        "ecosystem_search_cache",
      ].includes(table)) continue;
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
check(
  "schema composite FK support indexes are not redundant UNIQUE keys",
  schema.includes("KEY idx_story_versions_story_id_id (story_id, id)") &&
    schema.includes("KEY idx_story_opening_caches_story_version_id (story_id, story_version_id, id)") &&
    !schema.includes("UNIQUE KEY uq_story_versions_story_id_id") &&
    !schema.includes("UNIQUE KEY uq_story_opening_caches_story_version_id")
);
for (const constraint of [
  "chk_game_sessions_model",
  "chk_game_sessions_generation_profile",
  "chk_game_sessions_opening_cursor",
  "chk_game_sessions_revision",
  "chk_game_sessions_token_estimate",
  "chk_game_sessions_context_window",
  "chk_game_sessions_safety_ratio",
  "chk_game_sessions_compact_seq",
  "chk_game_sessions_compact_payload",
  "chk_session_events_source",
  "chk_session_events_source_sequence",
  "chk_pending_batches_source",
  "chk_pending_batches_counts",
  "chk_pending_batches_completed",
  "chk_pending_batch_items_seq",
  "chk_pending_batch_items_payload",
  "chk_pending_batch_items_committed",
  "chk_pending_batch_items_discarded",
  "chk_pending_batch_items_pending",
  "chk_pending_batch_items_tool_commit",
  "chk_compact_compacted_events_through_seq",
  "chk_compact_compacted_events_folded_seqs",
  "chk_model_context_windows_window",
  "chk_model_context_windows_safety",
]) {
  check(`schema constraint ${constraint}`, schema.includes(constraint));
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
  ["0003", migration0003],
  ["0004", migration0004],
  ["0005", migration0005],
  ["0006", migration0006],
  ["0007", migration0007],
  ["0008", migration0008],
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
  ["0003", migration0003],
  ["0004", migration0004],
  ["0005", migration0005],
  ["0006", migration0006],
  ["0007", migration0007],
  ["0008", migration0008],
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
  "db/migrations/0003_session_playback.sql",
  "db/migrations/0004_pending_batch_lifecycle.sql",
  "db/migrations/0005_compact_and_context.sql",
  "db/migrations/0006_business_persistence.sql",
  "db/migrations/0007_session_event_request_scope.sql",
  "db/migrations/0008_client_request_id_width.sql",
  "db/schema.sql",
  "node tests/schema-contract.test.mjs",
  "append-only",
  "UTC",
  "mariadb",
  "generation_profile",
  "session-local",
  "first_choice_at",
  "player_input",
  "imported",
  "source_sequence",
  "narrative_beat",
  "request_fingerprint",
  "compacted_through_seq",
  "trg_game_sessions_compact_monotonic",
  "model_context_windows",
]) {
  check(`docs covers ${fragment}`, docs.includes(fragment));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nall schema contract checks passed`);
