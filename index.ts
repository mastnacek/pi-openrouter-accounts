/**
 * pi-openrouter-accounts
 * -----------------------
 * Run several OpenRouter accounts side by side in Pi.
 *
 * Why: Pi stores exactly ONE credential per provider id (auth.json is
 * `Record<providerId, Credential>`), so two OpenRouter accounts cannot share
 * the built-in `openrouter` provider. The model picker badge is the provider
 * id (`model-id [provider]`), so the only way to make the account visible in
 * the list is to register each account as its own provider id:
 *
 *     openrouter-work      -> deepseek/deepseek-v4.1-flash [openrouter-work]
 *     openrouter-personal  -> cohere/north-mini-code:free  [openrouter-personal]
 *
 * Each alias reuses the built-in OpenRouter catalog (366 models), carries its
 * own API key, and can force an OpenRouter data-policy route per account
 * (`data_collection: "deny"`, `zdr: true`) for a locked-down work account.
 *
 * Config: ~/.pi/agent/openrouter-accounts.json  (or .pi/openrouter-accounts.json,
 * or $PI_OPENROUTER_ACCOUNTS pointing at a file)
 *
 *   {
 *     "accounts": [
 *       {
 *         "id": "work",
 *         "label": "OpenRouter (Work)",
 *         "apiKey": "$OPENROUTER_WORK_KEY",
 *         "dataCollection": "deny",
 *         "zdr": true
 *       },
 *       {
 *         "id": "personal",
 *         "label": "OpenRouter (Personal)",
 *         "apiKey": "$OPENROUTER_PERSONAL_KEY",
 *         "onlyFree": false
 *       }
 *     ]
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

const ACCOUNT_PROVIDER_PREFIX = "openrouter-";
const BASE_PROVIDER = "openrouter";
const BASE_URL = "https://openrouter.ai/api/v1";

interface AccountConfig {
	/** Short slug; the provider id becomes `openrouter-<id>`. */
	id: string;
	/** Display name for /login, footer and error messages. */
	label?: string;
	/** API key literal, `$ENV_VAR` / `${ENV_VAR}` interpolation, or `!command`. */
	apiKey?: string;
	/** OpenRouter account-level data policy: "deny" or "allow". */
	dataCollection?: "deny" | "allow";
	/** Force zero-data-retention endpoints for this account. */
	zdr?: boolean;
	/** Restrict the alias to free models (`:free` variants + `openrouter/free`). */
	onlyFree?: boolean;
	/** Override the API type for every model of this account. */
	api?: Api;
}

interface AccountsFile {
	accounts?: AccountConfig[];
}

/** Registered provider ids for this process; avoids churn on repeated session_start. */
const registered = new Set<string>();

function resolveConfigPath(cwd: string): string | undefined {
	const fromEnv = process.env.PI_OPENROUTER_ACCOUNTS?.trim();
	if (fromEnv) return fromEnv;
	const project = join(cwd, ".pi", "openrouter-accounts.json");
	if (existsSync(project)) return project;
	const global = join(homedir(), ".pi", "agent", "openrouter-accounts.json");
	if (existsSync(global)) return global;
	return undefined;
}

function loadAccounts(path: string | undefined): AccountConfig[] {
	if (!path) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as AccountsFile;
		if (!Array.isArray(data?.accounts)) return [];
		return data.accounts.filter(
			(a): a is AccountConfig => typeof a?.id === "string" && a.id.trim().length > 0,
		);
	} catch (error) {
		console.error(
			`pi-openrouter-accounts: failed to read ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return [];
	}
}

function providerIdFor(account: AccountConfig): string {
	const slug = account.id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return BASE_PROVIDER;
	return slug === BASE_PROVIDER ? BASE_PROVIDER : `${ACCOUNT_PROVIDER_PREFIX}${slug}`;
}

function defaultKeyRef(account: AccountConfig): string {
	const env = `OPENROUTER_${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
	return `$${env}`;
}

function isFreeModel(model: Model<Api>): boolean {
	return model.id.endsWith(":free") || model.id === "openrouter/free";
}

/** Copy a registry Model into the ProviderModelConfig shape accepted by registerProvider. */
function toProviderModel(model: Model<Api>, account: AccountConfig): ProviderModelConfig {
	const baseCompat = model.compat as Record<string, unknown> | undefined;
	let compat = model.compat as ProviderModelConfig["compat"];
	if (model.api === "openai-completions") {
		const routing: Record<string, unknown> = {
			...((baseCompat?.openRouterRouting as Record<string, unknown> | undefined) ?? {}),
		};
		if (account.dataCollection === "deny" || account.dataCollection === "allow") {
			routing.data_collection = account.dataCollection;
		}
		if (account.zdr) routing.zdr = true;
		compat = {
			...(baseCompat ?? {}),
			openRouterRouting: routing,
		} as ProviderModelConfig["compat"];
	}

	return {
		id: model.id,
		name: model.name,
		api: account.api ?? model.api,
		baseUrl: model.baseUrl || BASE_URL,
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		compat: compat as ProviderModelConfig["compat"],
	};
}

function registerAccounts(pi: ExtensionAPI, ctx: ExtensionContext, force = false): string[] {
	const path = resolveConfigPath(ctx.cwd);
	const accounts = loadAccounts(path);
	if (accounts.length === 0) return [];

	const catalog = ctx.modelRegistry.getAll().filter((m) => m.provider === BASE_PROVIDER);
	if (catalog.length === 0) return [];

	const summary: string[] = [];
	for (const account of accounts) {
		const providerId = providerIdFor(account);
		if (registered.has(providerId) && !force) {
			summary.push(`${providerId} (already registered)`);
			continue;
		}
		const models = (account.onlyFree ? catalog.filter(isFreeModel) : catalog).map((m) =>
			toProviderModel(m, account),
		);
		if (models.length === 0) {
			summary.push(`${providerId} (no models)`);
			continue;
		}
		try {
			pi.registerProvider(providerId, {
				name: account.label ?? providerId,
				baseUrl: BASE_URL,
				apiKey: account.apiKey ?? defaultKeyRef(account),
				models,
			});
			registered.add(providerId);
			summary.push(`${providerId} (${models.length} models)`);
		} catch (error) {
			summary.push(
				`${providerId} (failed: ${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
	return summary;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const summary = registerAccounts(pi, ctx);
		if (ctx.hasUI && summary.length > 0) {
			ctx.ui.setStatus("openrouter-accounts", summary.join(" · "));
		}
	});

	pi.on("session_shutdown", () => {
		for (const providerId of registered) {
			try {
				pi.unregisterProvider(providerId);
			} catch {
				/* best effort */
			}
		}
		registered.clear();
	});

	pi.registerCommand("openrouter-accounts", {
		description: "Manage OpenRouter account providers (openrouter-work, openrouter-personal, ...)",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show configured account providers" },
				{ value: "list", label: "list", description: "List OpenRouter accounts in config" },
				{ value: "refresh", label: "refresh", description: "Re-register account providers now" },
				{ value: "help", label: "help", description: "Show config reference" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
			const path = resolveConfigPath(ctx.cwd);
			const accounts = loadAccounts(path);

			if (sub === "refresh") {
				const summary = registerAccounts(pi, ctx, true);
				if (ctx.hasUI) ctx.ui.notify(`openrouter-accounts: ${summary.join(" · ") || "nothing to register"}`, "info");
				return;
			}

			if (sub === "list") {
				if (accounts.length === 0) {
					if (ctx.hasUI) ctx.ui.notify(`No config at ${path ?? "~/.pi/agent/openrouter-accounts.json"}`, "warning");
					return;
				}
				const lines = accounts.map((a) => `  ${providerIdFor(a)}  <-  ${a.label ?? a.id}`);
				if (ctx.hasUI) {
					ctx.ui.notify(
						[`# OpenRouter accounts (${path})`, ...lines].join("\n"),
						"info",
					);
				}
				return;
			}

			if (sub === "help") {
				const help = [
					"# /openrouter-accounts",
					"Register one Pi provider per OpenRouter account so the account shows in the model picker.",
					"",
					"Config: ~/.pi/agent/openrouter-accounts.json (or .pi/openrouter-accounts.json, or $PI_OPENROUTER_ACCOUNTS)",
					"",
					'{ "accounts": [',
					'  { "id": "work", "label": "OpenRouter (Work)",',
					'    "apiKey": "$OPENROUTER_WORK_KEY", "dataCollection": "deny", "zdr": true },',
					'  { "id": "personal", "label": "OpenRouter (Personal)",',
					'    "apiKey": "$OPENROUTER_PERSONAL_KEY", "onlyFree": false }',
					"] }",
					"",
					"Provider id = openrouter-<id>. Use it as `<provider>/<model>`, e.g.",
					"  openrouter-work/anthropic/claude-fable-5",
					"  openrouter-personal/cohere/north-mini-code:free",
				].join("\n");
				if (ctx.hasUI) ctx.ui.notify(help, "info");
				return;
			}

			// default: status
			const configured = accounts.map((a) => providerIdFor(a));
			const live = ctx.modelRegistry
				.getAll()
				.filter((m) => m.provider.startsWith(ACCOUNT_PROVIDER_PREFIX))
				.map((m) => m.provider);
			const uniqueLive = [...new Set(live)];
			const lines = [
				`# openrouter-accounts`,
				`config: ${path ?? "(none)"}`,
				`configured: ${configured.join(", ") || "(none)"}`,
				`registered: ${uniqueLive.join(", ") || "(none)"}`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
