// Account -> provider mapping, model translation and registration.
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	ACCOUNT_PROVIDER_PREFIX,
	BASE_PROVIDER,
	BASE_URL,
	type AccountConfig,
	type AccountsFile,
} from "./types.js";
import { loadConfig, readAuth } from "./io.js";

export const registered = new Set<string>();

/** API key already provisioned for the built-in OpenRouter provider, if any. */
export function builtinKey(): string | undefined {
	const credential = readAuth()[BASE_PROVIDER];
	const fromAuth = credential?.key ?? credential?.access;
	if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function providerIdFor(account: AccountConfig): string {
	const slug = account.id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!slug) return BASE_PROVIDER;
	return slug === BASE_PROVIDER ? BASE_PROVIDER : `${ACCOUNT_PROVIDER_PREFIX}${slug}`;
}

export function defaultKeyRef(account: AccountConfig): string {
	const env = `OPENROUTER_${account.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
	return `$${env}`;
}

export function isFreeModel(model: Model<Api>): boolean {
	return model.id.endsWith(":free") || model.id === "openrouter/free";
}

export function toProviderModel(model: Model<Api>, account: AccountConfig): ProviderModelConfig {
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

export function registerOne(
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

export function registerAll(pi: ExtensionAPI, ctx: ExtensionContext, force = false): string[] {
	const accounts = loadConfig(ctx.cwd).accounts ?? [];
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

/** Drop one of our aliases; no-op when it was never registered. */
export function unregisterProviderId(pi: ExtensionAPI, providerId: string): void {
	if (!registered.has(providerId)) return;
	try {
		pi.unregisterProvider(providerId);
	} catch {
		/* best effort */
	}
	registered.delete(providerId);
}

/** Drain every alias we registered (session_shutdown). */
export function unregisterAll(pi: ExtensionAPI): void {
	for (const providerId of registered) {
		try {
			pi.unregisterProvider(providerId);
		} catch {
			/* best effort */
		}
	}
	registered.clear();
}

export function upsertAccount(config: AccountsFile, account: AccountConfig): void {
	const accounts = config.accounts ?? [];
	const index = accounts.findIndex((a) => a.id === account.id);
	if (index >= 0) accounts[index] = account;
	else accounts.push(account);
	config.accounts = accounts;
}

export function removeAccount(config: AccountsFile, id: string): AccountConfig | undefined {
	const accounts = config.accounts ?? [];
	const index = accounts.findIndex((a) => a.id === id);
	if (index < 0) return undefined;
	const [removed] = accounts.splice(index, 1);
	config.accounts = accounts;
	return removed;
}

export function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
