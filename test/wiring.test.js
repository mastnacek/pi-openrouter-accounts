import test from "node:test";
import assert from "node:assert/strict";

test("index.ts wires the command, the session hooks and the shutdown drain", async () => {
	const { default: extension } = await import("../index.js");

	const commands = new Map();
	const events = [];
	let unsubscribed = 0;
	const pi = {
		on(event) {
			events.push(event);
			return () => {
				unsubscribed += 1;
			};
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		unregisterProvider() {
			/* no alias registered in this test */
		},
	};

	extension(pi);

	assert.deepEqual(
		events,
		["session_start", "session_shutdown"],
		"session_start must register before the shutdown drainer",
	);

	const definition = commands.get("openrouter-accounts");
	assert.ok(definition, "the /openrouter-accounts command must be registered");
	assert.equal(typeof definition.handler, "function");
	assert.equal(typeof definition.getArgumentCompletions, "function");

	const items = definition.getArgumentCompletions("--global ");
	assert.ok(
		items?.some((i) => i.value === "--global add"),
		"the wiring must expose --global completions",
	);
});

test("session_start reapplies an alias default when the engine fell back to core", async () => {
	const { default: extension } = await import("../index.js");
	const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const root = mkdtempSync(join(tmpdir(), "pi-oa-reapply-"));
	const agent = join(root, "agent");
	mkdirSync(agent, { recursive: true });
	// defaultModel pointing at one of OUR aliases + no CLI override
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({
			defaultProvider: "openrouter-soukr",
			defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
			defaultThinkingLevel: "high",
		}),
		"utf8",
	);
	const savedArgv = process.argv;
	process.argv = ["pi"]; // no --model / -m / --provider / --thinking
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const target = { provider: "openrouter-soukr", id: "nvidia/nemotron-3-ultra-550b-a55b:free" };
		const active = { provider: "openrouter", id: "moonshotai/kimi-k2.6" };
		const setModelCalls = [];
		const notifications = [];
		const pi = {
			on() {
				return () => {};
			},
			registerCommand() {},
			unregisterProvider() {},
			setModel: async (model) => {
				setModelCalls.push(model);
				return true;
			},
		};
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			model: active,
			scopedModels: [],
			isProjectTrusted: () => false,
			modelRegistry: {
				find: (provider, id) => (provider === target.provider && id === target.id ? target : undefined),
				hasConfiguredAuth: (model) => model.provider === target.provider,
			},
			ui: { notify: (m) => notifications.push(m), setStatus() {} },
		};
		// Drive the registered session_start handler directly.
		const handlers = {};
		pi.on = (event, handler) => {
			handlers[event] = handler;
			return () => {};
		};
		extension(pi);
		await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);

		assert.equal(setModelCalls.length, 1, "the core fallback must be swapped to the alias default");
		assert.equal(setModelCalls[0].provider, target.provider);
		assert.equal(setModelCalls[0].id, target.id);
	} finally {
		process.argv = savedArgv;
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("session_start never clobbers an explicit alias pick or a native default", async () => {
	const { default: extension } = await import("../index.js");
	const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const root = mkdtempSync(join(tmpdir(), "pi-oa-reapply2-"));
	const agent = join(root, "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify({ defaultProvider: "openrouter-soukr", defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free" }),
		"utf8",
	);
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		const cases = [
			// already on the alias default
			{ provider: "openrouter-soukr", id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
			// deliberate pick on another alias
			{ provider: "openrouter-default", id: "z-ai/glm-5.3-flash" },
		];
		for (const active of cases) {
			const setModelCalls = [];
			const pi = {
				on(event, handler) {
					if (event === "session_start") handler({ type: "session_start", reason: "startup" }, ctx);
					return () => {};
				},
				registerCommand() {},
				unregisterProvider() {},
				setModel: async (model) => {
					setModelCalls.push(model);
					return true;
				},
			};
			const ctx = {
				cwd: process.cwd(),
				hasUI: false,
				model: active,
				scopedModels: [],
				isProjectTrusted: () => false,
				modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
				ui: { notify() {}, setStatus() {} },
			};
			extension(pi);
			assert.equal(setModelCalls.length, 0, `must not clobber ${active.provider}/${active.id}`);
		}
	} finally {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

test("a handler round-trip resolves the status subcommand without throwing", async () => {
	const { runCommand } = await import("../src/command.js");

	const notifications = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		modelRegistry: { getAll: () => [] },
		ui: {
			notify: (message) => notifications.push(message),
			setStatus() {},
		},
	};

	await runCommand({ unregisterProvider() {} }, ctx, "--global status");

	assert.equal(notifications.length, 1, "status must report once");
	assert.match(notifications[0], /global:/, "status must show the global layer path");
	assert.match(notifications[0], /project:/, "status must show the project layer path");
	assert.match(notifications[0], /\(--global\)/, "status must show which layer is written");
});
