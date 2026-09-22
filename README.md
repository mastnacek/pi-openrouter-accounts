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

Pi stores exactly **one credential per provider id** (`~/.pi/agent/auth.json` is `Record<providerId, Credential>`), and the `/model` picker badge is the **provider id**. There is no built-in multi-account support and no official plugin for it, so the only way to get two OpenRouter accounts *simultaneously usable and visible* is to register each as a distinct provider id.

Aliases reuse the **built-in OpenRouter catalog**, so no model list is hand-maintained.

## Install

```bash
pi install git:github.com/mastnacek/pi-openrouter-accounts
```

On the first session after install the plugin **creates its own config file** (`~/.pi/agent/openrouter-accounts.json`). If you already have a built-in OpenRouter credential in `auth.json` (or `OPENROUTER_API_KEY` set), it is imported automatically as account **`default`** — so you get a working labeled alias without writing any JSON.

## Manage

Everything is done from `/openrouter-accounts`; no manual editing required.

| Command | What it does |
| --- | --- |
| `/openrouter-accounts add` | Wizard: account id, display name, API key source, data policy, model scope |
| `/openrouter-accounts edit <id>` | Same wizard, prefilled |
| `/openrouter-accounts key <id>` | Replace the API key (auth.json, env var or shell command) |
| `/openrouter-accounts rename <id>` | Change the display name |
| `/openrouter-accounts remove <id>` | Delete the account and its stored key |
| `/openrouter-accounts list` | List accounts with provider ids and flags |
| `/openrouter-accounts import` | Import the built-in `openrouter` credential as account `default` |
| `/openrouter-accounts status` | Configured vs actually registered providers |
| `/openrouter-accounts refresh` | Re-register providers after external edits |
| `/openrouter-accounts help` | Command + config reference |

Every subcommand and account id is tab-completable.

### Key storage

By default the wizard stores the API key as a real Pi credential under the alias provider id in `~/.pi/agent/auth.json` (mode `0600`) — the same store `/login` uses, and it takes precedence over any configured fallback. Alternatively pick an **environment variable** or a **shell command** (`op read ...`), which are written into the config file instead.

## Config file (optional, for advanced cases)

The manager writes this for you; edit it directly only if you prefer.

`~/.pi/agent/openrouter-accounts.json` (or `.pi/openrouter-accounts.json` for a project, or `$PI_OPENROUTER_ACCOUNTS`):

```json
{
  "accounts": [
    {
      "id": "work",
      "label": "OpenRouter (Work)",
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
      "apiKey": "!op read op://AI/OpenRouter/api-key",
      "onlyFree": true
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | slug; provider id becomes `openrouter-<id>` |
| `label` | display name used by the footer and error messages |
| `apiKey` | optional key source: `$ENV_VAR`, `${ENV_VAR}`, `!command`, or literal. Omit to use the credential in `auth.json` |
| `dataCollection` | `"deny"` / `"allow"` → OpenRouter `provider.data_collection` |
| `zdr` | force zero-data-retention upstream endpoints |
| `onlyFree` | restrict the alias to `*:free` models + `openrouter/free` |
| `api` | force one API type for every model (rare) |

If `apiKey` is omitted and no stored credential exists, the fallback is `$OPENROUTER_<ID>_API_KEY`.

## Use

- **Model picker / CLI**: `openrouter-work/anthropic/claude-fable-5:high`
- **Subagents (pi-subagents)**: give each agent its own account, e.g. a work reviewer on `openrouter-work/...` and a free scout on `openrouter-personal/...:free`.
- Providers are registered on `session_start` (the alias needs the live catalog), so they appear once a session starts, not in `pi --list-models` before that.

## Caveats

- `data_collection` / `zdr` routing is injected for `openai-completions` models only; Pi's `anthropic-messages` compat schema has no `openRouterRouting`, so those 15 OpenRouter models rely on the account-level OpenRouter privacy setting.
- Renaming an account changes its provider id, so sessions and agents pinned to the old id need updating.
- API keys pasted through the wizard are typed in a plain (visible) input; prefer the env-var or `!command` source if that matters.

## Related packages

| Package | What it does | Fits this use case? |
| --- | --- | --- |
| `@hieplp/pi-account-switcher` | multi API keys per provider, per-session/dir switching, `/accounts:subagent` | switches one provider; account not in the model badge |
| `@narumitw/pi-accounts` | named **OAuth** accounts for built-in providers | OAuth-only, no manual API-key profiles |
| `@robhowley/pi-openrouter` | OpenRouter spend/usage overlays, key management, free-only sync | single account visibility |
| `pi-openrouter-realtime` | live model sync, endpoint health, credit balance | single credential |

## License

MIT