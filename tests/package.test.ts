// Every runtime import of the shipped extension is a peer dependency (pi
// provides it), and the dev copies are pinned to the pi the tests run against.

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

/** Package names imported by the shipped (non-test) sources. */
function shippedImports(): Set<string> {
	const names = new Set<string>();
	for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
		if (!file.endsWith(".ts")) continue;
		const source = readFileSync(join(src, file), "utf8");
		for (const match of source.matchAll(/from "([^"./][^"]*)"/g)) {
			const spec = match[1];
			if (spec === undefined || spec.startsWith("node:")) continue;
			names.add(
				spec
					.split("/")
					.slice(0, spec.startsWith("@") ? 2 : 1)
					.join("/"),
			);
		}
	}
	return names;
}

describe("package.json dependencies", () => {
	it("every package the shipped sources import is a peer dependency", () => {
		const peers = pkg.peerDependencies ?? {};
		for (const name of shippedImports()) {
			assert.ok(name in peers, `${name} must be a peerDependency`);
		}
	});

	it("@earendil-works peers share one range", () => {
		const ranges = Object.entries(pkg.peerDependencies ?? {})
			.filter(([name]) => name.startsWith("@earendil-works/"))
			.map(([, range]) => range);
		assert.ok(ranges.length > 0);
		assert.deepEqual(new Set(ranges), new Set(["*"]));
	});

	it("pi dev copies are pinned to one version (the one pi-coding-agent resolves to)", () => {
		const resolved = (name: string) =>
			(
				JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")) as {
					version: string;
				}
			).version;
		const agent = resolved("@earendil-works/pi-coding-agent");
		for (const name of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			assert.equal(pkg.devDependencies?.[name], agent, name);
			assert.equal(resolved(name), agent, name);
		}
	});
});
