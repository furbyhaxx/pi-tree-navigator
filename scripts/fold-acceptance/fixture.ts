import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable facts the synthetic handoff must retain. */
export const FACTS = [
	"Acceptance objective: finish the synthetic service audit, not a production rollout.",
	"Never deploy or delete service data during this audit.",
	"Keep the existing public response codes unchanged.",
	"Completed: audited service configuration and retry boundaries.",
	"Remaining: compare the archived audit with the next supplied change.",
] as const;

/** Opt-in policy in the isolated agent directory, never the user's configuration. */
export function automaticConfig(initialTokens: number) {
	return {
		auto_navigate: {
			enabled: true,
			mode: "anchor-and-rewind",
			milestone: "recommended",
			check_every_turns: 1,
			min_tokens_since_anchor: 1000,
			rewind_at_tokens: Math.ceil(initialTokens + 16384),
		},
	};
}

/** Tail-keeping pressure compaction without classifier anchors, in the isolated agent directory. */
export const PRESSURE_CONFIG = {
	auto_navigate: {
		enabled: true,
		mode: "anchor-and-rewind",
		pressure: "compact",
		keep_recent_share: 0.25,
		milestone: null,
		check_every_turns: 50,
		min_tokens_since_anchor: 1000,
		rewind_at_tokens: 64000,
	},
};

/** One tool turn first, so the compaction lands mid-run and the answer follows it. */
export const PRESSURE_REQUEST =
	"First call navigate_tree with action list. After that result, finalize the audit: state the preserved response-code contract, the no-deployment constraint, and the remaining comparison against the next supplied change. Include ACCEPTANCE-CONTINUED in your final answer. Do not modify files.";

/** A confirmed completed audit followed by an independent, bounded task. */
export const AUTOMATIC_REQUEST =
	"I independently checked the archived report: all service checks passed and the response-code and no-deployment constraints are satisfied. I accept the review unit as finished; no review work remains and no future-change comparison is requested. Separate final deliverable: write the approved audit acceptance certificate in this reply, with the verified service and check totals, preserved response codes, unchanged persistence, and no deployment or deletion. Explicitly state that the certificate is delivered and all requested work is complete. Include ACCEPTANCE-CONTINUED. There is no next step, approval or input to wait for. Do not modify files.";

/** Builds varied synthetic configuration evidence; no workspace or user files are read. */
export function buildCorpus(blocks: number): string[] {
	if (!Number.isInteger(blocks) || blocks < 1 || blocks > 256)
		throw new Error("blocks must be an integer from 1 to 256");
	return Array.from({ length: blocks }, (_, block) => {
		const services = Array.from({ length: 24 }, (_, item) => {
			const id = block * 24 + item;
			return {
				service: `synthetic-service-${id}`,
				listener: { host: "127.0.0.1", port: 10000 + id },
				request: {
					timeoutMs: 1000 + (id % 9) * 250,
					maxBytes: 65536 + id * 16,
				},
				retry: { attempts: 1 + (id % 3), backoffMs: 50 + (id % 7) * 25 },
				persistence: { namespace: `audit-${id}`, retentionDays: 7 + (id % 14) },
				validation: {
					invalidInput: 422,
					unavailable: 503,
					duplicate: 409,
					tests: [`service-${id}-invalid-input`, `service-${id}-retry-exhausted`],
				},
				finding: `Service ${id} validates input before persistence; verify retry exhaustion leaves namespace audit-${id} unchanged.`,
			};
		});
		return `Synthetic audit block ${block + 1}\n${FACTS.join("\n")}\n${JSON.stringify(services, null, 2)}`;
	});
}

/**
 * Dense synthetic evidence: seeded random CJK text costs about 1.9 real tokens
 * per character (o200k), about 7.7x Pi's four-characters-per-token heuristic, so a
 * request that looks small to the estimate overflows the operating window for real.
 */
export function buildDenseCorpus(blocks: number, chars = 7000): string[] {
	if (!Number.isInteger(blocks) || blocks < 1 || blocks > 64)
		throw new Error("blocks must be an integer from 1 to 64");
	let state = 0x9e3779b9;
	const next = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return state >>> 0;
	};
	return Array.from({ length: blocks }, (_, block) => {
		const filler = Array.from({ length: chars }, () =>
			String.fromCodePoint(0x4e00 + (next() % 0x5200)),
		).join("");
		return `Synthetic dense audit block ${block + 1} (opaque archived log, no actionable content)\n${FACTS.join("\n")}\n${filler}`;
	});
}

/** Records fixture provenance without treating synthetic messages as observed model output. */
export function corpusManifest(corpus: readonly string[]) {
	return corpus.map((text, index) => ({
		index,
		bytes: Buffer.byteLength(text),
		sha256: createHash("sha256").update(text).digest("hex"),
	}));
}

/** Seed an explicitly synthetic completed history and a real persisted anchor. */
export function seedCorpus(
	sm: SessionManager,
	corpus: readonly string[],
	options: {
		completedReview?: boolean;
		/** Without the `audit-start` anchor, recovery has no fold target. */
		anchor?: boolean;
		/** Label the reply to this block `anchor:audit-mid`. */
		midAnchorAfter?: number;
	} = {},
): void {
	const { completedReview = false, anchor: anchored = true } = options;
	sm.appendMessage({
		role: "user",
		content: completedReview
			? "Audit the supplied fixed service dataset and produce its verified final report. Preserve response codes 422, 503 and 409. Never deploy or delete service data. Future changes are outside this request."
			: FACTS.join("\n"),
		timestamp: 1,
	});
	const anchor = sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Synthetic fixture: audit begins." }],
		api: "openai-completions",
		provider: "fixture",
		model: "synthetic",
		stopReason: "stop",
		timestamp: 2,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	if (anchored) sm.appendLabelChange(anchor, "anchor:audit-start");
	for (const [index, text] of corpus.entries()) {
		sm.appendMessage({
			role: "user",
			content: completedReview
				? text.replace(
						FACTS[4],
						"Scope ends at the verified final report; no future comparison is requested.",
					)
				: text,
			timestamp: 3 + index * 2,
		});
		const reply = sm.appendMessage({
			role: "assistant",
			content: [
				{
					type: "text",
					text:
						completedReview && index === corpus.length - 1
							? `Synthetic completed review phase: final audit report delivered for all ${corpus.length * 24} services. Verification: ${corpus.length * 48} of ${corpus.length * 48} invalid-input and retry-exhaustion checks PASS, zero failures. Response codes remain 422, 503 and 409. Every retry-exhaustion check confirms the namespace is unchanged. No deployment or deletion occurred. The requested audit and its final report are complete; no checks, edits, reporting, decisions or other audit work remain.`
							: completedReview
								? `Synthetic verification report for block ${index + 1}: all 48 invalid-input and retry-exhaustion checks PASS, zero failures. Response codes 422, 503 and 409 unchanged; no persistence mutation, deployment or deletion.`
								: `Synthetic fixture conclusion for block ${index + 1}: inspected, retain the audit constraints and remaining comparison work.`,
				},
			],
			api: "openai-completions",
			provider: "fixture",
			model: "synthetic",
			stopReason: "stop",
			timestamp: 4 + index * 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		if (index === options.midAnchorAfter) sm.appendLabelChange(reply, "anchor:audit-mid");
	}
}
