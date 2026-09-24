import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const PEERS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
];

test("manifest keeps the pi package contract", () => {
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
	for (const peer of PEERS) {
		assert.equal(
			manifest.peerDependencies?.[peer],
			"*",
			`${peer} must be a wildcard peer dependency`,
		);
		assert.ok(!(manifest.dependencies ?? {})[peer], `${peer} must not be a runtime dependency`);
	}
});

test("published files cover every source module", () => {
	const shipped = manifest.files ?? [];
	assert.ok(shipped.includes("index.ts"), "index.ts must ship");
	assert.ok(
		shipped.includes("src"),
		"the src/ directory must ship or the installed package cannot resolve ./src/*.js",
	);
	const modules = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
	assert.ok(modules.length > 0, "no src modules found");
});

test("every relative import in index.ts exists inside the published tree", () => {
	const source = readFileSync(join(root, "index.ts"), "utf8");
	const imports = [...source.matchAll(/from "(\.\/[^"]+)"/g)].map((m) => m[1]);
	assert.ok(imports.length > 0, "index.ts should import its src modules");
	for (const spec of imports) {
		const rel = spec.replace(/^\.\//, "").replace(/\.js$/, ".ts");
		assert.ok(existsSync(join(root, rel)), `unshippable import: ${rel}`);
	}
});
