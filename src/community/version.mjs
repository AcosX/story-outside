// src/community/version.mjs — community-layer PUBLIC helper for the
// EXTERNAL `community_profile_version` string used on the wire
// contract (Story 16.4 P1.v1-6, 2026-09-07).
//
// Hard contract (P1.v1-6):
//   * This module is the SINGLE place that knows the external-version
//     wire format. Other modules (hot.mjs, server.mjs, tests) MUST
//     import `deriveExternalCommunityProfileVersion` from here, NOT
//     re-implement the format locally.
//   * The wire format is:
//         `${generator_version}@${profile.hash.content_hash.slice(0, EXTERNAL_HASH_LENGTH)}`
//     where EXTERNAL_HASH_LENGTH = 16 hex chars (~64 bits of entropy).
//     The `@` separator distinguishes the external identity from the
//     internal `generator_version` string AND prevents accidental
//     confusion with v1-3-era records that used `-` + 12 hex chars.
//   * The helper reads `profile.hash.content_hash` AS-IS. It does NOT
//     recompute the hash; the canonical hash is owned by
//     `src/community/profile.mjs` (buildCommunityProfileFromSeed stamps
//     it during fixture/seeding) and re-exposed by
//     `buildCanonicalCommunityProfileVersion` from
//     `src/community/repository.mjs`. The previous v1-5 implementation
//     re-hashed content via the in-module content-hash function
//     (since deleted), which code review
//     review (2026-09-07 09:19) flagged as a second source of truth:
//     the seeded cafe-rain row then yielded
//     `1.0.0@e2faabf0b55c9794` instead of the main-canonical
//     `1.0.0@f134b0e086e021ce`. v1-6 deletes the rehash and routes the
//     helper through the canonical hash that main ships.
//   * Same `story_version_uuid` + same `generator_version` + same
//     canonical content_hash → same external version (idempotent).
//   * Different `generator_version` (ruleset bump) → different external
//     version (existing v1-2 mismatch path keeps firing).
//   * Different `story_version_uuid` (story version bump) → the
//     canonical hash already incorporates the new `story_uuid` /
//     `story_version_uuid` / `story_version_checksum`, so the
//     external version naturally diverges (P1.v1-5 cross-story
//     collision fix is preserved end-to-end).
//
// This module does NOT read env vars that look like credentials and
// does NOT call any external API.

import { buildCanonicalCommunityProfileVersion } from './repository.mjs';

/**
 * Length of the short content-hash suffix used in the EXTERNAL
 * `community_profile_version` derivation. 16 hex chars ≈ 64 bits of
 * entropy — enough to make accidental collisions in a single
 * regeneration burst effectively impossible, short enough that the
 * external version string stays human-greppable in test logs.
 */
export const EXTERNAL_HASH_LENGTH = 16;

/**
 * Derive the EXTERNAL `community_profile_version` string used on
 * the wire contract from a canonical profile row.
 *
 * This is a thin pass-through to main's canonical helper
 * (`buildCanonicalCommunityProfileVersion`) so the v1-5 external API
 * keeps working without a rehash. The helper:
 *   * requires `profile.hash.content_hash` to be present (the row
 *     must have been minted through `buildCommunityProfileFromSeed`
 *     or `buildStubCommunityProfile`, both of which stamp the hash);
 *   * returns `${generator_version}@${hash.content_hash.slice(0, 16)}`;
 *   * returns `null` when the canonical hash is missing (the
 *     repository helper's contract) — callers MUST handle the
 *     `null` case explicitly (the previous v1-5 implementation
 *     threw a generic `Error`; v1-6 keeps the soft-fail so a
 *     partially-shaped row still gets a usable identity fallback
 *     inside the hot orchestrator).
 *
 * @param {object} profile
 * @returns {string|null}
 */
export function deriveExternalCommunityProfileVersion(profile) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  // Read directly from the row (per P1.v1-6). Pass-through to the
  // canonical helper so the format / length / null-handling stay
  // owned by one module (`repository.mjs`).
  const canonical = buildCanonicalCommunityProfileVersion(profile);
  if (canonical) return canonical;
  // Defensive fallback: if the canonical helper returned `null`
  // (e.g. a partially-shaped row missing `hash.content_hash`),
  // surface the bare `generator_version` so the route layer can
  // still emit SOMETHING rather than crashing. This matches the
  // v1-5 fallback `typeof profile.generator_version === 'string'
  // && profile.generator_version ? profile.generator_version : ''`
  // semantically.
  if (typeof profile.generator_version === 'string' && profile.generator_version) {
    return profile.generator_version;
  }
  return null;
}