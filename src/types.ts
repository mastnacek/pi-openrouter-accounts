// Shared types and constants for pi-openrouter-accounts.

import type { Api } from "@earendil-works/pi-ai";



export const ACCOUNT_PROVIDER_PREFIX = "openrouter-";
export const BASE_PROVIDER = "openrouter";
export const BASE_URL = "https://openrouter.ai/api/v1";
export const CONFIG_FILENAME = "openrouter-accounts.json";
export const HELP_KEY = "_help";

export interface AccountConfig {
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

export interface AccountsFile {
	accounts?: AccountConfig[];
	[key: string]: unknown;
}

export type Credential = { type?: string; key?: string; access?: string };

export interface ScaffoldResult {
	path: string;
	created: boolean;
	imported: boolean;
}
