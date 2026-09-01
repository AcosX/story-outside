# Agent Tools

`ask_player_choice` and `finish_story` are the only tool contracts exposed by the agent runtime.

- `ask_player_choice` requires `question` and `options`.
- `options` must contain 2 to 6 items.
- Each option needs a non-empty `id` and a non-empty `label`; `text` is accepted as a label fallback.
- `allow_free_text` defaults to `true`.
- `choice_id` is optional and, when present, must be a non-empty string.
- Unknown fields, sensitive keys, NaN/Infinity, and non-JSON input are rejected.

- `finish_story` requires `summary`, `ending`, `original_difference`, `key_choices`, and `character_outcomes`.
- `key_choices` must contain 1 to 20 non-empty strings.
- `character_outcomes` must contain 1 to 20 objects with non-empty `character` and `fate`; `change` is optional.
- `ending_key` is optional.
- Unknown fields, sensitive keys, and non-JSON input are rejected.

`executeToolCall` only validates and normalizes. It returns a tool envelope and does not persist session state, write history, or call any provider.
