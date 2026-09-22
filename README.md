# pi-openrouter-accounts

Run **several OpenRouter accounts side by side** in Pi — work account, personal account, free-tier account — each as its own Pi provider, so the account is visible in the model picker.

```text
/model
  deepseek/deepseek-v4.1-flash   [openrouter-work]
  anthropic/claude-fable-5       [openrouter-work]
  cohere/north-mini-code:free    [openrouter-personal]
  openrouter/free                [openrouter-personal]
```

## Why this exists

Pi stores exactly **one credential per provider id** (`~/.pi/agent/auth.json` is `Record<providerId, Credential>`), and the `/model` picker badge is the **provider id**. There is no built-in multi-account support and no official plugin for it (the closest catalog packages, `@narumitw/pi-accounts` and `@hieplp/pi-account-switcher`, either handle OAuth-only accounts or switch a single provider's key without showing the account in the model list).

So the only way to get two OpenRouter accounts *simultaneously usable and visible* is to register each as a distinct provider id:

| Provider id | Account | Route policy |
| --- | --- | --- |
| `openrouter-work` | work key | `data_collection: deny`, `zdr: true` |
| `openrouter-personal` | personal key | default (free models allowed) |

Each alias reuses the **built-in OpenRouter catalog** (366 models), so nothing is hand-maintained.

## Install

```bash
pi install /path/to/pi-openrouter-accounts
# or try without installing:
pi -e /path/to/pi-openrouter-accounts
```

## Configure

Create `~/.pi/agent/openrouter-accounts.json` (or `.pi/openrouter-accounts.json` for a project, or point `$PI_OPENROUTER_ACCOUNTS` at a file):

```json
{
  "accounts": [
    {
      "id": "work",
      "label": "OpenRouter (Work)",
      "apiKey": "$OPENROUTER_WORK_KEY",
      "dataCollection": "deny",
      "zdr": true
    },
    {
      "id": "personal",
      "label": "OpenRouter (Personal)",
      "apiKey": "$OPENROUTER_PERSONAL_KEY"
    },
    {
      "id": "free",
      "label": "OpenRouter (Free only)",
      "apiKey": "$OPENROUTER_PERSONAL_KEY",
      "onlyFree": true
    }
  ]
}
```

Set the keys in the environment (or use literals / `!command`, same syntax as `models.json`):

```bash
export OPENROUTER_WORK_KEY=sk-or-v1-...
export OPENROUTER_PERSONAL_KEY=sk-or-v1-...
```

If `apiKey` is omitted, the default is `$OPENROUTER_<ID>_API_KEY`.

### Fields

| Field | Meaning |
| --- | --- |
| `id` | slug; provider id becomes `openrouter-<id>` |
| `label` | display name used by `/login`, footer, error messages |
| `apiKey` | `$ENV_VAR`, `${ENV_VAR}`, `!command`, or literal |
| `dataCollection` | `"deny"` / `"allow"` → OpenRouter `provider.data_collection` |
| `zdr` | force zero-data-retention upstream endpoints |
| `onlyFree` | restrict the alias to `*:free` models + `openrouter/free` |
| `api` | force one API type for every model (rare) |

## Use

- **Model picker / `--model`**: `openrouter-work/anthropic/claude-fable-5:high`
- **Subagents (pi-subagents)**: give each agent its own model, e.g. a `work-reviewer` agent on `openrouter-work/...` and a `free-scout` agent on `openrouter-personal/...:free`.
- **Commands**:
  - `/openrouter-accounts` — status (configured vs registered providers)
  - `/openrouter-accounts list` — list config entries
  - `/openrouter-accounts refresh` — re-register after editing config
  - `/openrouter-accounts help` — config reference

Provider registration happens on `session_start` (the extension needs the live catalog from the model registry), so aliases appear once a session starts, not in `pi --list-models` before that.

## Related packages

| Package | What it does | Fits this use case? |
| --- | --- | --- |
| `@hieplp/pi-account-switcher` | multi API keys per provider, per-session/dir switching, `/accounts:subagent` | switching, not side-by-side; account not in model badge |
| `@narumitw/pi-accounts` | named **OAuth** accounts for built-in providers | OAuth-only, no manual API-key profiles |
| `@robhowley/pi-openrouter` | OpenRouter spend/usage overlays, key management, free-only sync | single account visibility, no multi-account |
| `pi-openrouter-realtime` | live model sync, endpoint health, credit balance | single credential |

## License

MIT