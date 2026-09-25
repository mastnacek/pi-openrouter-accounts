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
 * interactively with `/openrouter-accounts` (add / edit / show / key / rename /
 * remove / list / import / status / refresh).
 *
 * Config cascade (lowest priority first):
 *   defaults <- ~/.pi/agent/openrouter-accounts.json <- <cwd>/.pi/openrouter-accounts.json
 * `--global` writes the global layer; without it the project layer is written.
 * `PI_OPENROUTER_ACCOUNTS` overrides the whole cascade.
 *
 * Startup model: `defaultProvider` may name one of OUR alias providers
 * (`openrouter-<id>`), which the engine only knows once registerProvider has
 * run. `session_start` fires AFTER the engine resolved the startup model, so
 * a fresh session can land on the engine's vendored fallback
 * (openrouter -> moonshotai/kimi-k2.6) instead of the configured default.
 * The reapply in session_start fixes that: when the configured default is an
 * alias model with auth, and the active model is not one of ours, swap to
 * the default via pi.setModel (session-only; never rewrites settings).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAll, unregisterAll } from "./src/accounts.js";
import { runCommand } from "./src/command.js";
import { reapplyDefaultModel } from "./src/default-model.js";
import { getCompletions } from "./src/completions.js";
import { loadConfig } from "./src/io.js";
import { scaffold } from "./src/wizard.js";

export default function (pi: ExtensionAPI): void {
	/** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
	const unsubscribers: Array<() => void> = [];

	/** Retain a `pi.on()` return value; older engine typings declare it void. */
	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	/** Completion callbacks get no context, so follow the last started session. */
	let sessionCwd = process.cwd();

	track(
		pi.on("session_start", (event, ctx) => {
			sessionCwd = ctx.cwd;
			const result = scaffold(ctx.cwd);
			const summary = registerAll(pi, ctx);
			// Belt-and-braces: swap a core-fallback startup model to the
			// configured alias default (must run AFTER registerAll above).
			void reapplyDefaultModel(pi, event, ctx).catch(() => {});
			const accounts = loadConfig(ctx.cwd).accounts ?? [];
			if (ctx.hasUI) {
				if (result.created) {
					ctx.ui.notify(
						[
							`pi-openrouter-accounts: created ${result.path}`,
							accounts.length > 0
								? 'Imported your existing OpenRouter key as account "default".'
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
		}),
	);

	pi.on("session_shutdown", () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		unregisterAll(pi);
	});

	pi.registerCommand("openrouter-accounts", {
		description:
			"Manage OpenRouter accounts (providers openrouter-<id>, keys, labels, data policy)",
		getArgumentCompletions: (prefix: string) => getCompletions(prefix, sessionCwd),
		handler: async (args: string, ctx) => {
			await runCommand(pi, ctx, args);
		},
	});
}
