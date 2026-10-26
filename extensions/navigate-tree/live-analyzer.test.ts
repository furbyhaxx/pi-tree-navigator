import { it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const script = fileURLToPath(new URL("../../scripts/analyze-live-navigator.mjs", import.meta.url));
const instruction = "[navigate_tree]\nSummarize only messages 1 onwards";

function analyze(
	payload: Record<string, unknown>,
	requestPosition = "before",
	wireMode = "normal",
) {
	const root = mkdtempSync(join(tmpdir(), "navigator-analysis-"));
	try {
		const base = join(root, "agent-1");
		mkdirSync(base);
		const entries: Record<string, unknown>[] = [];
		const append = (entry: Record<string, unknown>) =>
			entries.push({ parentId: entries.at(-1)?.id ?? null, ...entry });
		for (let i = 0; i < 4; i++) {
			const request = {
				type: "custom_message",
				id: `request-${i}`,
				timestamp: new Date(i * 10_000 + 1_000).toISOString(),
				content: instruction,
				customType: "navigate-tree-summary-request",
				details: { toolCallId: `call-${i}`, newLabel: `fold-${i}` },
			};
			append({
				type: "message",
				id: `previous-${i}`,
				message: { role: "assistant", usage: { input: 1000 } },
			});
			if (requestPosition !== "after") append(request);
			if (requestPosition === "cancelled")
				append({
					type: "custom",
					id: `outcome-${i}`,
					customType: "navigate-tree-rewind-outcome",
					data: { toolCallId: `call-${i}`, status: "aborted" },
				});
			append({
				type: "message",
				id: `writer-${i}`,
				message: { role: "assistant", usage: { input: 100, cacheRead: 1000 } },
			});
			append({
				type: "branch_summary",
				id: `summary-${i}`,
				timestamp: new Date(i * 10_000 + 3_000).toISOString(),
				summary: `hash-${i}`,
				details: {
					treeNavigator: { report: "Report" },
					continuity: {
						items: [
							{
								kind: "rule",
								source: { origin: "user" },
								status: "active",
								text: "never edit the source",
							},
						],
					},
				},
			});
			append({
				type: "custom_message",
				id: `fold-${i}`,
				customType: "navigate-tree-rewind",
				details: {
					status: "done",
					summaryId: `summary-${i}`,
					newLabel: `fold-${i}`,
				},
			});
			append({
				type: "message",
				id: `next-${i}`,
				message: { role: "assistant", content: [], usage: { input: 100 } },
			});
			if (requestPosition === "after") append(request);
		}
		writeFileSync(
			join(base, "session.jsonl"),
			entries.map((entry) => JSON.stringify(entry)).join("\n"),
		);
		writeFileSync(
			join(base, "outcome.json"),
			JSON.stringify({
				submitted: true,
				userMessages: 1,
				extensionErrors: [],
				peakInputTokens: 1100,
			}),
		);
		writeFileSync(
			join(root, "corpus-manifest.json"),
			JSON.stringify({
				partitions: [0, 1, 2, 3].map((i) => ({ sha256: `hash-${i}` })),
			}),
		);
		writeFileSync(
			join(base, "wire.jsonl.gz"),
			gzipSync(
				Array.from({ length: 4 }, (_, i) =>
					JSON.stringify({
						type: "request",
						at: new Date((wireMode === "first-only" ? 0 : i * 10_000) + 2_000).toISOString(),
						payload,
					}),
				).join("\n"),
			),
		);
		return spawnSync(process.execPath, [script, root, "--require-text-only"], {
			encoding: "utf8",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

it("recognizes text-only summary evidence for Responses, Anthropic and Google", () => {
	for (const payload of [
		{ input: [{ content: instruction }], tool_choice: "none" },
		{
			messages: [{ content: [{ text: instruction }] }],
			tool_choice: { type: "none" },
		},
		{
			contents: [{ parts: [{ text: instruction }] }],
			config: { toolConfig: { functionCallingConfig: { mode: "NONE" } } },
		},
	]) {
		const result = analyze(payload);
		assert.equal(result.status, 0, result.stdout + result.stderr);
	}
});

it("fails when request capture cannot establish a text-only request for every fold", () => {
	const missing = analyze({ contents: [{ parts: [{ text: "unrelated" }] }] });
	assert.equal(missing.status, 1, missing.stdout + missing.stderr);
	assert.match(missing.stdout, /summary request capture incomplete/);
	const enabled = analyze({
		contents: [{ parts: [{ text: instruction }] }],
		config: { toolConfig: { functionCallingConfig: { mode: "AUTO" } } },
	});
	assert.equal(enabled.status, 1, enabled.stdout + enabled.stderr);
	assert.match(enabled.stdout, /did not disable tools/);
});

it("requires matching wire evidence within each fold interval, not aggregate retries", () => {
	const repeated = analyze(
		{ input: [{ content: instruction }], tool_choice: "none" },
		"before",
		"first-only",
	);
	assert.equal(repeated.status, 1, repeated.stdout + repeated.stderr);
	assert.match(repeated.stdout, /fold-1: summary wire request missing/);
	const mismatched = analyze({
		input: [{ content: `${instruction} with a different focus` }],
		tool_choice: "none",
	});
	assert.equal(mismatched.status, 1, mismatched.stdout + mismatched.stderr);
	assert.match(mismatched.stdout, /summary wire request missing/);
});

it("does not correlate a later or aborted same-label request with a completed fold", () => {
	for (const position of ["after", "cancelled"]) {
		const result = analyze({ input: [{ content: instruction }], tool_choice: "none" }, position);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /summary request missing/);
	}
});
