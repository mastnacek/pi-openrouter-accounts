import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompletions } from "../src/completions.js";
import { loadConfig, saveConfig, targetConfigPath } from "../src/io.js";

const GLOBAL_FILE = "openrouter-accounts.json";
const values = (items) => (items ?? []).map((i) => i.value);
const labels = (items) => (items ?? []).map((i) => i.label);

/** Temp agent dir (global layer) + temp project dir (project layer). */
function makeDirs() {
	const root = mkdtempSync(join(tmpdir(), "pi-oa-"));
	const agent = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(agent, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	return { root, agent, project };
}

function writeAccounts(file, accounts) {
	writeFileSync(file, JSON.stringify({ accounts }, null, 2), "utf8");
}

/** Isolate the cascade env for one test and restore it afterwards. */
function withEnv(fn) {
	const savedAgent = process.env.PI_CODING_AGENT_DIR;
	const savedOverride = process.env.PI_OPENROUTER_ACCOUNTS;
	delete process.env.PI_OPENROUTER_ACCOUNTS;
	try {
		return fn();
	} finally {
		if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgent;
		if (savedOverride === undefined) delete process.env.PI_OPENROUTER_ACCOUNTS;
		else process.env.PI_OPENROUTER_ACCOUNTS = savedOverride;
	}
}

test("first level offers --global as a non-terminal row", () => {
	const items = getCompletions("", "/nonexistent-cwd");
	const row = items.find((i) => i.label === "--global");
	assert.ok(row, "--global row missing");
	assert.equal(row.value, "--global ", "non-terminal rows must end with a space");
});

test("bare --global returns just the flag row", () => {
	const items = getCompletions("--global", "/nonexistent-cwd");
	assert.deepEqual(values(items), ["--global "]);
});

test("--global prefix remaps every child value and never nests", () => {
	const items = getCompletions("--global ", "/nonexistent-cwd");
	assert.ok(items.length > 0);
	for (const item of items) {
		assert.ok(item.value.startsWith("--global "), `unprefixed value: ${item.value}`);
		assert.ok(!item.value.slice(8).startsWith("--global"), `nested flag: ${item.value}`);
	}
	const add = items.find((i) => i.label === "add");
	assert.equal(add.value, "--global add", "terminal leaf keeps no trailing space");
	const edit = items.find((i) => i.label === "edit");
	assert.equal(edit.value, "--global edit ", "non-terminal leaf keeps its trailing space");
});

test("cascade merges global then project, project winning on a shared id", () => {
	const { root, agent, project } = makeDirs();
	try {
		withEnv(() => {
			process.env.PI_CODING_AGENT_DIR = agent;
			writeAccounts(join(agent, GLOBAL_FILE), [
				{ id: "work", label: "Work" },
				{ id: "shared", label: "Global shared" },
			]);
			writeAccounts(join(project, ".pi", GLOBAL_FILE), [
				{ id: "personal", label: "Personal" },
				{ id: "shared", label: "Project shared" },
			]);

			const merged = loadConfig(project).accounts;
			assert.deepEqual(merged.map((a) => a.id).sort(), ["personal", "shared", "work"]);
			assert.equal(
				merged.find((a) => a.id === "shared").label,
				"Project shared",
				"project layer must override the global account with the same id",
			);

			const items = getCompletions("--global edit ", project);
			assert.deepEqual(labels(items).sort(), ["personal", "shared", "work"]);
			for (const item of items) {
				assert.ok(item.value.startsWith("--global edit "));
				assert.ok(!item.value.endsWith(" "), "account id is a terminal leaf");
			}
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saveConfig writes the layer selected by --global", () => {
	const { root, agent, project } = makeDirs();
	try {
		withEnv(() => {
			process.env.PI_CODING_AGENT_DIR = agent;
			const config = { accounts: [{ id: "x", label: "X" }] };

			const globalPath = saveConfig(config, true, project);
			const projectPath = saveConfig(config, false, project);

			assert.equal(globalPath, join(agent, GLOBAL_FILE));
			assert.equal(projectPath, join(project, ".pi", GLOBAL_FILE));
			assert.equal(targetConfigPath(project, true), globalPath);
			assert.equal(targetConfigPath(project, false), projectPath);
			assert.deepEqual(loadConfig(project).accounts.map((a) => a.id), ["x"]);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("PI_OPENROUTER_ACCOUNTS overrides the whole cascade", () => {
	const { root, agent, project } = makeDirs();
	try {
		withEnv(() => {
			process.env.PI_CODING_AGENT_DIR = agent;
			writeAccounts(join(agent, GLOBAL_FILE), [{ id: "global-only" }]);
			const override = join(root, "override.json");
			writeAccounts(override, [{ id: "from-env" }]);
			process.env.PI_OPENROUTER_ACCOUNTS = override;

			assert.deepEqual(loadConfig(project).accounts.map((a) => a.id), ["from-env"]);
			assert.equal(saveConfig({ accounts: [] }, false, project), override);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("no state markers or ANSI escapes leak into completion values", () => {
	for (const items of [getCompletions("", "/nonexistent-cwd"), getCompletions("--global ", "/nonexistent-cwd")]) {
		for (const item of items ?? []) {
			assert.ok(!/\u001b/.test(item.value), `ANSI in ${item.value}`);
			assert.ok(!/[✓●○]/.test(item.value), `marker in ${item.value}`);
		}
	}
});
