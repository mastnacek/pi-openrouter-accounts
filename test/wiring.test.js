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
