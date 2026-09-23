/**
 * pi-openrouter-accounts
 * -----------------------
 * Run several OpenRouter accounts side by side in Pi.
 *
 * Pi stores exactly ONE credential per provider id (auth.json is
 * `Record<providerId, Credential>`), and the /model picker badge is the
 * provider id. So each account becomes its own provider id:
 *
 *     openrouter-work      -> deepseek/deepseek-v4.1-flash [openrouter-work]
 *     openrouter-personal  -> cohere/north-mini-code:free  [openrouter-personal]
 *
 * Every alias reuses the built-in OpenRouter catalog, resolves its own key
 * (stored in ~/.pi/agent/auth.json by default), and can force an OpenRouter
 * data-policy route (`data_collection: "deny"`, `zdr: true`).
 *
 * The config file is scaffolded automatically on first run and is managed
 * interactively with `/openrouter-accounts` (add / edit / key / rename /
 * remove / list / import / status / refresh).
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

const ACCOUNT_PROVIDER_PREFIX = "openrouter-";
const BASE_PROVIDER = "openrouter";
const BASE_URL = "https://openrouter.ai/api/v1";
const CONFIG_FILENAME = "openrouter-accounts.json";
const HELP_KEY = "_help";

interface AccountConfig {
	/** Short slug; provider id becomes `openrouter-<id>`. */
	id: string;
	/** Display name used by /login, footer and error messages. */
	label?: string;
	/** Optional key source: `$ENV_VAR`, `${ENV_VAR}`, `!command`, or literal. */
	apiKey?: string;
	/** OpenRouter account-level data policy: "deny" or "allow". */
	dataCollection?: "deny" | "allow";
	/** Force zero-data-retention endpoints for this account. */
	zdr?: boolean;
	/** Restrict the alias to free models (`*:free` + `openrouter/free`). */
	onlyFree?: boolean;
	/** Override the API type for every model of this account. */
	api?: Api;
}

interface AccountsFile {
	accounts?: AccountConfig[];
	[key: string]: unknown;
}

type Credential = { type?: string; key?: string; access?: string };

const registered = new Set<string>();

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

function authPath(): string {
	return join(agentDir(), "auth.json");
}

function globalConfigPath(): string {
	return join(agentDir(), CONFIG_FILENAME);
}

/** Existing config path (env > project > global), or undefined when none exists. */
function resolveConfigPath(cwd: string): string | undefined {
	const fromEnv = process.env.PI_OPENROUTER_ACCOUNTS?.trim();
	if (fromEnv) return fromEnv;
	const project = join(cwd, ".pi", CONFIG_FILENAME);
	if (existsSync(project)) return project;
	const global = globalConfigPath();
	if (existsSync(global)) return global;
	return undefined;
}

/** Writable config path, creating the global file when nothing exists yet. */
function ensureConfigPath(cwd: string): string {
	const fromEnv = process.env.PI_OPENROUTER_ACCOUNTS?.trim();
	if (fromEnv) return fromEnv;
	const project = join(cwd, ".pi", CONFIG_FILENAME);
	if (existsSync(project)) return project;
	return globalConfigPath();
}

/* ------------------------------------------------------------------ */
/* File IO                                                             */
/* ------------------------------------------------------------------ */

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode,
	});
	renameSync(tmp, path);
}

function loadConfig(path: string | undefined): AccountsFile {
	if (!path) return { accounts: [] };
	const data = readJson<AccountsFile>(path);
	if (!data || !Array.isArray(data.accounts)) return { accounts: [] };
	return {
		...data,
		accounts: data.accounts.filter(
			(a): a is AccountConfig => typeof a?.id === "string" && a.id.trim().length > 0,
		),
	};
}

function saveConfig(path: string, config: AccountsFile): void {
	writeJson(path, config);
}

function readAuth(): Record<string, Credential> {
	return readJson<Record<string, Credential>>(authPath()) ?? {};
}

function writeAuth(data: Record<string, Credential>): void {
	writeJson(authPath(), data, 0o600);
}

function setStoredKey(providerId: string, key: string): void {
	const data = readAuth();
	data[providerId] = { type: "api_key", key };
	writeAuth(data);
}

function deleteStoredKey(providerId: string): void {
	const data = readAuth();
	if (providerId in data) {
		delete data[providerId];
		writeAuth(data);
	}
}

/** API key already provisioned for the built-in OpenRouter provider, if any. */
function builtinKey(): string | undefined {
	const credential = readAuth()[BASE_PROVIDER];
	const fromAuth = credential?.key ?? credential?.access;
	if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

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
		compat,
	};
}

function registerOne(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	account: AccountConfig,
	catalog: readonly Model<Api>[],
): string {
	const providerId = providerIdFor(account);
	const models = (account.onlyFree ? catalog.filter(isFreeModel) : catalog).map((m) =>
		toProviderModel(m, account),
	);
	if (models.length === 0) return `${providerId}: no models`;
	try {
		if (registered.has(providerId)) pi.unregisterProvider(providerId);
		pi.registerProvider(providerId, {
			name: account.label ?? providerId,
			baseUrl: BASE_URL,
			// The stored auth.json credential wins; this is only the fallback source.
			apiKey: account.apiKey ?? defaultKeyRef(account),
			models,
		});
		registered.add(providerId);
		return `${providerId}: ${models.length} models`;
	} catch (error) {
		return `${providerId}: failed (${error instanceof Error ? error.message : String(error)})`;
	}
}

function registerAll(pi: ExtensionAPI, ctx: ExtensionContext, force = false): string[] {
	const path = resolveConfigPath(ctx.cwd);
	const accounts = loadConfig(path).accounts ?? [];
	if (accounts.length === 0) return [];
	const catalog = ctx.modelRegistry.getAll().filter((m) => m.provider === BASE_PROVIDER);
	if (catalog.length === 0) return [];
	const summary: string[] = [];
	const seen = new Set<string>();
	for (const account of accounts) {
		const providerId = providerIdFor(account);
		if (seen.has(providerId)) {
			summary.push(`${providerId}: duplicate id skipped`);
			continue;
		}
		seen.add(providerId);
		if (registered.has(providerId) && !force) {
			summary.push(`${providerId}: registered`);
			continue;
		}
		summary.push(registerOne(pi, ctx, account, catalog));
	}
	return summary;
}

/* ------------------------------------------------------------------ */
/* Scaffold + import                                                   */
/* ------------------------------------------------------------------ */

interface ScaffoldResult {
	path: string;
	created: boolean;
	imported: boolean;
}

function scaffold(cwd: string): ScaffoldResult {
	const existing = resolveConfigPath(cwd);
	if (existing) return { path: existing, created: false, imported: false };

	const path = ensureConfigPath(cwd);
	const key = builtinKey();
	const accounts: AccountConfig[] = key
		? [{ id: "default", label: "OpenRouter (Default)" }]
		: [];
	const file: AccountsFile = {
		[HELP_KEY]:
			"OpenRouter accounts managed by pi-openrouter-accounts. Add or edit with /openrouter-accounts. Each entry becomes the provider id openrouter-<id>.",
		accounts,
	};
	saveConfig(path, file);
	if (key && accounts.length > 0) setStoredKey(providerIdFor(accounts[0]), key);
	return { path, created: true, imported: accounts.length > 0 };
}

function upsertAccount(config: AccountsFile, account: AccountConfig): void {
	const accounts = config.accounts ?? [];
	const index = accounts.findIndex((a) => a.id === account.id);
	if (index >= 0) accounts[index] = account;
	else accounts.push(account);
	config.accounts = accounts;
}

function removeAccount(config: AccountsFile, id: string): AccountConfig | undefined {
	const accounts = config.accounts ?? [];
	const index = accounts.findIndex((a) => a.id === id);
	if (index < 0) return undefined;
	const [removed] = accounts.splice(index, 1);
	config.accounts = accounts;
	return removed;
}

/* ------------------------------------------------------------------ */
/* Interactive wizard                                                  */
/* ------------------------------------------------------------------ */

function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

async function promptKeySource(
	ctx: ExtensionContext,
	providerId: string,
): Promise<{ apiKey?: string; storedKey?: string; skipped: boolean } | undefined> {
	const choice = await ctx.ui.select(`API key for ${providerId}`, [
		"Store in Pi auth.json (recommended)",
		"Use an environment variable",
		"Use a shell command",
		"Skip for now",
	]);
	if (!choice) return undefined;
	if (choice.startsWith("Store")) {
		const key = await ctx.ui.input(
			`Paste OpenRouter API key for ${providerId} (input is visible)`,
			"sk-or-v1-...",
		);
		const trimmed = key?.trim();
		if (!trimmed) return { skipped: true };
		return { storedKey: trimmed, skipped: false };
	}
	if (choice.startsWith("Use an environment")) {
		const name = await ctx.ui.input("Environment variable name", `OPENROUTER_${providerId.toUpperCase()}_API_KEY`);
		const trimmed = name?.trim();
		if (!trimmed) return { skipped: true };
		return { apiKey: `$${trimmed.replace(/^\$/, "")}`, skipped: false };
	}
	if (choice.startsWith("Use a shell command")) {
		const command = await ctx.ui.input("Command whose stdout is the key", "op read op://AI/OpenRouter/api-key");
		const trimmed = command?.trim();
		if (!trimmed) return { skipped: true };
		return { apiKey: trimmed.startsWith("!") ? trimmed : `!${trimmed}`, skipped: false };
	}
	return { skipped: true };
}

async function wizardAdd(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AccountsFile,
	configPath: string,
	base?: AccountConfig,
): Promise<boolean> {
	const rawId = await ctx.ui.input(
		base ? `Account id for ${base.id} (rename changes the provider id)` : "Account id (slug)",
		base?.id ?? "work",
	);
	const id = slugify(rawId ?? "");
	if (!id) {
		ctx.ui.notify("Cancelled: account id is required.", "warning");
		return false;
	}
	const label = (
		await ctx.ui.input("Display name", base?.label ?? `OpenRouter (${id})`)
	)?.trim();

	const providerId = id === BASE_PROVIDER ? BASE_PROVIDER : `${ACCOUNT_PROVIDER_PREFIX}${id}`;
	const account: AccountConfig = { id, label: label || `OpenRouter (${id})` };

	const keyResult = await promptKeySource(ctx, providerId);
	if (!keyResult) return false;

	if (keyResult.storedKey) setStoredKey(providerId, keyResult.storedKey);
	else if (keyResult.apiKey) account.apiKey = keyResult.apiKey;

	const policy = await ctx.ui.select("Data policy", [
		"Account default",
		"[Work] deny data collection + ZDR",
		"ZDR only",
		"Allow data collection",
	]);
	if (policy?.startsWith("[Work]")) {
		account.dataCollection = "deny";
		account.zdr = true;
	} else if (policy === "ZDR only") {
		account.zdr = true;
	} else if (policy === "Allow data collection") {
		account.dataCollection = "allow";
	}

	const scope = await ctx.ui.select("Model scope", ["All models", "Free models only"]);
	if (scope === "Free models only") account.onlyFree = true;

	if (base && base.id !== id) {
		// Rename: drop the previous provider id and its stored key if it was ours.
		const previousProviderId = providerIdFor(base);
		removeAccount(config, base.id);
		deleteStoredKey(previousProviderId);
		if (registered.has(previousProviderId)) {
			try {
				pi.unregisterProvider(previousProviderId);
			} catch {
				/* best effort */
			}
			registered.delete(previousProviderId);
		}
	}
	upsertAccount(config, account);
	saveConfig(configPath, config);

	ctx.ui.notify(`Saved ${account.id}. Use /openrouter-accounts refresh if it is not listed.`, "info");
	return true;
}

/* ------------------------------------------------------------------ */
/* Extension                                                           */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		const result = scaffold(ctx.cwd);
		const summary = registerAll(pi, ctx);
		const accounts = loadConfig(result.path).accounts ?? [];
		if (ctx.hasUI) {
			if (result.created) {
				ctx.ui.notify(
					[
						`pi-openrouter-accounts: created ${result.path}`,
						accounts.length > 0
							? "Imported your existing OpenRouter key as account \"default\"."
							: "No accounts yet — run /openrouter-accounts add to create one.",
					].join("\n"),
					"info",
				);
			}
			ctx.ui.setStatus(
				"openrouter-accounts",
				summary.length > 0 ? summary.join(" · ") : "no accounts · /openrouter-accounts add",
			);
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
		description: "Manage OpenRouter accounts (providers openrouter-<id>, keys, labels, data policy)",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const trailingSpace = /\s$/.test(prefix);
			const path = resolveConfigPath(process.cwd());
			const ids = (loadConfig(path).accounts ?? []).map((a) => a.id);

			if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
				const sub = tokens[0]?.toLowerCase();
				if (["edit", "key", "rename", "remove", "show"].includes(sub ?? "")) {
					const typed = tokens.slice(1).join(" ").toLowerCase();
					const items = ids
						.filter((id) => id.toLowerCase().startsWith(typed))
						.map((id) => ({ value: `${sub} ${id}`, label: `${sub} ${id}`, description: "account" }));
					return items.length > 0 ? items : null;
				}
				return null;
			}

			const docs: Record<string, string> = {
				add: "create an account (interactive wizard)",
				edit: "edit label, key source, data policy or model scope",
				key: "replace the API key of an account",
				rename: "change the display name",
				remove: "delete an account and its stored key",
				list: "list configured accounts",
				import: "import the built-in openrouter credential as account \"default\"",
				status: "show configured vs registered providers",
				refresh: "re-register providers now",
				help: "show the configuration reference",
			};
			const typed = (tokens[0] ?? "").toLowerCase();
			const NON_TERMINAL = new Set(["edit", "key", "rename", "remove", "show"]);
			const items: AutocompleteItem[] = [];
			for (const [key, description] of Object.entries(docs)) {
				if (key.toLowerCase().startsWith(typed)) {
					items.push({
						value: NON_TERMINAL.has(key) ? `${key} ` : key,
						label: key,
						description,
					});
				}
			}
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = (tokens[0] ?? "").toLowerCase() || "status";
			const rest = tokens.slice(1);

			const path = resolveConfigPath(ctx.cwd) ?? ensureConfigPath(ctx.cwd);
			const config = loadConfig(path);
			const accounts = config.accounts ?? [];

			const printHelp = () => {
				const help = [
					"# /openrouter-accounts",
					"One Pi provider per OpenRouter account, so the account shows in the /model picker.",
					"",
					`config: ${path}`,
					`auth:   ${authPath()}`,
					"",
					"  /openrouter-accounts add          add an account (wizard)",
					"  /openrouter-accounts edit <id>    edit an account",
					"  /openrouter-accounts key <id>     replace its API key",
					"  /openrouter-accounts rename <id>  change display name",
					"  /openrouter-accounts remove <id>  delete account + stored key",
					"  /openrouter-accounts list         list accounts",
					"  /openrouter-accounts import       import built-in openrouter credential",
					"  /openrouter-accounts status       configured vs registered",
					"  /openrouter-accounts refresh      re-register providers",
					"",
					"Provider id = openrouter-<id>; use as openrouter-work/anthropic/claude-fable-5",
				].join("\n");
				if (ctx.hasUI) ctx.ui.notify(help, "info");
			};

			const showStatus = () => {
				const live = [
					...new Set(
						ctx.modelRegistry
							.getAll()
							.filter((m) => m.provider.startsWith(ACCOUNT_PROVIDER_PREFIX))
							.map((m) => m.provider),
					),
				];
				const lines = [
					"# openrouter-accounts",
					`config:     ${path}`,
					`configured: ${accounts.map((a) => `${a.id} (${providerIdFor(a)})`).join(", ") || "(none)"}`,
					`registered: ${live.join(", ") || "(none)"}`,
					"",
					accounts.length === 0
						? "Run /openrouter-accounts add to create your first account."
						: "Keys live in auth.json; config holds ids, labels and policy.",
				];
				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
			};

			switch (sub) {
				case "help":
					printHelp();
					return;

				case "status":
					showStatus();
					return;

				case "list": {
					if (accounts.length === 0) {
						ctx.ui.notify("No accounts configured. Run /openrouter-accounts add", "warning");
						return;
					}
					const lines = accounts.map((a) => {
						const bits = [
							providerIdFor(a),
							a.label ?? a.id,
							a.apiKey ? `key: ${a.apiKey}` : "key: auth.json",
							a.dataCollection ? `data: ${a.dataCollection}` : undefined,
							a.zdr ? "zdr" : undefined,
							a.onlyFree ? "free-only" : undefined,
						].filter(Boolean);
						return `  ${bits.join(" · ")}`;
					});
					ctx.ui.notify([`# OpenRouter accounts (${path})`, ...lines].join("\n"), "info");
					return;
				}

				case "refresh": {
					const summary = registerAll(pi, ctx, true);
					ctx.ui.notify(
						summary.length > 0 ? summary.join("\n") : "No accounts configured.",
						"info",
					);
					return;
				}

				case "import": {
					const key = builtinKey();
					if (!key) {
						ctx.ui.notify("No built-in OpenRouter credential found in auth.json or OPENROUTER_API_KEY.", "warning");
						return;
					}
					if (accounts.some((a) => a.id === "default")) {
						ctx.ui.notify('Account "default" already exists. Use /openrouter-accounts edit default.', "warning");
						return;
					}
					const account: AccountConfig = { id: "default", label: "OpenRouter (Default)" };
					upsertAccount(config, account);
					saveConfig(path, config);
					setStoredKey(providerIdFor(account), key);
					ctx.ui.notify('Imported built-in credential as account "default".', "info");
					return;
				}

				case "add": {
					if (!ctx.hasUI) {
						ctx.ui.notify("Interactive wizard needs TUI or RPC mode.", "warning");
						return;
					}
					await wizardAdd(pi, ctx, config, path);
					return;
				}

				case "edit":
				case "rename":
				case "key":
				case "remove": {
					const id = rest[0];
					const account = accounts.find((a) => a.id === id);
					if (!account) {
						ctx.ui.notify(
							`Unknown account "${id ?? ""}". Use /openrouter-accounts list`,
							"warning",
						);
						return;
					}
					const providerId = providerIdFor(account);
					if (!ctx.hasUI) {
						ctx.ui.notify("Interactive editing needs TUI or RPC mode.", "warning");
						return;
					}

					if (sub === "remove") {
						const ok = await ctx.ui.confirm(
							`Remove account "${account.id}"?`,
							`Deletes the config entry and the stored key for ${providerId}.`,
						);
						if (!ok) return;
						removeAccount(config, account.id);
						saveConfig(path, config);
						if (!account.apiKey) deleteStoredKey(providerId);
						if (registered.has(providerId)) {
							try {
								pi.unregisterProvider(providerId);
							} catch {
								/* best effort */
							}
							registered.delete(providerId);
						}
						ctx.ui.notify(`Removed ${account.id}.`, "info");
						return;
					}

					if (sub === "rename") {
						const label = (await ctx.ui.input("Display name", account.label ?? account.id))?.trim();
						if (!label) return;
						account.label = label;
						upsertAccount(config, account);
						saveConfig(path, config);
						const catalog = ctx.modelRegistry.getAll().filter((m) => m.provider === BASE_PROVIDER);
						registerOne(pi, ctx, account, catalog);
						ctx.ui.notify(`Renamed to "${label}".`, "info");
						return;
					}

					if (sub === "key") {
						const result = await promptKeySource(ctx, providerId);
						if (!result) return;
						if (result.storedKey) {
							setStoredKey(providerId, result.storedKey);
							delete account.apiKey;
						} else if (result.apiKey) {
							account.apiKey = result.apiKey;
							deleteStoredKey(providerId);
						} else {
							ctx.ui.notify("No key change.", "warning");
							return;
						}
						upsertAccount(config, account);
						saveConfig(path, config);
						ctx.ui.notify(`Key updated for ${providerId}.`, "info");
						return;
					}

					// edit: full wizard prefilled
					await wizardAdd(pi, ctx, config, path, account);
					return;
				}

				default:
					ctx.ui.notify(`Unknown subcommand "${sub}". Use: /openrouter-accounts help`, "warning");
					return;
			}
		},
	});
}
