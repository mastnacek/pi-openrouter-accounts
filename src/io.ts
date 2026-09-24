// Paths, JSON IO and the account config cascade.
//
// Layers, lowest priority first:
//   defaults <- ~/.pi/agent/openrouter-accounts.json <- <cwd>/.pi/openrouter-accounts.json
// `PI_OPENROUTER_ACCOUNTS` overrides the whole cascade when set.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_FILENAME, type AccountConfig, type AccountsFile, type Credential } from "./types.js";

/** `--global` (isGlobal) writes this layer. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILENAME);
}

/** Explicit override; when set it replaces the whole cascade. */
export function envConfigPath(): string | undefined {
	const fromEnv = process.env.PI_OPENROUTER_ACCOUNTS?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/** First existing layer (env > project > global), or undefined when none exists. */
export function existingConfigPath(cwd: string): string | undefined {
	const fromEnv = envConfigPath();
	if (fromEnv) return fromEnv;
	const project = projectConfigPath(cwd);
	if (existsSync(project)) return project;
	const global = globalConfigPath();
	return existsSync(global) ? global : undefined;
}

/** Layer a write lands in: env override, else global for `--global`, else project. */
export function targetConfigPath(cwd: string, isGlobal: boolean): string {
	return envConfigPath() ?? (isGlobal ? globalConfigPath() : projectConfigPath(cwd));
}

export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

export function authPath(): string {
	return join(agentDir(), "auth.json");
}

export function globalConfigPath(): string {
	return join(agentDir(), CONFIG_FILENAME);
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function writeJson(path: string, value: unknown, mode?: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode,
	});
	renameSync(tmp, path);
}

function readAccountsFile(path: string): AccountsFile {
	const data = readJson<AccountsFile>(path);
	if (!data || !Array.isArray(data.accounts)) return { accounts: [] };
	return {
		...data,
		accounts: data.accounts.filter(
			(a): a is AccountConfig => typeof a?.id === "string" && a.id.trim().length > 0,
		),
	};
}

/** Global layer, then the project layer overriding any account with the same id. */
export function loadConfig(cwd: string): AccountsFile {
	const fromEnv = envConfigPath();
	if (fromEnv) return readAccountsFile(fromEnv);

	const globalAccounts = readAccountsFile(globalConfigPath()).accounts ?? [];
	const projectAccounts = readAccountsFile(projectConfigPath(cwd)).accounts ?? [];
	if (projectAccounts.length === 0) return { accounts: globalAccounts };

	const merged = new Map<string, AccountConfig>();
	for (const account of globalAccounts) merged.set(account.id, account);
	for (const account of projectAccounts) merged.set(account.id, account);
	return { accounts: [...merged.values()] };
}

/** Writes the effective config into the selected layer and returns that path. */
export function saveConfig(config: AccountsFile, isGlobal: boolean, cwd: string): string {
	const target = targetConfigPath(cwd, isGlobal);
	writeJson(target, config);
	return target;
}

export function readAuth(): Record<string, Credential> {
	return readJson<Record<string, Credential>>(authPath()) ?? {};
}

export function writeAuth(data: Record<string, Credential>): void {
	writeJson(authPath(), data, 0o600);
}

export function setStoredKey(providerId: string, key: string): void {
	const data = readAuth();
	data[providerId] = { type: "api_key", key };
	writeAuth(data);
}

export function deleteStoredKey(providerId: string): void {
	const data = readAuth();
	if (providerId in data) {
		delete data[providerId];
		writeAuth(data);
	}
}
