# AI narrative generation

Public `/api/sessions/:uuid/generate` uses an OpenAI-compatible chat completion service when `STORY_OUTSIDE_AI_PROVIDER=real`. If unset, real story mode (`STORY_OUTSIDE_PROVIDER=real`) selects real AI; mock story mode retains deterministic test responses. Admin/dev generation remains mock.

Server configuration is resolved from environment first, then the ignored `secrets/secret` file:

| Environment | Secret file label |
| --- | --- |
| `STORY_OUTSIDE_AI_API_KEY` | `AI API Key` |
| `STORY_OUTSIDE_AI_BASE_URL` | `AI OpenAI Base URL` |
| `STORY_OUTSIDE_AI_MODEL` | `AI Model` |

`STORY_OUTSIDE_AI_SECRET_FILE` optionally selects another server-side file. No credential is sent to the browser. HTTPS is required except for localhost development. Startup validates real-mode configuration. `STORY_OUTSIDE_AI_TIMEOUT_MS` defaults to 90000; `STORY_OUTSIDE_AI_CONTEXT_CHARS` defaults to 180000.

The session pins the configured model on bootstrap. Generation includes the entire versioned original story payload, the player's selected role, committed events, and current input. The model returns structured JSON containing 1–4 narrative items and optionally one final `ask_player_choice` or `finish_story` tool envelope. Existing runtime validation, pending staging, explicit commit, interrupt/discard and request-id replay remain authoritative. Failed or malformed upstream responses return failure, never fabricated narrative.

When original plus committed history exceeds the character threshold and history has more than 16 events, the older committed prefix is summarized through a separate AI request. The full original and most recent 16 events remain verbatim. Summaries are persisted under the server-only AI cache directory, keyed by model, original story and session. Committed-prefix hashes prevent stale summaries from being reused. Later turns reuse the summary until at least 16 more events are available to fold. Canonical history is never deleted or mutated. Extremely large originals may exceed the configured model's upstream context limit and fail explicitly.

Run offline regression tests with `STORY_OUTSIDE_AI_PROVIDER=mock` to prevent paid requests. `node tests/aiProvider.test.mjs` uses a fake transport and covers configuration, full-original preservation, compaction, choice validation and upstream errors. Live acceptance verified the configured DeepSeek model with one adapter request and one public HTTP generate request; replaying the same HTTP request returned the existing turn without another generation.


Real story detail requests prepare playable characters and a short work-level opening through AI. The same content/model/version-keyed result is reused by detail and session bootstrap. Concurrent cache misses share one request, and successful results persist under `secrets/ai-cache/` (override with `STORY_OUTSIDE_AI_CACHE_DIR`). The original `beats` remain complete; `ai_opening_events` is a separately versioned canonical field and ends with an excluded first-choice marker. The opening generator plays only the short prepared scene. `default_role_id` selects an actual first-person character when present; `role_selection_required` asks the player to choose when multiple non-first-person characters exist.

The HTTP transport forbids redirects and embedded URL credentials, limits JSON responses to 2 MB, and never includes upstream response bodies in errors.
