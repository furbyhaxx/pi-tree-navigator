import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** How a completed parent carries its children's reports into model context. */
export type HandoffMode = "full" | "synthesized" | "digest";

/** Recorded inclusive usage of unique source entries, not new billing. */
export interface HandoffStats {
	readonly messages: number;
	readonly toolCalls: number;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly usageRecords: number;
}

/** Persisted report metadata; children are references to real summary entry IDs. */
export interface HandoffData {
	readonly version: 1;
	readonly name: string;
	readonly title: string;
	readonly goal: string;
	readonly outcome: string;
	readonly report: string;
	readonly mode: HandoffMode;
	readonly children: readonly string[];
	readonly sourceIds: readonly string[];
	readonly stats: HandoffStats;
}

/** A chronological containment node, distinct from conversation ancestry. */
export interface HistoryGroup {
	readonly name: string;
	readonly title: string;
	readonly entryId: string;
	readonly startId: string;
	readonly state: "folded" | "open";
	readonly sourceIds: readonly string[];
	readonly children: readonly HistoryGroup[];
}

/** Persisted outline of one converted session. Navigation always uses real entry IDs. */
export interface HistoryManifest {
	readonly version: 1;
	readonly sourceOrder: readonly string[];
	readonly groups: readonly HistoryGroup[];
}

const LEGACY_PREAMBLE =
	"The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

/** Remove the old alternative-branch claim without changing the report body. */
export function stripHandoffPreamble(text: string): string {
	return text.startsWith(LEGACY_PREAMBLE) ? text.slice(LEGACY_PREAMBLE.length) : text;
}

/** Sum each source entry once, including nested-tool and compaction usage. */
export function handoffStats(entries: readonly SessionEntry[]): HandoffStats {
	const result = {
		messages: 0,
		toolCalls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		usageRecords: 0,
	};
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (entry.type === "message") {
			result.messages++;
			if (entry.message.role === "assistant")
				result.toolCalls += entry.message.content.filter(
					(block) => block.type === "toolCall",
				).length;
		}
		const usage =
			entry.type === "message" &&
			(entry.message.role === "assistant" || entry.message.role === "toolResult")
				? entry.message.usage
				: entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: undefined;
		if (!usage) continue;
		result.usageRecords++;
		result.input += usage.input ?? 0;
		result.output += usage.output ?? 0;
		result.cacheRead += usage.cacheRead ?? 0;
		result.cacheWrite += usage.cacheWrite ?? 0;
		result.cost += usage.cost?.total ?? 0;
	}
	return result;
}

const OUTCOME_HEADINGS = [
	"outcome",
	"done",
	"delivered",
	"decisions and outcome",
	"decisions and delivered state",
	"delivered and final state",
	"done/delivered",
];

function section(report: string, headings: readonly string[]): string {
	const lines = report.split("\n");
	for (const [i, line] of lines.entries()) {
		const heading = line
			.replace(/^#+\s*/, "")
			.trim()
			.toLowerCase();
		if (!headings.includes(heading)) continue;
		const body: string[] = [];
		for (const line of lines.slice(i + 1)) {
			if (/^#+\s/.test(line)) break;
			body.push(line);
		}
		const text = body
			.join(" ")
			.replace(/\s+/g, " ")
			.replace(/^\s*-\s*(?:\[x\]\s*)?/, "")
			.trim();
		if (text) return text;
	}
	for (const heading of headings) {
		const line = lines.find((line) => line.toLowerCase().startsWith(`- **${heading}:**`));
		if (line) return line.slice(line.indexOf("**", 4) + 2).trim();
	}
	return "Not recorded separately; see the full handoff.";
}

/** Build display and accounting metadata from a reviewed report. */
export function makeHandoff(options: {
	name: string;
	title?: string;
	goal?: string;
	outcome?: string;
	report: string;
	mode: HandoffMode;
	children: readonly string[];
	sourceEntries: readonly SessionEntry[];
}): HandoffData {
	const report = stripHandoffPreamble(options.report);
	return {
		version: 1,
		name: options.name,
		title: options.title ?? options.name.replaceAll("-", " "),
		goal: options.goal ?? section(report, ["goal", "goal/scope"]),
		outcome: options.outcome ?? section(report, OUTCOME_HEADINGS),
		report,
		mode: options.mode,
		children: [...options.children],
		sourceIds: [...new Set(options.sourceEntries.map((entry) => entry.id))],
		stats: handoffStats(options.sourceEntries),
	};
}

function digestLine(child: {
	id: string;
	summary: string;
	handoff?: HandoffData | undefined;
}): string {
	const bounded = (value: string, limit: number): string => {
		const clean = value
			.replace(/\p{Cc}/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
		return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
	};
	const own =
		stripHandoffPreamble(child.summary).split(
			/^## (?:Child handoffs in chronological order|Earlier handoffs in this span \(digest\))/m,
		)[0] ?? "";
	const title = child.handoff?.title ?? own.match(/^# Work handoff:\s*(.+)$/m)?.[1] ?? "";
	const goal = child.handoff?.goal ?? section(own, ["goal", "goal/scope"]);
	const outcome = child.handoff?.outcome ?? section(own, OUTCOME_HEADINGS);
	const fields = [
		bounded(title, 40),
		...[
			["goal", goal],
			["outcome", outcome],
		].flatMap(([label, value]) =>
			value && value !== "Not recorded separately; see the full handoff."
				? [`${label}: ${bounded(value, 55)}`]
				: [],
		),
		`entry ${bounded(child.id, 60)}`,
	].filter(Boolean);
	return `- ${fields.join(" · ")}`;
}

/** Materialize a frozen context policy; each child is inserted once in supplied chronological order. */
export function materializeHandoff(
	data: HandoffData,
	children: readonly { id: string; summary: string; handoff?: HandoffData | undefined }[],
): string {
	const own = `# Work handoff: ${data.title}\n\n${data.report}`;
	if (data.mode === "synthesized" || !children.length) return own;
	const seen = new Set<string>();
	const unique = children.filter((child) => !seen.has(child.id) && Boolean(seen.add(child.id)));
	if (data.mode === "digest")
		return `${own}\n\n## Earlier handoffs in this span (digest)\n\nThese completed phases are folded into the report above. Full reports remain in the session history (/anchor tree).\n${unique.map(digestLine).join("\n")}`;
	const reports = unique.map((child) => stripHandoffPreamble(child.summary));
	return `${own}\n\n---\n\n## Child handoffs in chronological order\n\nThese are historical reports at each child's completion. The parent report above records the later outcome and superseding decisions.\n\n${reports.join("\n\n---\n\n")}`;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHandoff(value: unknown): value is HandoffData {
	if (
		!record(value) ||
		value["version"] !== 1 ||
		(value["mode"] !== "full" && value["mode"] !== "synthesized" && value["mode"] !== "digest")
	)
		return false;
	for (const key of ["name", "title", "goal", "outcome", "report"])
		if (typeof value[key] !== "string") return false;
	if (
		!Array.isArray(value["children"]) ||
		!value["children"].every((id) => typeof id === "string") ||
		!Array.isArray(value["sourceIds"]) ||
		!value["sourceIds"].every((id) => typeof id === "string") ||
		!record(value["stats"])
	)
		return false;
	for (const key of [
		"messages",
		"toolCalls",
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cost",
		"usageRecords",
	])
		if (typeof value["stats"][key] !== "number" || !Number.isFinite(value["stats"][key]))
			return false;
	return true;
}

/** Read extension-owned metadata; unknown or malformed versions are left to native rendering. */
export function getHandoff(entry: SessionEntry): HandoffData | undefined {
	if (entry.type !== "branch_summary" || !record(entry.details)) return undefined;
	return validHandoff(entry.details["treeNavigator"]) ? entry.details["treeNavigator"] : undefined;
}

/** Change only projected navigator handoffs, preserving omissions and message ordering. */
export function handoffContext(
	entry: SessionEntry | null,
	messages: AgentMessage[],
	legacyNavigatorOwned = false,
): AgentMessage[] {
	if (!entry || (!getHandoff(entry) && !legacyNavigatorOwned)) return messages;
	return messages.map((message) =>
		message.role === "branchSummary"
			? {
					role: "custom" as const,
					customType: "navigate-tree-handoff",
					content: stripHandoffPreamble(message.summary),
					display: false,
					timestamp: message.timestamp,
				}
			: message,
	);
}
