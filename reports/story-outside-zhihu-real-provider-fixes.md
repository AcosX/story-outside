# Story-Outside-13 Real Provider — P1/P2 Fix Report

**Task:** address every P1 + P2 finding from `reports/story-outside-zhihu-real-provider-final-review.md`.
**Branch:** `feat/story-outside-13-zhihu-api`
**Base PR:** `8f32a03` → tip `1bd7f77` (7 fix commits ahead of base).
**PR:** https://github.com/AcosX/story-outside/pull/8 (`base=main`, `head=feat/story-outside-13-zhihu-api`, OPEN).

---

## 1. Verdict diff (before vs after)

| Severity | Before | After |
|----------|-------:|------:|
| P0 | 0      | 0     |
| P1 | 7      | 0     |
| P2 | 4      | 0     |

**All 7 P1 + all 4 P2 findings closed. No P0 / no regressions.**

---

## 2. Fix-by-fix table

| # | Finding | Severity | Commit | Files |
|---|---------|---------:|--------|-------|
| 1 | Host guard was a `startsWith` prefix → exact-match allow-list `isAllowedUpstreamBaseUrl` + per-hop `isAllowedUpstreamHost`; defeats prefix bypass (`api.zhihu.com.attacker.example`) and IDN homograph (`api.zhihu.cn`). | P1 | `cd5e628` | `src/providers/realProvider.mjs` |
| 2 | `redirect: 'follow'` silently followed to a non-allow-listed host → `redirect: 'manual'` + `followRedirect` re-pins host at every hop, caps hops at `MAX_REDIRECTS=3`, surfaces `Location`-missing + loop cases. | P1 | `423ee51` | `src/providers/realProvider.mjs` |
| 3 | `source.raw` triple-allocated (raw + DTO + `JSON.parse(JSON.stringify(cache))`) → `trimSourceRaw` drops body-sized fields, `capSourceText` bounds `source.content` / `source.introduction` at `MAX_SOURCE_TEXT_BYTES` (64 KiB), cache defensive copy is `shallowDefensiveCopy` (no JSON round-trip). | P1 | `af0bf11` | `src/providers/realProvider.mjs` |
| 4 | Real mode still served mock for `/api/chat`, `/api/admin/*`, and `/api/dev/sessions/.../generate` → `MOCK_ONLY_ROUTES` whitelist published on `demo.mock_only_routes` (18 routes). The official story content API has no chat / completion endpoint, so these stay demo-only. | P1 | `4c5bc9f` | `src/server.mjs` |
| 5 | `detailCache` (realProvider) + `sessionPinnedMetadata` + `demoTurnCounter` (server) were unbounded Maps → new `src/util/boundedMap.mjs` (zero deps, LRU). Caps: 256 / 1024 / 1024. | P1 | `bfc4506` | `src/util/boundedMap.mjs`, `src/providers/realProvider.mjs`, `src/server.mjs` |
| 6 | Manual `setTimeout(() => controller.abort(), …)` + `Content-Length` unenforced → `AbortSignal.timeout(timeoutMs)` (Node ≥ 17.3) combines timer + signal; `decodeJson` pre-checks `Content-Length` against `MAX_RESPONSE_BYTES=1MiB` and stream-accumulates with a hard byte cap. | P1 | `dd028d8` (AbortSignal) + folded into `423ee51` (size cap) | `src/providers/realProvider.mjs` |
| 7 | 7 untested review scenarios → 9 new test cases (one extra for redirect-loop): host-guard defensive table (16), 30x host-pinned hop (17), 30x to non-allow-listed host (17.1), >MAX_REDIRECTS (17.2), source.raw trim (18), cache LRU eviction (19), body-too-large (20), mock_only_routes whitelist (21), id mismatch / 404 not cached (22). | P1 | `1bd7f77` | `tests/realProvider.test.mjs` |

**P2 (4 findings) were carried inside the P1 commits** — IDN defense is part of #1, "no fetch when host untrusted" is part of #1 + #2, "no leak of upstream trace_id" was already covered, and the dual-path `abort` cleanup is part of #6.

---

## 3. Quality gates (every step)

### `npm run check` — 61 files syntax-checked, 0 failures.

Run after every fix; baseline (pre-fix) and post-fix outputs identical structure.

### `npm test` — full suite green

Final run (25 realProvider cases + all other suites):

```
all 7 agentRegression case(s) passed
all 25 realProvider case(s) passed
```

(plus health, providers, http, schema-contract, canonicalHash, cacheKey, openingGenerator, storyService, sessionService, sessionHttp, agentTools, agentRuntime, adminRoutes, storyOutside09, endingService, endingPage, observability, observabilityHttp, pendingLifecycle, storyOutside08, tokenEstimator, contextBuilder, agentCompact, providerAdapter, dbTransactions, failureScenarios, integrationFullChain — every suite green.)

### `git diff --check` — clean (exit 0).

---

## 4. Live smoke (single read-only run)

`STORY_OUTSIDE_PROVIDER=real PORT=4174 npm start` (process killed after smoke).

| # | Command | HTTP exit | Key first-fields |
|---|---------|----------:|------------------|
| 1 | `curl -s http://localhost:4174/api/health` | 200 | `provider="real"`, `demo.mode="live"`, `demo.official_zhihu_api=true`, `demo.contract="zhihu_hackathon_2026_p2"`, `demo.auth="none"`, `demo.mock_only_routes.length=18` |
| 2 | `curl -s http://localhost:4174/api/stories` | 200 | `stories.length=20`, `first.id="1747681485547843585"`, `first.title="近视眼勇闯恐怖游戏"`, `demo.mode="live"` |
| 3 | `curl -s "http://localhost:4174/api/stories/1747681485547843585"` | 200 | `roles[0].label="沈南因"` (real upstream author name, non-empty), `id="1747681485547843585"`, `source.attribution="zhihu_hackathon_2026_p2"`, `beats.length=1`, `beats[0].type="narration"`, `source.author_name="沈南因"` |

All three exit 0. No upstream body echoed into the report.

---

## 5. Push + PR

```
git push
→ 8f32a03..1bd7f77  feat/story-outside-13-zhihu-api -> feat/story-outside-13-zhihu-api
```

```
gh pr create --base main --head feat/story-outside-13-zhihu-api \
  --title "feat(story-outside-13): add real Zhihu story provider (P1+P2 fixed)" \
  --body "<see PR body>"
→ https://github.com/AcosX/story-outside/pull/8
```

`gh pr view 8 --json`:
```json
{ "baseRefName": "main",
  "headRefName": "feat/story-outside-13-zhihu-api",
  "number": 8,
  "state": "OPEN",
  "title": "feat(story-outside-13): add real Zhihu story provider (P1+P2 fixed)",
  "url": "https://github.com/AcosX/story-outside/pull/8" }
```

---

## 6. Hard-constraint compliance

* ✅ Zero new npm dependencies — every helper is a local module (`src/util/boundedMap.mjs`).
* ✅ Main working tree `/srv/lmdo/story-outside` untouched.
* ✅ No ClickUp API calls (parent `86eyt9pga` / child `86eyt9q5p` / comments `90180252411900` / `90180252413273` left to main session).
* ✅ No env / deployment / Safeline / ESA changes.
* ✅ No secrets echoed or logged (smoke captured only field names + counts, not upstream body content).
* ✅ Real provider still imports nothing from `vendor/zhihu-hackathon/**`; no credential env vars consumed.

---

## 7. Files changed (7 commits)

```
src/providers/realProvider.mjs         (P1-1, P1-2, P1-3, P1-6)
src/server.mjs                         (P1-4, P1-5)
src/util/boundedMap.mjs          (new) (P1-5)
tests/realProvider.test.mjs            (P1-7)
```

---

## 8. Sign-off

P1=0, P2=0. `npm run check` + `npm test` green. Live smoke green. PR #8 OPEN against `main`. Ready for review.