// src/community/version.mjs — community-layer PUBLIC helper for the
// EXTERNAL `community_profile_version` string used on the wire
// contract (ClickUp 16.4 P1.v1-4, 2026-09-07).
//
// Hard contract:
//   * This module is the SINGLE place that knows the external-version
//     wire format. Other modules (hot.mjs, server.mjs, tests) MUST
//     import `deriveExternalCommunityProfileVersion` from here, NOT
//     re-implement the format locally.
//   * The internal `generator_version` field on the profile row is
//     preserved (v1 schema, 13 top-level keys). Only the EXTERNAL
//     identity string used on the HTTP boundary is content-aware.
//   * The wire format is:
//         `${generator_version}@${content_hash.slice(0, EXTERNAL_HASH_LENGTH)}`
//     where EXTERNAL_HASH_LENGTH = 16 hex chars (~64 bits of entropy).
//     The `@` separator distinguishes the external identity from the
//     internal `generator_version` string AND prevents accidental
//     confusion with v1-3-era records that used `-` + 12 hex chars.
//   * The hash is computed via `computeProfileContentHash`, which is
//     content-only (excludes `generator_version`, `generated_at`,
//     `profile_uuid`, `hash`, `story_uuid`, `story_version_uuid`,
//     `story_version_checksum`).
//   * Two profiles with the SAME `generator_version` but DIFFERENT
//     content (regenerated hot_keywords / topics) yield DIFFERENT
//     external versions, so a stale caller is rejected with 400
//     `community_profile_version_mismatch` instead of silently
//     observing stale relevance projections.
//
// This module does NOT read env vars that look like credentials and
// does NOT call any external API.

import { canonicalSha256 } from '../stories/canonicalHash.mjs';

/**
 * Length of the short content-hash suffix used in the EXTERNAL
 * `community_profile_version` derivation. 16 hex chars ≈ 64 bits of
 * entropy — enough to make accidental collisions in a single
 * regeneration burst effectively impossible, short enough that the
 * external version string stays human-greppable in test logs.
 */
export const EXTERNAL_HASH_LENGTH = 16;

/**
 * Compute a deterministic, content-only SHA-256 over the
 * user-editable fields of a community profile. The hash intentionally
 * EXCLUDES `generator_version`, `generated_at`, `profile_uuid`,
 * `hash`, `story_uuid`, `story_version_uuid`, and
 * `story_version_checksum` so two regenerations of the SAME content
 * (same topics / queries / knowledge queries / hot_keywords) yield
 * the same hash even if the import path minted a fresh profile_uuid
 * or bumped the timestamp. This is the "did the content actually
 * change" check that lets the matcher distinguish two profile
 * generations with identical ruleset versions.
 *
 * @param {object} profile
 * @returns {string}  64-char hex SHA-256.
 */
export function computeProfileContentHash(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('communityVersion.computeProfileContentHash: profile required');
  }
  const payload = {
    topics: Array.isArray(profile.topics) ? profile.topics : [],
    queries: Array.isArray(profile.queries) ? profile.queries : [],
    knowledge_queries: Array.isArray(profile.knowledge_queries) ? profile.knowledge_queries : [],
    hot_keywords: Array.isArray(profile.hot_keywords) ? profile.hot_keywords : [],
  };
  return canonicalSha256(payload);
}

/**
 * Derive the EXTERNAL `community_profile_version` string used on
 * the wire contract from a canonical profile row.
 *
 * Wire format (P1.v1-4, 2026-09-07):
 *
 *     `${generator_version}@${content_hash.slice(0, 16)}`
 *
 * Same `generator_version` + same content → same external version
 *   (deterministic, idempotent across regenerations).
 * Same `generator_version` + different content → different external
 *   version (two-generation regression catches the mismatch).
 * Different `generator_version` (ruleset bump) → different external
 *   version (existing v1-2 mismatch path keeps firing).
 *
 * The internal `generator_version` field on the profile row is
 * preserved as-is (v1 schema, 13 top-level keys, NOT renamed). Only
 * the EXTERNAL identity string is content-aware.
 *
 * @param {object} profile
 * @returns {string}
 */
export function deriveExternalCommunityProfileVersion(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('communityVersion.deriveExternalCommunityProfileVersion: profile required');
  }
  const generatorVersion = typeof profile.generator_version === 'string' && profile.generator_version
    ? profile.generator_version
    : '';
  if (!generatorVersion) {
    throw new Error('communityVersion.deriveExternalCommunityProfileVersion: profile.generator_version required');
  }
  const contentHash = computeProfileContentHash(profile);
  const shortHash = contentHash.slice(0, EXTERNAL_HASH_LENGTH);
  return `${generatorVersion}@${shortHash}`;
}