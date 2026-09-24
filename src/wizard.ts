// Interactive wizard and first-run scaffolding.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ACCOUNT_PROVIDER_PREFIX,
	BASE_PROVIDER,
	HELP_KEY,
	type AccountConfig,
	type AccountsFile,
	type ScaffoldResult,
} from "./types.js";
import {
	deleteStoredKey,
	existingConfigPath,
	globalConfigPath,
	saveConfig,
	setStoredKey,
} from "./io.js";
import {
	builtinKey,
	providerIdFor,
	registered,
	removeAccount,
	slugify,
	unregisterProviderId,
	upsertAccount,
} from "./accounts.js";

export function scaffold(cwd: string): ScaffoldResult {
	const existing = existingConfigPath(cwd);
	if (existing) return { path: existing, created: false, imported: false };

	// Nothing exists yet: seed the global layer so the plugin works everywhere.
	const path = globalConfigPath();
	const key = builtinKey();
	const accounts: AccountConfig[] = key
		? [{ id: "default", label: "OpenRouter (Default)" }]
		: [];

	const file: AccountsFile = {
		[HELP_KEY]:
			"OpenRouter accounts managed by pi-openrouter-accounts. Add or edit with /openrouter-accounts. Each entry becomes the provider id openrouter-<id>.",
		accounts,
	};
	saveConfig(file, true, cwd);
	if (key && accounts.length > 0) setStoredKey(providerIdFor(accounts[0]), key);
	return { path, created: true, imported: accounts.length > 0 };
}

export async function promptKeySource(
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

export async function wizardAdd(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: AccountsFile,
	isGlobal: boolean,
	cwd: string,
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
	saveConfig(config, isGlobal, cwd);

	ctx.ui.notify(
		`Saved ${account.id} to the ${isGlobal ? "global" : "project"} layer. Use /openrouter-accounts refresh if it is not listed.`,
		"info",
	);
	return true;
}
