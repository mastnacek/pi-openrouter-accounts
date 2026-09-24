// Argument completion for /openrouter-accounts, including the `--global` prefix.
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig } from "./io.js";

const SUBCOMMAND_DOCS: Record<string, string> = {
	add: "create an account (interactive wizard)",
	edit: "edit label, key source, data policy or model scope",
	key: "replace the API key of an account",
	rename: "change the display name",
	remove: "delete an account and its stored key",
	show: "show one account in detail",
	list: "list configured accounts",
	import: 'import the built-in openrouter credential as account "default"',
	status: "show configured vs registered providers and config paths",
	refresh: "re-register providers now",
	help: "show the configuration reference",
};

/** Subcommands that take further arguments (Trailing Space Contract). */
const NON_TERMINAL = new Set(["edit", "key", "rename", "remove", "show"]);

/** Subcommands whose second argument is an account id. */
const ACCOUNT_TAKING = NON_TERMINAL;

const GLOBAL_ROW: AutocompleteItem = {
	value: "--global ",
	label: "--global",
	description: "Write the change to ~/.pi/agent/ instead of the project",
};

export function getCompletions(prefix: string, cwd: string): AutocompleteItem[] | null {
	// `--global` prefix: complete the remainder, then re-prefix the suggestions.
	const trimmed = prefix.trimStart();
	if (trimmed.startsWith("--global")) {
		const afterGlobal = trimmed.slice(8).trimStart();
		const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);
		if (!hasTrailingSpace && afterGlobal === "") return [GLOBAL_ROW];
		const sub = getCompletions(afterGlobal, cwd);
		if (!sub) return null;
		const out: AutocompleteItem[] = [];
		for (const item of sub) {
			if (item.label === "--global") continue;
			out.push({
				value: `--global ${item.value}`,
				label: item.label,
				description: item.description,
			});
		}
		return out.length > 0 ? out : null;
	}

	const tokens = prefix.split(/\s+/).filter(Boolean);
	const trailingSpace = /\s$/.test(prefix);
	const typed = (tokens[0] ?? "").toLowerCase();

	if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
		if (!ACCOUNT_TAKING.has(typed)) return null;
		const needle = tokens.slice(1).join(" ").toLowerCase();
		const ids = (loadConfig(cwd).accounts ?? []).map((a) => a.id);
		const items = ids
			.filter((id) => id.toLowerCase().startsWith(needle))
			.map((id) => ({ value: `${typed} ${id}`, label: id, description: "account" }));
		return items.length > 0 ? items : null;
	}

	const items: AutocompleteItem[] = [];
	if ("--global".startsWith(typed)) items.push(GLOBAL_ROW);
	for (const [key, description] of Object.entries(SUBCOMMAND_DOCS)) {
		if (!key.startsWith(typed)) continue;
		items.push({
			value: NON_TERMINAL.has(key) ? `${key} ` : key,
			label: key,
			description,
		});
	}
	return items.length > 0 ? items : null;
}
