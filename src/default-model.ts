// Re-apply the user's configured default model when the engine's startup
// fallback picked a different one.
//
// Why this safety net exists: `defaultProvider` may name one of OUR alias
// providers (`openrouter-<id>`). The engine resolves the startup model in
// `findInitialModel()` while the session is created. Alias providers
// registered from the extension factory are queued
// (`pendingProviderRegistrations`) and flushed into the ModelRuntime BEFORE
// model resolution, so the factory-time registration in index.ts already
// fixes the normal path. This module covers what the factory pass cannot
// see: project-layer-only accounts outside the launch directory, machines
// without a models-store cache, or an engine that flushes differently.
//
// On `session_start` for reasons that re-resolve the model ("startup",
// "new"), if the active model is not the configured default but the default
// resolves with usable auth, swap to it via `pi.setModel()`. That call also
// recomputes the thinking level with the engine's own precedence (per-model
// override → defaultThinkingLevel → keep current), so no manual level math
// is needed here. Deliberately skipped for "resume"/"fork" — those restore
// the session's own model, which is user intent, not a fallback.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { agentDir } from "./io.js";
import { ACCOUNT_PROVIDER_PREFIX } from "./types.js";

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

/** Local alias so the settings types stay self-contained in this module. */
type ThinkingLevelValue = (typeof THINKING_LEVELS)[number];

interface DefaultModelSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevelValue;
	modelThinkingLevels?: Record<string, ThinkingLevelValue>;
}

/**
 * CLI model overrides (`--model`, `-m`, `--provider`, `--thinking`) must win
 * over the reapply — the user asked for that model explicitly, even when it
 * differs from the saved default. Read per call so tests can toggle argv;
 * real argv never changes after launch.
 */
export function hasCliModelOverride(argv: readonly string[] = process.argv): boolean {
	return argv.some(
		(arg) =>
			arg === "--model" ||
			arg.startsWith("--model=") ||
			arg === "-m" ||
			arg === "--provider" ||
			arg.startsWith("--provider=") ||
			arg === "--thinking" ||
			arg.startsWith("--thinking="),
	);
}

function isThinkingLevel(value: unknown): value is ThinkingLevelValue {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function readSettingsLayer(path: string): Partial<DefaultModelSettings> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DefaultModelSettings>;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Settings cascade for the default-model lookup: agent-directory
 * `settings.json`, overridden by the project layer — the project layer only
 * counts for a trusted project (matches how the engine gates project
 * settings).
 */
export function readDefaultModelSettings(ctx: ExtensionContext): DefaultModelSettings {
	const global = readSettingsLayer(join(agentDir(), "settings.json"));
	const merged: DefaultModelSettings = {
		defaultProvider: typeof global.defaultProvider === "string" ? global.defaultProvider : undefined,
		defaultModel: typeof global.defaultModel === "string" ? global.defaultModel : undefined,
		defaultThinkingLevel: isThinkingLevel(global.defaultThinkingLevel)
			? global.defaultThinkingLevel
			: undefined,
		modelThinkingLevels:
			typeof global.modelThinkingLevels === "object" && global.modelThinkingLevels !== null
				? global.modelThinkingLevels
				: undefined,
	};
	if (!ctx.isProjectTrusted()) return merged;
	const project = readSettingsLayer(join(ctx.cwd, ".pi", "settings.json"));
	if (typeof project.defaultProvider === "string") merged.defaultProvider = project.defaultProvider;
	if (typeof project.defaultModel === "string") merged.defaultModel = project.defaultModel;
	if (isThinkingLevel(project.defaultThinkingLevel)) {
		merged.defaultThinkingLevel = project.defaultThinkingLevel;
	}
	if (typeof project.modelThinkingLevels === "object" && project.modelThinkingLevels !== null) {
		merged.modelThinkingLevels = {
			...merged.modelThinkingLevels,
			...project.modelThinkingLevels,
		};
	}
	return merged;
}

/**
 * Swap the active model to the configured default when the session started on
 * something else. Returns the applied model, or undefined when nothing was
 * changed (no default configured, reason not startup/new, CLI override,
 * scoped models, default already active, or the default does not resolve).
 */
export async function reapplyDefaultModel(
	pi: ExtensionAPI,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<Model<Api> | undefined> {
	if (event.reason !== "startup" && event.reason !== "new") return undefined;
	if (hasCliModelOverride()) return undefined;
	if (ctx.scopedModels.length > 0) return undefined;

	const settings = readDefaultModelSettings(ctx);
	const { defaultProvider, defaultModel } = settings;
	// Only when the configured default is one of OUR alias providers —
	// anything else is resolved natively by the engine and must not be
	// touched (this also keeps subagent/CLI model picks intact).
	if (!defaultProvider || !defaultProvider.startsWith(ACCOUNT_PROVIDER_PREFIX)) return undefined;
	if (!defaultModel) return undefined;

	const active = ctx.model;
	if (!active) return undefined;
	if (active.provider === defaultProvider && active.id === defaultModel) return undefined;
	// An active model on another alias provider is deliberate user intent
	// (e.g. an explicit CLI pick), not a core fallback — never clobber it.
	if (active.provider.startsWith(ACCOUNT_PROVIDER_PREFIX)) return undefined;

	const target = ctx.modelRegistry.find(defaultProvider, defaultModel);
	if (!target) return undefined;
	if (!ctx.modelRegistry.hasConfiguredAuth(target)) return undefined;

	try {
		const applied = await pi.setModel(target);
		if (!applied) return undefined;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`pi-openrouter-accounts: restored default model ${target.provider}/${target.id}`,
				"info",
			);
		}
		return target;
	} catch {
		/* best effort — never break session start */
		return undefined;
	}
}
