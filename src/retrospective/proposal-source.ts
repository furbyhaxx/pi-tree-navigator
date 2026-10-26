import type { ProposalOptions } from "./proposal-options.ts";
import type {
	RetrospectiveGroup,
	RetrospectivePlan,
	SessionSnapshot,
} from "./retrospective-plan.ts";

/** Construct chronological open phases without claiming unverified completion. */
export function buildHeuristicPlan(
	snapshot: SessionSnapshot,
	onWarning?: (message: string) => void,
): RetrospectivePlan {
	const entries = snapshot.entries;
	const positions = new Map(entries.map((entry, i) => [entry.id, i]));
	const names = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "label" && entry.label)
			names.add(entry.label.replace(/^(anchor|branch):/, ""));
	}
	const nameFor = (title: string) => {
		const base =
			title
				.toLowerCase()
				.replace(/^(anchor|branch):/, "")
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 30)
				.replace(/-$/, "") || "phase";
		let name = base;
		let n = 2;
		while (names.has(name)) name = `${base}-${n++}`;
		names.add(name);
		return name;
	};
	const titleAt = (index: number): string => {
		const entry = entries[index];
		if (entry === undefined) throw new Error(`Missing entry at index ${index}`);
		if (entry.type === "label" && entry.label) return entry.label.replace(/^(anchor|branch):/, "");
		if (entry.type === "branch_summary")
			return (
				entry.summary
					.split("\n")
					.find((line) => line.trim())
					?.slice(0, 100) || "Recorded branch"
			);
		if (entry.type === "message" && entry.message.role === "user") {
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join(" ");
			return text.replace(/\s+/g, " ").trim().slice(0, 100) || "User request";
		}
		return "Session work";
	};
	interface Interval {
		first: number;
		last: number;
		title: string;
		report?: string | undefined;
		children: Interval[];
	}
	const intervals: Interval[] = [];
	for (const entry of entries) {
		if (entry.type !== "branch_summary") continue;
		const parent = entry.parentId === null ? -1 : positions.get(entry.parentId);
		const last = positions.get(entry.fromId);
		if (parent === undefined || last === undefined || parent >= last) continue;
		// The abandoned leaf must actually descend from the summary's parent.
		let cursor: string | null = entry.fromId;
		const seen = new Set<string>();
		while (cursor !== entry.parentId && cursor !== null && !seen.has(cursor)) {
			seen.add(cursor);
			const index = positions.get(cursor);
			if (index === undefined) {
				cursor = null;
				continue;
			}
			const ancestor = entries[index];
			if (ancestor === undefined) throw new Error(`Missing entry at index ${index}`);
			cursor = ancestor.parentId;
		}
		if (cursor !== entry.parentId) continue;
		intervals.push({
			first: parent + 1,
			last,
			title: titleAt(positions.get(entry.id) ?? last),
			report: entry.summary.trim() || undefined,
			children: [],
		});
	}
	intervals.sort((a, b) => a.first - b.first || b.last - a.last);
	const root: Interval = {
		first: 0,
		last: entries.length - 1,
		title: snapshot.name || "Session work",
		children: [],
	};
	const stack = [root];
	for (const interval of intervals) {
		while (stack.length > 1 && interval.first > (stack.at(-1) ?? root).last) stack.pop();
		const parent = stack.at(-1) ?? root;
		if (
			interval.last > parent.last ||
			(interval.first === parent.first && interval.last === parent.last)
		)
			continue;
		const previous = parent.children.at(-1);
		if (previous && interval.first <= previous.last) continue;
		parent.children.push(interval);
		stack.push(interval);
	}
	let depthLimited = false;
	const expand = (interval: Interval, depth: number): RetrospectiveGroup => {
		const occupied = [...interval.children].sort((a, b) => a.first - b.first);
		const children = [...occupied];
		const starts: number[] = [];
		let childIndex = 0;
		for (let index = interval.first; index <= interval.last; index++) {
			const child = occupied[childIndex];
			if (child && index >= child.first) {
				index = child.last;
				childIndex++;
				continue;
			}
			const entry = entries[index];
			if (entry === undefined) throw new Error(`Missing entry at index ${index}`);
			if (entry.type === "label" || (entry.type === "message" && entry.message.role === "user"))
				starts.push(index);
		}
		childIndex = 0;
		for (const [n, first] of starts.entries()) {
			while (true) {
				const child = occupied[childIndex];
				if (child === undefined || child.first > first) break;
				childIndex++;
			}
			const boundary = Math.min(
				starts[n + 1] ?? interval.last + 1,
				occupied[childIndex]?.first ?? interval.last + 1,
			);
			const last = boundary - 1;
			if (first === interval.first && last === interval.last) continue;
			children.push({ first, last, title: titleAt(first), children: [] });
		}
		if (depth === 31 && children.length) {
			depthLimited = true;
			children.length = 0;
		}
		children.sort((a, b) => a.first - b.first);
		const firstEntry = entries[interval.first];
		const lastEntry = entries[interval.last];
		if (firstEntry === undefined || lastEntry === undefined)
			throw new Error("Missing heuristic interval endpoint");
		return {
			name: nameFor(interval.title),
			title: interval.title,
			firstEntryId: firstEntry.id,
			lastEntryId: lastEntry.id,
			state: "open",
			summary: interval.report ?? "Open phase; completion is not established.",
			children: children.map((child) => expand(child, depth + 1)),
		};
	};
	const groups = entries.length ? [expand(root, 0)] : [];
	if (depthLimited)
		onWarning?.(
			"Heuristic annotations were limited to 32 levels; deeper history remains verbatim in its enclosing open phase.",
		);
	return {
		version: 1,
		source: snapshot.path,
		sourceSha256: snapshot.sha256,
		nameSuffix: " (restructured)",
		parentHandoffMode: "full",
		recurse: false,
		descendantPlans: [],
		groups,
	};
}

/** Serialize untrusted textual evidence with tool disclosure applied before serialization. */
export function buildProposalRecords(
	snapshot: SessionSnapshot,
	input: ProposalOptions,
): {
	records: readonly { id: string; text: string }[];
	warnings: readonly string[];
} {
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
	const modeFor = (name: string) =>
		Object.hasOwn(input.tools, name) ? (input.tools[name] ?? "full") : "full";
	const resultModes = new Map<string, "full" | "calls-only" | "omit">();
	for (const entry of snapshot.entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const toolCallId = entry.message.toolCallId;
		let mode = modeFor(entry.message.toolName);
		let cursor = entry.parentId;
		const seen = new Set<string>();
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const ancestor = byId.get(cursor);
			if (!ancestor) break;
			if (ancestor.type === "message" && ancestor.message.role === "assistant") {
				const call = ancestor.message.content.find(
					(block) => block.type === "toolCall" && block.id === toolCallId,
				);
				if (call?.type === "toolCall") {
					const matched = modeFor(call.name);
					mode =
						mode === "omit" || matched === "omit"
							? "omit"
							: mode === "calls-only" || matched === "calls-only"
								? "calls-only"
								: "full";
					break;
				}
			}
			cursor = ancestor.parentId;
		}
		resultModes.set(entry.id, mode);
	}
	let omitted = 0;
	let binary = 0;
	const clean = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(clean);
		if (!value || typeof value !== "object") return value;
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
			binary++;
			return "[binary omitted]";
		}
		const object = value as Record<string, unknown>;
		if (
			object["type"] === "toolCall" &&
			typeof object["name"] === "string" &&
			"arguments" in object &&
			modeFor(object["name"]) === "omit"
		) {
			omitted++;
			return {
				type: object["type"],
				id: object["id"],
				name: object["name"],
				omitted: "tool arguments withheld",
			};
		}
		if (
			[
				"image",
				"image_url",
				"audio",
				"video",
				"document",
				"redactedThinking",
				"Buffer",
				"base64",
			].includes(String(object["type"])) ||
			(typeof object["mimeType"] === "string" &&
				/^(?:image\/|audio\/|video\/|application\/(?:pdf|octet-stream)$)/.test(object["mimeType"]))
		) {
			binary++;
			return { type: object["type"], omitted: "non-text payload" };
		}
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(object)) {
			if (/signature|base64|encrypted|redactedThinking/i.test(key)) {
				binary++;
				continue;
			}
			Object.defineProperty(result, key, {
				value: clean(item),
				enumerable: true,
			});
		}
		return result;
	};
	const records = snapshot.entries.map((entry) => {
		let value: unknown = entry;
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "toolResult") {
				const name = message.toolName;
				const mode = resultModes.get(entry.id) ?? "full";
				if (mode !== "full") {
					omitted++;
					value = {
						id: entry.id,
						parentId: entry.parentId,
						type: entry.type,
						message: {
							role: message.role,
							toolCallId: message.toolCallId,
							toolName: name,
							omitted: `${mode}: result content and details withheld`,
						},
					};
				}
			}
		}
		if (
			entry.type === "message" &&
			entry.message.role === "bashExecution" &&
			modeFor("bash") !== "full"
		) {
			const mode = modeFor("bash");
			omitted++;
			value = {
				id: entry.id,
				parentId: entry.parentId,
				type: entry.type,
				message: {
					role: "bashExecution",
					...(mode === "calls-only" ? { command: entry.message.command } : {}),
					omitted: `${mode}: native shell content withheld`,
				},
			};
		}
		if (entry.type === "context_edit" && entry.replacement !== null) {
			const target = byId.get(entry.targetId);
			const resultMode = resultModes.get(entry.targetId);
			const hiddenAssistant =
				target?.type === "message" &&
				target.message.role === "assistant" &&
				target.message.content.some(
					(block) => block.type === "toolCall" && modeFor(block.name) === "omit",
				);
			if (
				(resultMode !== undefined && resultMode !== "full") ||
				hiddenAssistant ||
				(target?.type === "message" &&
					target.message.role === "bashExecution" &&
					modeFor("bash") !== "full")
			) {
				omitted++;
				value = {
					id: entry.id,
					parentId: entry.parentId,
					type: entry.type,
					targetId: entry.targetId,
					omitted: "restricted tool context replacement withheld",
				};
			}
		}
		return { id: entry.id, text: JSON.stringify(clean(value)) };
	});
	const warnings: string[] = [];
	if (omitted || Object.values(input.tools).some((mode) => mode !== "full"))
		warnings.push(
			`${omitted} tool call/result payloads omitted by disclosure rules. Copies in unrelated prose cannot be redacted by tool exclusions.`,
		);
	if (binary) warnings.push(`${binary} non-text payloads or opaque signature fields omitted.`);
	return { records, warnings };
}
