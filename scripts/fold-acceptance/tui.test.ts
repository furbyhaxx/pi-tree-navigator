import { it } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asFetch } from "../fetch.ts";
import { launchTui, parseTuiOptions } from "./tui.ts";

it("validates a native TUI plan without runtime, network, auth, ledger or terminal calls", async () => {
	const root = mkdtempSync(join(tmpdir(), "fold-tui-dry-"));
	const previousFetch = globalThis.fetch;
	let requests = 0;
	let launches = 0;
	globalThis.fetch = asFetch(async () => {
		requests++;
		throw new Error("Network is forbidden in this test");
	});
	try {
		const out = join(root, "evidence");
		const ledger = join(root, "shared-ledger.jsonl");
		const options = parseTuiOptions([
			"--out",
			out,
			"--ledger",
			ledger,
			"--auth-dir",
			join(root, "missing-auth"),
			"--width",
			"60",
			"--mode",
			"regular",
			"--theme",
			"light",
			"--dry-run",
		]);
		await launchTui(options, () => {
			launches++;
		});
		assert.equal(requests, 0);
		assert.equal(launches, 0);
		assert.equal(existsSync(ledger), false);
		assert.equal(existsSync(`${ledger}.lock`), false);
		assert.equal(existsSync(join(out, "scratch")), false);
		const original = readFileSync(join(out, "launch.json"));
		const plan = JSON.parse(original.toString());
		assert.equal(plan.settings.compaction.enabled, false);
		assert.equal(plan.settings.cacheWarming, "off");
		assert.equal(plan.navigator.continuity.capture, false);
		assert.equal(plan.contextWindow, 96000);
		assert.equal(plan.maxTokens, 8192);
		assert.equal(plan.capUsd, 25);
		assert.ok(plan.command.includes("--no-extensions"));
		assert.equal(plan.bootstrapPrompt, "Reply READY only; do not fold or call tools");
		assert.equal(plan.command.includes(plan.bootstrapPrompt), false);
		const fixture = JSON.parse(readFileSync(join(out, "fixture.json"), "utf8"));
		assert.equal(fixture.corpus.length, 15);
		await assert.rejects(launchTui(options), /EEXIST/u);
		assert.deepEqual(readFileSync(join(out, "launch.json")), original);
		assert.throws(
			() => parseTuiOptions(["--out", out, "--ledger", "relative.jsonl", "--dry-run"]),
			/absolute shared/u,
		);
	} finally {
		globalThis.fetch = previousFetch;
		rmSync(root, { recursive: true, force: true });
	}
});
