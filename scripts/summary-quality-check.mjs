#!/usr/bin/env node
/**
 * summary-quality-check — offline structural smoke for `navigate_tree`
 * rewind summaries.
 *
 * Usage:
 *   node scripts/summary-quality-check.mjs <session.jsonl> [--all]
 *
 * The unit suite proves the summary *request* is shaped live-identically,
 * but it cannot prove the model's output is scope-clean. This script is the
 * second half of the live gate (see README "Live summary verification"):
 * run it on the session file produced by a real `rewind` and eyeball the
 * printed summary.
 *
 * A `branch_summary` entry is checked against one of two contracts:
 *
 * Modern work handoff (`details.treeNavigator` present). The stored summary is
 * `# Work handoff: <title>\n\n<own report>`, then (full-mode parents) the child
 * handoffs, then the continuity ledger. `treeNavigator.report` is the model's
 * own report (plus the file-ops appendix) and is the only text the r5d checks
 * apply to:
 *   - the metadata is a valid version-1 handoff record (malformed = fail);
 *   - the summary starts with the header and the exact own report, followed
 *     only by the sections the metadata announces;
 *   - the own report has no preamble before "## Goal" and the eight r5d
 *     headings in order (child handoff headings never count);
 *   - the own report is <= 4500 chars (r5d asks for "under about 4000"),
 *     unless `children` is non-empty: a parent has no fixed cap;
 *   - no leftover `{first}` placeholder anywhere in the summary.
 * Total handoff length (children and ledger included) is printed, not capped.
 *
 * Legacy summary (no `details.treeNavigator`): pi's standard preamble, then
 * the same r5d checks on the whole text, <= 4500 chars in total.
 *
 * It also prints the in-band summary turn's provider usage (#80: the
 * assistant entry appended right before the newest `branch_summary`, whose
 * `cacheRead` is the cache evidence) and the newest `navigate-tree-rewind`
 * continuation message's `details`.
 *
 * Scope is deliberately NOT asserted here: "describes only the collapsed
 * branch, background excluded, work not continued" needs a reader. The
 * script prints the full summary for that eyeball check.
 *
 * Exit code: 0 = all checked summaries pass; 1 = a check failed or no
 * `branch_summary` entry was found.
 */

import { readFileSync } from "node:fs";
import { getHandoff } from "../extensions/navigate-tree/handoff.ts";

/** pi's `BRANCH_SUMMARY_PREAMBLE`, prepended to every legacy stored summary. */
const PREAMBLE =
	"The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

const HEADINGS = [
	"## Goal",
	"## Constraints & Preferences",
	"## Progress",
	"### Done",
	"### In Progress",
	"### Blocked",
	"## Key Decisions",
	"## Next Steps",
];

const MAX_REPORT_CHARS = 4500;

// Section markers written by `materializeHandoff` / `appendContinuityBriefing`.
const CHILD_HANDOFFS_MARK = "\n\n---\n\n## Child handoffs in chronological order\n\n";
const LEDGER_MARK = "\n\n## Continuity ledger\n\n[navigate_tree continuity ledger rev ";

function fail(message) {
	console.error(`FAIL  ${message}`);
	return false;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The r5d content checks, shared by legacy summaries and modern own reports.
 * @param {string} text model text: no preamble before "## Goal", headings in order, no `{first}`
 * @param {string} label entry id for messages
 * @param {string} subject what `text` is, for messages
 * @returns {boolean}
 */
function checkReportText(text, label, subject) {
	let ok = true;
	const firstHeading = text.indexOf("## Goal");
	if (firstHeading === -1) {
		ok = fail(`${label}: ${subject} has no "## Goal" heading`) && ok;
	} else if (text.slice(0, firstHeading).trim().length > 0) {
		ok = fail(
			`${label}: model preamble/commentary before "## Goal" in ${subject}: ${JSON.stringify(
				text.slice(0, firstHeading).trim().slice(0, 120),
			)}`,
		);
	}
	let cursor = -1;
	for (const heading of HEADINGS) {
		const at = text.indexOf(heading);
		if (at === -1) {
			ok = fail(`${label}: ${subject} is missing heading "${heading}"`) && ok;
		} else if (at < cursor) {
			ok = fail(`${label}: ${subject} has heading "${heading}" out of order`) && ok;
		} else {
			cursor = at;
		}
	}
	if (text.includes("{first}")) {
		ok = fail(`${label}: unresolved "{first}" placeholder in ${subject}`) && ok;
	}
	return ok;
}

/** A pre-handoff summary: pi's preamble, the model text and the file-ops appendix. */
function checkLegacySummary(summary, label) {
	let ok = true;
	const body = summary.startsWith(PREAMBLE) ? summary.slice(PREAMBLE.length) : summary;
	if (summary.startsWith(PREAMBLE)) {
		console.log(`ok    ${label}: standard preamble present`);
	} else {
		ok = fail(`${label}: missing pi summary preamble`) && ok;
	}
	ok = checkReportText(body, label, "summary") && ok;
	if (summary.length > MAX_REPORT_CHARS) {
		ok = fail(
			`${label}: legacy summary ${summary.length} chars > ${MAX_REPORT_CHARS} (r5d target ~4000)`,
		);
	} else {
		console.log(`ok    ${label}: legacy summary ${summary.length} chars`);
	}
	return ok;
}

/**
 * @param {string} summary stored `branch_summary.summary`
 * @param {object} meta valid `details.treeNavigator` record
 * @param {Set<string>} knownIds ids of the session's `branch_summary` entries
 * @param {string} label entry id for messages
 */
function checkHandoff(summary, meta, knownIds, label) {
	const report = meta.report;
	const children = meta.children;
	let ok = checkReportText(report, label, "own report");

	if (children.length === 0) {
		if (report.length > MAX_REPORT_CHARS) {
			ok = fail(
				`${label}: own report ${report.length} chars > ${MAX_REPORT_CHARS} (r5d target ~4000; no child handoffs, so the cap applies; total handoff ${summary.length} chars)`,
			);
		} else {
			console.log(`ok    ${label}: own report ${report.length} chars (cap ${MAX_REPORT_CHARS})`);
		}
	} else {
		console.log(
			`ok    ${label}: own report ${report.length} chars (no fixed cap: parent of ${children.length} child handoff${children.length === 1 ? "" : "s"})`,
		);
		const unknown = children.filter((id) => !knownIds.has(id));
		if (unknown.length > 0) {
			ok = fail(
				`${label}: metadata.children names no branch_summary entry in this session: ${unknown.join(", ")}`,
			);
		}
	}

	const own = `# Work handoff: ${meta.title}\n\n${report}`;
	if (!summary.startsWith(own)) {
		return fail(
			`${label}: summary does not start with "# Work handoff: ${meta.title}" plus metadata.report (total handoff ${summary.length} chars)`,
		);
	}
	const rest = summary.slice(own.length);
	const ledgerAt = rest.lastIndexOf(LEDGER_MARK);
	const childPart = ledgerAt < 0 ? rest : rest.slice(0, ledgerAt);
	const ledgerPart = ledgerAt < 0 ? "" : rest.slice(ledgerAt);
	if (meta.mode === "full" && children.length > 0) {
		if (!childPart.startsWith(CHILD_HANDOFFS_MARK)) {
			ok =
				fail(
					`${label}: metadata lists ${children.length} children (mode full) but no "## Child handoffs" section follows the own report`,
				) && ok;
		}
	} else if (childPart.length > 0) {
		ok =
			fail(
				`${label}: ${childPart.length} unexpected chars after the own report: ${JSON.stringify(childPart.trim().slice(0, 120))}`,
			) && ok;
	}
	if (summary.includes("{first}") && !report.includes("{first}")) {
		ok = fail(`${label}: unresolved "{first}" placeholder outside the own report`) && ok;
	}
	console.log(
		`info  ${label}: total handoff ${summary.length} chars = header+own report ${own.length} + child handoffs ${childPart.length} + continuity ledger ${ledgerPart.length} (no cap on the total)`,
	);
	return ok;
}

/**
 * @param {object} entry `branch_summary` session entry
 * @param {Set<string>} knownIds ids of the session's `branch_summary` entries
 * @param {string} label entry id for messages
 * @returns {boolean}
 */
function checkSummary(entry, knownIds, label) {
	const summary = entry.summary;
	if (typeof summary !== "string" || summary.trim().length === 0) {
		return fail(`${label}: empty summary`);
	}
	if (!isRecord(entry.details) || !("treeNavigator" in entry.details)) {
		return checkLegacySummary(summary, label);
	}
	const handoff = getHandoff(entry);
	if (!handoff) {
		return fail(`${label}: malformed details.treeNavigator metadata`);
	}
	console.log(`ok    ${label}: work handoff metadata valid (mode ${handoff.mode})`);
	return checkHandoff(summary, handoff, knownIds, label);
}

function main() {
	const args = process.argv.slice(2);
	const all = args.includes("--all");
	const file = args.find((a) => !a.startsWith("--"));
	if (!file) {
		console.error("usage: node scripts/summary-quality-check.mjs <session.jsonl> [--all]");
		process.exit(2);
	}

	const entries = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

	const summaries = entries.filter((e) => e.type === "branch_summary");
	if (summaries.length === 0) {
		console.error(`FAIL  no branch_summary entry in ${file}`);
		process.exit(1);
	}

	const lastSummaryIndex = entries.lastIndexOf(summaries[summaries.length - 1]);
	let summaryTurn = null;
	for (let i = lastSummaryIndex - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message?.role === "assistant") {
			summaryTurn = e;
			break;
		}
	}
	if (summaryTurn?.message?.usage) {
		const u = summaryTurn.message.usage;
		console.log(
			`summary turn usage ${JSON.stringify({ input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output })}`,
		);
	} else {
		console.log("summary turn usage (no assistant entry before the newest branch_summary)");
	}
	const continuations = entries.filter(
		(e) => e.type === "custom_message" && e.customType === "navigate-tree-rewind",
	);
	if (continuations.length > 0) {
		console.log(`continuation ${JSON.stringify(continuations[continuations.length - 1].details)}`);
	} else {
		console.log("continuation (no navigate-tree-rewind message found in this session)");
	}

	const checked = all ? summaries : [summaries[summaries.length - 1]];
	const knownIds = new Set(summaries.map((entry) => entry.id));
	let ok = true;
	for (const entry of checked) {
		const label = `branch_summary ${String(entry.id ?? "?").slice(0, 8)}`;
		ok = checkSummary(entry, knownIds, label) && ok;
	}

	console.log(
		"--- summary text (eyeball scope: branch only, background excluded, work not continued) ---",
	);
	for (const entry of checked) {
		console.log(entry.summary);
		console.log("--- end ---");
	}
	process.exit(ok ? 0 : 1);
}

main();
