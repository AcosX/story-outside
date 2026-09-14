#!/usr/bin/env bash
# /usr/local/sbin/lmdo-story-outside-vm3-deploy
#
# Story Outside — VM3 deployment daemon (GitHub main auto-deploy).
# Classed after lmdo-website-vm3-deploy; story-outside has zero npm
# dependencies so the deployer skips the docker compose path and just
# updates a frozen git worktree and restarts the systemd unit.
#
# Flow:
#   1. Snapshot MariaDB (`/var/lib/lmdo-story-outside-vm3-deploy/db-<ts>.sql`)
#   2. fetch origin main
#   3. reset frozen install to origin/main
#   4. npm run check (syntax / contract)
#   5. systemctl restart story-outside-vm3
#   6. healthcheck (10 attempts × 3s)
#   7. update current_sha / previous_sha marker
#   8. on failure, leave service running on the previous SHA and exit 1
#
# State directory: /var/lib/lmdo-story-outside-vm3-deploy/
#
# 2026-09-03 — bootstrapped by main session for ClickUp 15 deployment.

set -u
set -o pipefail

ENV_FILE="${STORY_OUTSIDE_ENV_FILE:-/root/.config/story-outside-vm3.env}"
INSTALL_DIR="${STORY_OUTSIDE_INSTALL_DIR:-/srv/lmdo/story-outside-vm3-live}"
GIT_REMOTE="${STORY_OUTSIDE_GIT_REMOTE:-origin}"
GIT_BRANCH="${STORY_OUTSIDE_GIT_BRANCH:-main}"
SERVICE_UNIT="story-outside-vm3.service"
HEALTHCHECK="/usr/local/bin/story-outside-healthcheck.sh"
STATE_DIR="/var/lib/lmdo-story-outside-vm3-deploy"
MARKER_CURRENT="${STATE_DIR}/current_sha"
MARKER_PREVIOUS="${STATE_DIR}/previous_sha"
LOCK_FILE="${STATE_DIR}/deploy.lock"
DB_NAME="story_outside"
DB_USER="story_outside_app"

mkdir -p "${STATE_DIR}"
chmod 0755 "${STATE_DIR}"

# Acquire exclusive lock; bail if another run is in flight
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "another deploy is in progress; aborting"
  exit 0
fi

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

# Load DB password for snapshot
if [ -r "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
fi
DB_PASS="${STORY_OUTSIDE_DB_PASSWORD:-}"
[ -n "${DB_PASS}" ] || fail "STORY_OUTSIDE_DB_PASSWORD not set in ${ENV_FILE}"

[ -d "${INSTALL_DIR}" ] || fail "install dir ${INSTALL_DIR} not found"

cd "${INSTALL_DIR}" || fail "cannot cd to ${INSTALL_DIR}"

CURRENT_SHA=$(git rev-parse --verify "${GIT_BRANCH}" 2>/dev/null || true)

PREVIOUS_SHA=""
if [ -r "${MARKER_CURRENT}" ]; then
  PREVIOUS_SHA=$(cat "${MARKER_CURRENT}" 2>/dev/null || true)
fi

# Refresh the remote-tracking ref BEFORE deciding whether there is work.
# Previously the script compared a potentially stale origin/main and exited
# before reaching git fetch, which could suppress deployments indefinitely.
if ! git fetch --quiet "${GIT_REMOTE}" "${GIT_BRANCH}"; then
  fail "git fetch ${GIT_REMOTE} ${GIT_BRANCH} failed"
fi
TARGET_SHA=$(git rev-parse --verify "${GIT_REMOTE}/${GIT_BRANCH}" 2>/dev/null || true)
[ -n "${TARGET_SHA}" ] || fail "cannot resolve ${GIT_REMOTE}/${GIT_BRANCH}"

if [ "${TARGET_SHA}" = "${CURRENT_SHA}" ] && [ "${TARGET_SHA}" = "${PREVIOUS_SHA}" ]; then
  log "no new commits on ${GIT_REMOTE}/${GIT_BRANCH}; current_sha=${CURRENT_SHA}"
  exit 0
fi

log "deploying ${GIT_REMOTE}/${GIT_BRANCH}: ${PREVIOUS_SHA:-<none>} → ${TARGET_SHA}"

# 1. snapshot DB
SNAPSHOT="${STATE_DIR}/db-$(date -u +%Y%m%dT%H%M%SZ).sql"
if mysqldump -u"${DB_USER}" -h127.0.0.1 -p"${DB_PASS}" \
    --single-transaction --quick --triggers --routines --events \
    "${DB_NAME}" > "${SNAPSHOT}" 2>>"${STATE_DIR}/deploy.log"; then
  log "db snapshot: ${SNAPSHOT}"
  chmod 0600 "${SNAPSHOT}"
  # keep only the latest 10 snapshots
  ls -1t "${STATE_DIR}"/db-*.sql 2>/dev/null | tail -n +11 | xargs -r rm -f
else
  fail "mysqldump failed; see ${STATE_DIR}/deploy.log"
fi

# 2. remote ref was already fetched before the no-op decision above.

# 3. reset to target
if ! git reset --hard "${TARGET_SHA}" >/dev/null 2>&1; then
  fail "git reset --hard ${TARGET_SHA} failed"
fi

# 4. syntax check
if ! npm run check >"${STATE_DIR}/check.log" 2>&1; then
  log "check failed; rolling back to ${PREVIOUS_SHA:-<none>}"
  git reset --hard "${PREVIOUS_SHA:-${CURRENT_SHA}}" >/dev/null 2>&1 || true
  fail "npm run check failed; see ${STATE_DIR}/check.log"
fi

# Stop the new writer and expand its replay encoding before old code starts.
rollback_runtime() {
  systemctl stop "${SERVICE_UNIT}" || return 1
  if [ -f scripts/expand-runtime-replay.mjs ]; then
    ( set -a; . "${ENV_FILE}"; set +a; node scripts/expand-runtime-replay.mjs --apply ) || return 1
  fi
  git reset --hard "${PREVIOUS_SHA:-${CURRENT_SHA}}" >/dev/null 2>&1 || return 1
  systemctl start "${SERVICE_UNIT}" || return 1
}

# 5. restart service
if ! systemctl restart "${SERVICE_UNIT}"; then
  log "systemctl restart failed; rolling back"
  rollback_runtime || fail "rollback failed; writer stopped, operator recovery required"
  fail "systemctl restart ${SERVICE_UNIT} failed"
fi

# 6. healthcheck (10 × 3s)
ok=1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if STORY_OUTSIDE_HEALTHCHECK_VERBOSE=0 "${HEALTHCHECK}" >/dev/null 2>&1; then
    ok=0
    break
  fi
  sleep 3
done
if [ "${ok}" != "0" ]; then
  log "healthcheck failed after restart; rolling back"
  rollback_runtime || fail "rollback failed; writer stopped, operator recovery required"
  fail "post-deploy healthcheck never went green"
fi

# 7. update markers
printf '%s\n' "${PREVIOUS_SHA:-${CURRENT_SHA}}" > "${MARKER_PREVIOUS}"
printf '%s\n' "${TARGET_SHA}" > "${MARKER_CURRENT}"
chmod 0644 "${MARKER_CURRENT}" "${MARKER_PREVIOUS}"

log "deploy success: ${PREVIOUS_SHA:-<none>} → ${TARGET_SHA}"
log "health: $(STORY_OUTSIDE_HEALTHCHECK_VERBOSE=0 ${HEALTHCHECK} >/dev/null 2>&1 && echo OK || echo DEGRADED)"

# 8. last_success_utc
date -u +%Y-%m-%dT%H:%M:%SZ > "${STATE_DIR}/last_success_utc"
exit 0

