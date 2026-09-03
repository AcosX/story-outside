// src/observability/cacheStats.mjs — opening_cache hit/miss tracking.
//
// ClickUp 14 contract:
//   * Fixed test stories (cafe-rain, night-shift) replay from the cache.
//     Every cache hit MUST show up in metrics so "the demo does not make
//     real-time model calls" is provable from the admin endpoint.
//   * Counts are kept both per-session and globally. The admin endpoint
//     exposes a per-cache summary (uuid → hits) and the global aggregate.
//   * The store lives in memory and is wiped by process restart — see
//     docs/observability.md for the production-bridge story.
//   * This module is intentionally tiny: it only tracks opening_cache.
//     Other caches (prompt-template cache, LLM response cache) belong to
//     their own modules.

import { recordOpeningCacheHit, recordOpeningCacheMiss } from './metrics.mjs';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** @type {Map<string, CacheAggregate>} */
const cacheAggregates = new Map();

// The cache_uuid key is externally controllable (the admin rebuild
// endpoint mints one aggregate per generated cache), so the store must
// stay bounded like metrics.sessionMetrics. When the cap is reached the
// oldest-inserted aggregate is evicted; global hit/miss totals are NOT
// rolled back, so the demo-path "hits > 0" acceptance proof survives
// eviction of individual per-cache aggregates.
export const MAX_CACHE_AGGREGATES = 500;

const globalTotals = { hits: 0, misses: 0, lastHitAt: null, lastMissAt: null };

function newAggregate(cache_uuid, story_uuid, story_version_uuid, generation_hash) {
  return {
    cache_uuid,
    story_uuid,
    story_version_uuid,
    generation_hash,
    hits: 0,
    misses: 0,
    firstHitAt: null,
    lastHitAt: null,
  };
}

// ---------------------------------------------------------------------------
// Public mutators
// ---------------------------------------------------------------------------

/**
 * Record that a session served its opening from `cache_uuid` instead of
 * triggering a realtime provider call. Safe to call from any hook.
 *
 * @param {{
 *   session_uuid: string,
 *   cache_uuid: string,
 *   story_uuid?: string,
 *   story_version_uuid?: string,
 *   generation_hash?: string,
 * }} input
 */
export function recordHit(input) {
  if (!input || typeof input !== 'object') return;
  const cache_uuid = typeof input.cache_uuid === 'string' && input.cache_uuid
    ? input.cache_uuid
    : null;
  const session_uuid = typeof input.session_uuid === 'string' && input.session_uuid
    ? input.session_uuid
    : null;
  if (!cache_uuid || !session_uuid) return;
  let aggregate = cacheAggregates.get(cache_uuid);
  if (!aggregate) {
    if (cacheAggregates.size >= MAX_CACHE_AGGREGATES) {
      // Insertion-order eviction: drop the oldest aggregate. Global
      // totals are deliberately left untouched (no rollback).
      const oldestKey = cacheAggregates.keys().next().value;
      if (oldestKey !== undefined) cacheAggregates.delete(oldestKey);
    }
    aggregate = newAggregate(
      cache_uuid,
      typeof input.story_uuid === 'string' ? input.story_uuid : null,
      typeof input.story_version_uuid === 'string' ? input.story_version_uuid : null,
      typeof input.generation_hash === 'string' ? input.generation_hash : null,
    );
    cacheAggregates.set(cache_uuid, aggregate);
  }
  aggregate.hits += 1;
  const now = new Date().toISOString();
  if (!aggregate.firstHitAt) aggregate.firstHitAt = now;
  aggregate.lastHitAt = now;
  globalTotals.hits += 1;
  globalTotals.lastHitAt = now;
  recordOpeningCacheHit({ session_uuid });
}

/**
 * Record that a session FELL BACK to realtime. A miss counter is
 * meaningful only as a sanity check: in steady state the demo paths
 * should produce zero misses.
 */
export function recordMiss(input) {
  const session_uuid = input && typeof input.session_uuid === 'string' ? input.session_uuid : null;
  globalTotals.misses += 1;
  globalTotals.lastMissAt = new Date().toISOString();
  recordOpeningCacheMiss();
  return session_uuid;
}

// ---------------------------------------------------------------------------
// Snapshots (read-only)
// ---------------------------------------------------------------------------

export function snapshotAll() {
  const caches = {};
  for (const [uuid, aggregate] of cacheAggregates.entries()) {
    caches[uuid] = JSON.parse(JSON.stringify(aggregate));
  }
  return {
    global: { ...globalTotals },
    caches,
  };
}

export function snapshotCache(cache_uuid) {
  const aggregate = cacheAggregates.get(cache_uuid);
  return aggregate ? JSON.parse(JSON.stringify(aggregate)) : null;
}

/** Test-only reset. */
export function _resetCacheStatsForTests() {
  cacheAggregates.clear();
  globalTotals.hits = 0;
  globalTotals.misses = 0;
  globalTotals.lastHitAt = null;
  globalTotals.lastMissAt = null;
}
