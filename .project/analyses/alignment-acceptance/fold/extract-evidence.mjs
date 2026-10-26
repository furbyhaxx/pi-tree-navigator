/**
 * Summarises one fold-acceptance run directory: calls, fold receipts,
 * provider-reported usage and the post-fold continuation.
 *
 * Usage: node extract-evidence.mjs <run-dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const readJsonl = (path) =>
	readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
const maybe = (name) => {
	try {
		return JSON.parse(readFileSync(join(dir, name), "utf8"));
	} catch {
		return undefined;
	}
};
const textOf = (message) =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? [])
				.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
				.join("\n");

const result = maybe("result.json");
const abstained = maybe("abstained.json");
const failure = maybe("failure.json");
const calls = maybe("calls.jsonl") ?? readJsonl(join(dir, "calls.jsonl"));
const wire = readJsonl(join(dir, "wire.jsonl"));
const sessions = readdirSync(join(dir, "sessions"));
const entries = readJsonl(join(dir, "sessions", sessions[0]));

const branchSummaries = entries.filter((entry) => entry.type === "branch_summary");
const compactions = entries.filter((entry) => entry.type === "compaction");
const receipts = entries
	.filter((entry) => entry.type === "custom_message")
	.map((entry) => ({ customType: entry.customType, details: entry.details }));
const assistants = entries
	.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
	.map((entry, index) => ({
		index,
		provider: entry.message.provider,
		model: entry.message.model,
		stopReason: entry.message.stopReason,
		usage: entry.message.usage,
		length: textOf(entry.message).length,
		marker: textOf(entry.message).includes("ACCEPTANCE-CONTINUED"),
	}));

const out = {
	run: dir,
	outcome: failure ? "failed" : abstained ? "abstained" : result ? "passed" : "unknown",
	failure: failure?.error,
	abstainReason: abstained?.reason,
	initialTokens: result?.initialTokens,
	afterTokens: result?.afterTokens,
	budget: result
		? {
				spentBeforeUsd: result.beforeBudget?.spentUsd,
				spentAfterUsd: result.afterBudget?.spentUsd,
				deltaUsd:
					result.afterBudget && result.beforeBudget
						? Number(
								(
									result.afterBudget.spentUsd -
									result.beforeBudget.spentUsd
								).toFixed(9),
							)
						: undefined,
				heldUsd: result.afterBudget?.heldUsd,
			}
		: abstained?.budget,
	calls: calls.map((call) => `${call.api}:${call.model}:side=${call.side}`),
	wire: {
		requests: wire.length,
		statuses: wire.map((record) => `${record.endpoint}:${record.model}:${record.httpStatus}`),
		costs: wire.map((record) => record.settlement),
	},
	branchSummaries: branchSummaries.map((entry) => ({
		stats: entry.details?.treeNavigator?.stats,
		sourceIds: entry.details?.treeNavigator?.sourceIds?.length,
		reportChars: entry.details?.treeNavigator?.report?.length,
	})),
	compactions: compactions.map((entry) => ({
		id: entry.id,
		tokensBefore: entry.tokensBefore,
		firstKeptEntryId: entry.firstKeptEntryId,
	})),
	receipts,
	assistantMessages: assistants.filter((message) => message.provider !== "fixture"),
	postFoldContinuation: (() => {
		const at =
			branchSummaries.length > 0
				? entries.findIndex((entry) => entry.type === "branch_summary")
				: compactions.length > 0
					? entries.findIndex((entry) => entry.type === "compaction")
					: -1;
		if (at < 0) return undefined;
		const after = entries
			.slice(at + 1)
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
		const last = after.at(-1);
		return last
			? {
					count: after.length,
					stopReason: last.message.stopReason,
					usage: last.message.usage,
					marker: textOf(last.message).includes("ACCEPTANCE-CONTINUED"),
					text: textOf(last.message).slice(0, 600),
				}
			: { count: 0 };
	})(),
};
console.log(JSON.stringify(out, null, 2));
