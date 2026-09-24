// /openrouter-accounts subcommands, help and status.
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_PROVIDER_PREFIX, BASE_PROVIDER, type AccountConfig } from "./types.js";
import {
	authPath,
	deleteStoredKey,
	envConfigPath,
	globalConfigPath,
	loadConfig,
	projectConfigPath,
	saveConfig,
	setStoredKey,
	targetConfigPath,
} from "./io.js";
import {
	builtinKey,
	providerIdFor,
	registerAll,
	registerOne,
	removeAccount,
	unregisterProviderId,
	upsertAccount,
} from "./accounts.js";
import { promptKeySource, wizardAdd } from "./wizard.js";

/** `--global` is accepted as a prefix or a suffix; it is stripped before dispatch. */
export function parseArgs(raw: string): { isGlobal: boolean; tokens: string[] } {
	const all = raw.trim().split(/\s+/).filter(Boolean);
	const isGlobal = all.some((t) => t.toLowerCase() === "--global");
	return { isGlobal, tokens: all.filter((t) => t.toLowerCase() !== "--global") };
}

export async function runCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	args: string,
): Promise<void> {
	const { isGlobal, tokens } = parseArgs(args);
	const sub = (tokens[0] ?? "").toLowerCase() || "status";
	const rest = tokens.slice(1);

	const config = loadConfig(ctx.cwd);
	const accounts = config.accounts ?? [];
	const writeTarget = targetConfigPath(ctx.cwd, isGlobal);

	const layerLines = (): string[] => {
		const env = envConfigPath();
		const globalPath = globalConfigPath();
		const projectPath = projectConfigPath(ctx.cwd);
		const lines = [
			`global:    ${globalPath}${existsSync(globalPath) ? "" : " (not created yet)"}`,
			`project:   ${projectPath}${existsSync(projectPath) ? "" : " (not created yet)"}`,
		];
		if (env) lines.push(`env:       ${env}  (PI_OPENROUTER_ACCOUNTS overrides the cascade)`);
		lines.push(`write:     ${writeTarget}${isGlobal ? "  (--global)" : ""}`);
		return lines;
	};

	const printHelp = () => {
		const help = [
			"# /openrouter-accounts",
			"One Pi provider per OpenRouter account, so the account shows in the /model picker.",
			"",
			...layerLines(),
			`auth:      ${authPath()}`,
			"",
			"  /openrouter-accounts add              add an account (wizard)",
			"  /openrouter-accounts edit <id>        edit an account",
			"  /openrouter-accounts show <id>        show one account in detail",
			"  /openrouter-accounts key <id>         replace its API key",
			"  /openrouter-accounts rename <id>      change display name",
			"  /openrouter-accounts remove <id>      delete account + stored key",
			"  /openrouter-accounts list             list accounts",
			"  /openrouter-accounts import           import built-in openrouter credential",
			"  /openrouter-accounts status           configured vs registered",
			"  /openrouter-accounts refresh          re-register providers",
			"",
			"Add --global (before or after the subcommand) to write ~/.pi/agent/",
			"instead of the project layer; without it the change goes to <cwd>/.pi/.",
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
			...layerLines(),
			`configured: ${accounts.map((a) => `${a.id} (${providerIdFor(a)})`).join(", ") || "(none)"}`,
			`registered: ${live.join(", ") || "(none)"}`,
			"",
			accounts.length === 0
				? "Run /openrouter-accounts add to create your first account."
				: "Keys live in auth.json; config holds ids, labels and policy.",
		];
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
	};

	const findAccount = (id: string | undefined): AccountConfig | undefined =>
		accounts.find((a) => a.id === id);

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
			ctx.ui.notify([`# OpenRouter accounts (${writeTarget})`, ...lines].join("\n"), "info");
			return;
		}

		case "show": {
			const account = findAccount(rest[0]);
			if (!account) {
				ctx.ui.notify(
					`Unknown account "${rest[0] ?? ""}". Use /openrouter-accounts list`,
					"warning",
				);
				return;
			}
			const lines = [
				`# ${account.id}`,
				`provider:  ${providerIdFor(account)}`,
				`label:     ${account.label ?? account.id}`,
				`key:       ${account.apiKey ?? `auth.json (${providerIdFor(account)})`}`,
				`data:      ${account.dataCollection ?? "account default"}`,
				`zdr:       ${account.zdr ? "on" : "off"}`,
				`scope:     ${account.onlyFree ? "free models only" : "all models"}`,
				`api:       ${account.api ?? "catalog default"}`,
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
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
				ctx.ui.notify(
					"No built-in OpenRouter credential found in auth.json or OPENROUTER_API_KEY.",
					"warning",
				);
				return;
			}
			if (accounts.some((a) => a.id === "default")) {
				ctx.ui.notify(
					'Account "default" already exists. Use /openrouter-accounts edit default.',
					"warning",
				);
				return;
			}
			const account: AccountConfig = { id: "default", label: "OpenRouter (Default)" };
			upsertAccount(config, account);
			const target = saveConfig(config, isGlobal, ctx.cwd);
			setStoredKey(providerIdFor(account), key);
			ctx.ui.notify(
				`Imported built-in credential as account "default" into ${target}.`,
				"info",
			);
			return;
		}

		case "add": {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive wizard needs TUI or RPC mode.", "warning");
				return;
			}
			await wizardAdd(pi, ctx, config, isGlobal, ctx.cwd);
			return;
		}

		case "edit":
		case "rename":
		case "key":
		case "remove": {
			const account = findAccount(rest[0]);
			if (!account) {
				ctx.ui.notify(
					`Unknown account "${rest[0] ?? ""}". Use /openrouter-accounts list`,
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
				saveConfig(config, isGlobal, ctx.cwd);
				if (!account.apiKey) deleteStoredKey(providerId);
				unregisterProviderId(pi, providerId);
				ctx.ui.notify(`Removed ${account.id}.`, "info");
				return;
			}

			if (sub === "rename") {
				const label = (await ctx.ui.input("Display name", account.label ?? account.id))?.trim();
				if (!label) return;
				account.label = label;
				upsertAccount(config, account);
				saveConfig(config, isGlobal, ctx.cwd);
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
				saveConfig(config, isGlobal, ctx.cwd);
				ctx.ui.notify(`Key updated for ${providerId}.`, "info");
				return;
			}

			// edit: full wizard prefilled
			await wizardAdd(pi, ctx, config, isGlobal, ctx.cwd, account);
			return;
		}

		default:
			ctx.ui.notify(`Unknown subcommand "${sub}". Use: /openrouter-accounts help`, "warning");
			return;
	}
}
