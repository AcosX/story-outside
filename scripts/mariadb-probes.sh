#!/usr/bin/env bash
# Scratch MariaDB verification for the Story Outside business schema.
# - 0001→0008 applied, each migration repeated 3x to prove idempotency
# - repeat 0008 after full chain
# - fresh schema.sql applies standalone: the CREATE DATABASE / USE statements
#   inside schema.sql are rewritten to a uniquely-named scratch DB, so a
#   pre-existing story_outside database on this machine is NEVER touched or
#   dropped (same approach as docs/data-model.md §6 方式 A)
# - negative probes: source='', committed_count>item_count, pending+promoted_event,
#   cross-session promotion (two sessions), tool_call committed, item/batch mismatch
# - drops the scratch DBs at the end (and on early failure, via the EXIT trap)
set -u
REPO="${1:-$(pwd)}"
cd "$REPO" || { echo "repo not found: $REPO"; exit 1; }

DB="story_outside_scratch_$$"
SCHEMA_DB="story_outside_schema_check_$$"
ERR_LOG="$(mktemp)"
SCHEMA_SQL="$(mktemp)"
FAIL=0

cleanup() {
  # Never leave a scratch DB or temp file behind, even on an early exit.
  mariadb --no-defaults -e "DROP DATABASE IF EXISTS \`$DB\`; DROP DATABASE IF EXISTS \`$SCHEMA_DB\`;" >/dev/null 2>&1
  rm -f "$ERR_LOG" "$SCHEMA_SQL"
}
trap cleanup EXIT

say()  { printf '%s\n' "$*"; }
fail() { say "PROBE-FAILED: $*"; FAIL=1; }

# Resolve session ids via subquery so the probes survive a non-1 auto_increment
# step (this server has auto_increment_increment=3).
S1="(SELECT id FROM game_sessions WHERE session_uuid='00000000-0000-4000-8000-000000000003')"
S2="(SELECT id FROM game_sessions WHERE session_uuid='00000000-0000-4000-8000-000000000004')"

mariadb --no-defaults -e "CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# --- 0001 -> 0008, each migration applied 3 times (idempotency) ---
for m in 0001_initial_story_outside 0002_opening_cache_generation_profile 0003_session_playback 0004_pending_batch_lifecycle 0005_compact_and_context 0006_business_persistence 0007_session_event_request_scope 0008_client_request_id_width; do
  for i in 1 2 3; do
    if ! mariadb --no-defaults "$DB" < "db/migrations/$m.sql" 2>"$ERR_LOG"; then
      fail "migration $m pass $i failed: $(cat "$ERR_LOG")"
    fi
  done
done

# --- repeat 0008 once more explicitly ---
mariadb --no-defaults "$DB" < db/migrations/0008_client_request_id_width.sql 2>"$ERR_LOG" || fail "repeat 0008 failed: $(cat "$ERR_LOG")"

# Ledger must record exactly 8 migrations.
LEDGER=$(mariadb --no-defaults -N -e "SELECT COUNT(*) FROM \`$DB\`.schema_migrations;")
[ "$LEDGER" = "8" ] || fail "schema_migrations count=$LEDGER (want 8)"
say "ok   ledger: 8 migrations recorded after 3x apply + repeat"

# --- fresh schema.sql standalone ---
# schema.sql hardcodes CREATE DATABASE story_outside + USE story_outside.
# Rewriting those two statements to the scratch name keeps the standalone
# check intact without ever creating or dropping a fixed-name database.
sed -e "s/CREATE DATABASE IF NOT EXISTS story_outside/CREATE DATABASE IF NOT EXISTS \`$SCHEMA_DB\`/" \
    -e "s/^USE story_outside;/USE \`$SCHEMA_DB\`;/" \
    db/schema.sql > "$SCHEMA_SQL"
mariadb --no-defaults < "$SCHEMA_SQL" 2>"$ERR_LOG" || fail "schema.sql apply failed: $(cat "$ERR_LOG")"
SCHEMA_TABLES=$(mariadb --no-defaults -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$SCHEMA_DB';")
[ "$SCHEMA_TABLES" = "17" ] || fail "schema.sql table count=$SCHEMA_TABLES (want 17)"
SCHEMA_LEDGER=$(mariadb --no-defaults -N -e "SELECT COUNT(*) FROM \`$SCHEMA_DB\`.schema_migrations;")
[ "$SCHEMA_LEDGER" = "8" ] || fail "schema.sql ledger count=$SCHEMA_LEDGER (want 8)"
say "ok   fresh schema.sql standalone (17 tables, 8 migrations)"
mariadb --no-defaults -e "DROP DATABASE \`$SCHEMA_DB\`;"

# --- fixture seed (two sessions, one canonical event each) ---
mariadb --no-defaults "$DB" <<'SQL' 2>"$ERR_LOG" || fail "fixture seed failed: $(cat "$ERR_LOG")"
INSERT INTO stories (story_uuid, slug, title, hook) VALUES
  ('00000000-0000-4000-8000-000000000001', 'probe', 'Probe', 'hook');
INSERT INTO story_versions (version_uuid, story_id, version_no, title, hook, content_payload, roles_payload, checksum)
  VALUES ('00000000-0000-4000-8000-000000000002', 1, 1, 'Probe', 'hook', JSON_OBJECT('title','Probe'), JSON_ARRAY(), REPEAT('a',64));
INSERT INTO game_sessions (session_uuid, story_id, story_version_id, user_ref, role_id, model, prompt, generation_profile)
  VALUES ('00000000-0000-4000-8000-000000000003', 1, 1, 'u1', 'r', 'm', 'p', JSON_OBJECT('identifier','opening-default','rules_version','legacy-0001','locale','zh-CN','variant','default')),
         ('00000000-0000-4000-8000-000000000004', 1, 1, 'u2', 'r', 'm', 'p', JSON_OBJECT('identifier','opening-default','rules_version','legacy-0001','locale','zh-CN','variant','default'));
INSERT INTO session_events (event_id, session_id, event_seq, prev_event_seq, event_type, origin, source, source_sequence, payload, hash, occurred_at)
  VALUES ('00000000-0000-4000-8000-000000000005', (SELECT id FROM game_sessions WHERE session_uuid='00000000-0000-4000-8000-000000000003'), 1, NULL, 'player_input', 'user', 'player', 0, JSON_OBJECT('text','x'), REPEAT('b',64), UTC_TIMESTAMP(6)),
         ('00000000-0000-4000-8000-000000000006', (SELECT id FROM game_sessions WHERE session_uuid='00000000-0000-4000-8000-000000000004'), 1, NULL, 'player_input', 'user', 'player', 0, JSON_OBJECT('text','y'), REPEAT('c',64), UTC_TIMESTAMP(6));
SQL

# Request ids are opaque keys, not UUID-only. The public opening flow uses
# values longer than 36 characters; 0008 must persist them without truncation.
LONG_REQUEST_ID='opening-00000000-0000-4000-8000-000000000003-0'
mariadb --no-defaults "$DB" -e "
INSERT INTO session_events (event_id, session_id, event_seq, prev_event_seq, event_type, origin, source, source_sequence, payload, client_request_id, hash, occurred_at)
VALUES ('00000000-0000-4000-8000-00000000000e', $S1, 2, 1, 'story_opening', 'system', 'opening_cache', 1, JSON_OBJECT('text','long id'), '$LONG_REQUEST_ID', REPEAT('d',64), UTC_TIMESTAMP(6));" 2>/dev/null \
  && say "ok   probe: opaque client_request_id longer than 36 chars accepted" || fail "long client_request_id rejected"

WIDTH_OK=$(mariadb --no-defaults -N -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='session_events' AND column_name='client_request_id' AND data_type='varchar' AND character_maximum_length=255;")
[ "$WIDTH_OK" = "1" ] && say "ok   probe: client_request_id VARCHAR(255)" || fail "client_request_id width mismatch"

# Probe 1: source='' must be rejected by chk_pending_batches_source
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batches (batch_uuid, session_id, batch_type, status, request_uuid, source, request_payload, item_count, committed_count)
VALUES (UUID(), $S1, 'narrative_beat', 'queued', UUID(), '', JSON_OBJECT('x',1), 1, 0);" 2>&1)
echo "$OUT" | grep -q "chk_pending_batches_source" && say "ok   probe: source='' rejected" || fail "source='' not rejected: $OUT"

# Probe 2: committed_count > item_count must be rejected
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batches (batch_uuid, session_id, batch_type, status, request_uuid, source, request_payload, item_count, committed_count)
VALUES (UUID(), $S1, 'narrative_beat', 'queued', UUID(), 'runtime', JSON_OBJECT('x',1), 1, 2);" 2>&1)
echo "$OUT" | grep -q "chk_pending_batches_counts" && say "ok   probe: committed_count>item_count rejected" || fail "counts not rejected: $OUT"

# Probe 3: expected_revision default must be 0 (matches db/schema.sql)
DEFAULT_OK=$(mariadb --no-defaults -N -e "
SELECT COUNT(*) FROM information_schema.columns
WHERE table_schema='$DB' AND table_name='pending_batches' AND column_name='expected_revision' AND column_default='0' AND is_nullable='NO';")
[ "$DEFAULT_OK" = "1" ] && say "ok   probe: expected_revision NOT NULL DEFAULT 0" || fail "expected_revision default mismatch"

# Seed a batch on session 1 for item-level probes
mariadb --no-defaults "$DB" <<'SQL' 2>/dev/null
INSERT INTO pending_batches (batch_uuid, session_id, batch_type, status, request_uuid, source, request_payload, item_count, committed_count)
VALUES ('00000000-0000-4000-8000-000000000007', (SELECT id FROM game_sessions WHERE session_uuid='00000000-0000-4000-8000-000000000003'), 'narrative_beat', 'queued', '00000000-0000-4000-8000-000000000008', 'runtime', JSON_OBJECT('x',1), 1, 0);
SQL

# Probe 4: pending item must NOT carry promoted_event_id / occurred_at
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batch_items (batch_id, session_id, item_uuid, item_seq, item_type, status, payload, promoted_event_id, occurred_at)
VALUES (1, $S1, '00000000-0000-4000-8000-000000000009', 0, 'narrative_beat', 'pending', JSON_OBJECT('text','x'), '00000000-0000-4000-8000-000000000005', UTC_TIMESTAMP(6));" 2>&1)
echo "$OUT" | grep -q "chk_pending_batch_items_pending" && say "ok   probe: pending item with promoted_event rejected" || fail "pending+promoted_event not rejected: $OUT"

# Probe 5: cross-session promotion must be rejected (item on session 1, event on session 2)
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batch_items (batch_id, session_id, item_uuid, item_seq, item_type, status, payload, promoted_event_id, occurred_at)
VALUES (1, $S1, '00000000-0000-4000-8000-00000000000a', 0, 'narrative_beat', 'committed', JSON_OBJECT('text','x'), '00000000-0000-4000-8000-000000000006', UTC_TIMESTAMP(6));" 2>&1)
echo "$OUT" | grep -qE "fk_pending_batch_items_promoted_event_session|constraint" && say "ok   probe: cross-session promotion rejected" || fail "cross-session promotion not rejected: $OUT"

# Probe 6: same-session promotion succeeds
mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batch_items (batch_id, session_id, item_uuid, item_seq, item_type, status, payload, promoted_event_id, occurred_at)
VALUES (1, $S1, '00000000-0000-4000-8000-00000000000b', 0, 'narrative_beat', 'committed', JSON_OBJECT('text','x'), '00000000-0000-4000-8000-000000000005', UTC_TIMESTAMP(6));" 2>/dev/null \
  && say "ok   probe: same-session promotion accepted" || fail "same-session promotion rejected"

# Probe 7: tool_call item can never be committed (valid same-session promoted
# event supplied so only chk_pending_batch_items_tool_commit can fire)
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batch_items (batch_id, session_id, item_uuid, item_seq, item_type, status, payload, promoted_event_id, occurred_at)
VALUES (1, $S1, '00000000-0000-4000-8000-00000000000c', 0, 'tool_call', 'committed', JSON_OBJECT('name','ask_player_choice'), '00000000-0000-4000-8000-000000000005', UTC_TIMESTAMP(6));" 2>&1)
echo "$OUT" | grep -q "chk_pending_batch_items_tool_commit" && say "ok   probe: tool_call committed rejected" || fail "tool_call committed not rejected: $OUT"

# Probe 8: item's session_id must match its batch's session (composite FK)
OUT=$(mariadb --no-defaults "$DB" -e "
INSERT INTO pending_batch_items (batch_id, session_id, item_uuid, item_seq, item_type, status, payload)
VALUES (1, $S2, '00000000-0000-4000-8000-00000000000d', 1, 'narrative_beat', 'pending', JSON_OBJECT('text','x'));" 2>&1)
echo "$OUT" | grep -qE "fk_pending_batch_items_session_batch|constraint" && say "ok   probe: item session/batch mismatch rejected" || fail "item session/batch mismatch not rejected: $OUT"

mariadb --no-defaults -e "DROP DATABASE \`$DB\`;"
if [ "$FAIL" = "0" ]; then
  say "all MariaDB scratch probes passed"
else
  say "MariaDB scratch probes FAILED"
  exit 1
fi
