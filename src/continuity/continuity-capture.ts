/**
 * Capture side of the Session Continuity Ledger: turns user messages and
 * `ask_user` answers on the active branch into ledger ops.
 *
 * Capture is deterministic first. `ask_user` answers need no model, and user
 * messages go through an `IntentClassifier` that only decides what a message
 * is: the stored text is always the user's verbatim words, never a rewrite.
 * Ops are returned, not applied; the ledger enforces every invariant.
 *
 * No I/O. Pi runtime imports are type-only.
 */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractTextContent } from "../core/helpers.ts";
import { userAuthoredText } from "../core/skill-blocks.ts";
import {
	HEURISTIC_MAX_CHARS,
	heuristicExcerpts,
	heuristicKind,
	MIN_MESSAGE_CHARS,
} from "./continuity-capture-heuristics.ts";
import {
	type Answers,
	acceptedContradiction,
	acceptedKind,
	classifierContext,
	ephemeral,
	type INTENT_KINDS,
	pickItems,
	resolveAsks,
	unknownModel,
} from "./continuity-capture-model.ts";
import {
	type AskAnswer,
	anchorAt,
	askOp,
	askUserAnswers,
	type Candidate,
	type CaptureResult,
	CLASSIFY_CONCURRENCY,
	excerptOps,
	mapPool,
	type ScanState,
	SUPERSEDABLE_KINDS,
	scanStart,
	userOp,
} from "./continuity-capture-scan.ts";
import type { Ledger, LedgerOp, OpContext } from "./continuity-ledger.ts";
import { resolveIntentPolicy } from "./intent-policy.ts";
import {
	buildRetirementCheckContext,
	RETIREMENT_QUESTION,
	retirementConfirmed,
} from "./retirement-check.ts";

export type IntentKind = (typeof INTENT_KINDS)[number];

export interface IntentInput {
	entryId: string;
	text: string;
	/** Anchor the message falls under (latest `anchor:` label before it), if any. */
	activeAnchor?: string;
	activeItems: readonly { id: string; kind: string; text: string }[];
}

/** One sentence of a message that states a rule or decision on its own. */
export interface IntentExcerpt {
	kind: "rule" | "decision";
	/** The sentence, verbatim as the user wrote it. */
	text: string;
}

export interface IntentVerdict {
	kind: IntentKind;
	/** Ids of active ledger items the message replaces or reverses. */
	supersedes?: readonly string[];
	/** Sentences captured on their own, for a message too long to judge as a whole. */
	excerpts?: readonly IntentExcerpt[];
	by: "heuristic" | "classifier";
	/** Set once per classifier instance when its model failed; surfaced in `CaptureResult.warnings`. */
	warning?: string;
}

export type IntentClassifier = (input: IntentInput, signal?: AbortSignal) => Promise<IntentVerdict>;

export interface CapturedOp {
	op: LedgerOp;
	ctx: OpContext;
}

/**
 * Marker-based classifier: no I/O, never supersedes, misses anything phrased
 * without an explicit marker ("drop X and only keep Y" is ephemeral to it).
 * A message over the length limit is ephemeral as a whole, but up to three of
 * its rule or decision sentences come back as `excerpts`.
 */
export const heuristicClassifier: IntentClassifier = async (input) => {
	const kind = heuristicKind(input.text);
	const excerpts =
		kind === "ephemeral" && input.text.trim().length > HEURISTIC_MAX_CHARS
			? heuristicExcerpts(input.text.trim())
			: [];
	return {
		kind,
		by: "heuristic",
		...(excerpts.length > 0 && { excerpts }),
	};
};

export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** The exact classifier request for one user message; items are the bounded active subset. */
export function buildIntentClassifierContext(input: IntentInput): {
	context: ClassifierContext;
	items: IntentInput["activeItems"];
} {
	const items = pickItems(input.activeItems);
	return { context: classifierContext(input, items), items };
}

// An abstaining model must not hide an explicit marker or excerpt: keep what
// the heuristic found, as the heuristic's own verdict, never a supersession.
async function abstentionVerdict(
	input: IntentInput,
	signal: AbortSignal | undefined,
	heuristics: boolean,
): Promise<IntentVerdict> {
	if (!heuristics) return ephemeral();
	const heuristic = await heuristicClassifier(input, signal);
	return heuristic.kind !== "ephemeral" || heuristic.excerpts !== undefined
		? heuristic
		: ephemeral();
}

/** What `createModelClassifier` needs; a policy with catalog models also uses the optional methods. */
export type IntentRegistry = Pick<ModelRegistry, "getModelOfType" | "classify"> &
	Partial<Pick<ModelRegistry, "getAvailableOfType" | "streamSimple">>;

/**
 * Classify with registry models, one pass per message. `model` is a
 * `continuity.intentClassifier` value: `provider/id` (one classifier model
 * answers both questions), `"recommended"` or the canonical text of an object
 * policy (see `intent-policy.ts`). Resolves to `undefined` (after
 * `opts.onWarning`) when a model is malformed, unknown or has no credentials,
 * and silently when the policy uses no model at all; never throws.
 *
 * The kind is judged by its stage alone and never escalated; without a kind
 * model the heuristic judges it. A message that is not ephemeral then gets the
 * `contradicts` answer of the supersession stage and, if that stage abstains,
 * of the escalation stage. A model abstains on low confidence or an answer it
 * did not offer. When the kind stage abstains the heuristic verdict stands if
 * it found a rule, decision, objective or excerpts, else the message is
 * ephemeral; an abstention never supersedes. A retirement named by escalation
 * applies only when the verification stage confirms that one item; a primary
 * acceptance and a confident `none` are not re-checked. A no, low-confidence,
 * malformed, missing, cancelled or failed check keeps the item and the
 * captured kind. After a stage model's first error the instance stops calling
 * it and reports the failure once through `IntentVerdict.warning`; a failed
 * kind stage answers with the heuristic classifier so no explicit rule is lost
 * during an outage. A failed verification stage stops confirming retirements
 * and leaves them unapplied, without disabling the other stages. Create a new
 * instance to retry.
 */
export async function createModelClassifier(
	registry: IntentRegistry,
	model: string,
	opts: { minConfidence?: number; onWarning?: (message: string) => void } = {},
): Promise<IntentClassifier | undefined> {
	const policy = resolveIntentPolicy(model);
	if (!policy) {
		opts.onWarning?.(unknownModel(model));
		return undefined;
	}
	const selectors = [
		...new Set(
			[
				policy.kind.model,
				policy.supersession.model,
				policy.escalation.model,
				policy.verification.model,
			].filter((selector) => selector !== null),
		),
	];
	if (selectors.length === 0) return undefined;
	const resolved = await resolveAsks(registry, model, selectors);
	if ("problem" in resolved) {
		opts.onWarning?.(resolved.problem);
		return undefined;
	}
	const minConfidence = opts.minConfidence ?? policy.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
	const failed = new Set<string>();
	const verificationDown = new Set<string>();
	const kindModel = policy.kind.model;

	const ask = async (
		selector: string,
		context: ClassifierContext,
		signal: AbortSignal | undefined,
	): Promise<{ answers: Answers } | { error: string }> => {
		try {
			return { answers: await resolved.get(selector)?.(context, signal) };
		} catch (error) {
			failed.add(selector);
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};

	return async (input, signal) => {
		if (signal?.aborted) return ephemeral();
		const outage = async (): Promise<IntentVerdict> =>
			policy.heuristics ? heuristicClassifier(input, signal) : ephemeral();
		const { context, items } = buildIntentClassifierContext(input);
		const questions = (
			ids: readonly string[],
			instructions: Record<string, string | undefined>,
		): ClassifierContext => ({
			state: context.state,
			questions: Object.fromEntries(
				ids.flatMap((id) => {
					const question = context.questions[id];
					const text = instructions[id];
					return question
						? [[id, text === undefined ? question : { ...question, instructions: text }]]
						: [];
				}),
			),
		});
		const supersession = items.length > 0 ? policy.supersession.model : null;
		const sameModel = kindModel !== null && kindModel === supersession;
		const warnings: string[] = [];

		let base: IntentVerdict;
		let shared: Answers;
		if (kindModel === null) {
			base = await heuristicClassifier(input, signal);
			if (base.kind === "ephemeral") return base;
		} else {
			if (failed.has(kindModel)) return outage();
			const out = await ask(
				kindModel,
				questions(sameModel ? ["kind", "contradicts"] : ["kind"], {
					kind: policy.kind.instructions,
					contradicts: policy.supersession.instructions,
				}),
				signal,
			);
			if (signal?.aborted) return ephemeral();
			if ("error" in out) {
				return {
					...(await outage()),
					warning: `navigate_tree: continuity classifier ${kindModel} failed (${out.error}); user instructions are ${policy.heuristics ? "captured by heuristics instead" : "not captured until it answers again"}.`,
				};
			}
			const kind = acceptedKind(out.answers, minConfidence);
			if (kind === undefined) {
				return abstentionVerdict(input, signal, policy.heuristics);
			}
			if (kind === "ephemeral") return ephemeral();
			base = { kind, by: "classifier" };
			if (sameModel) shared = out.answers;
		}

		// The answer of one model to `contradicts`, or undefined when it abstains or fails.
		const askContradicts = async (model: string | null, instructions: string | undefined) => {
			if (model === null || failed.has(model)) return undefined;
			const out = await ask(
				model,
				questions(["contradicts"], { contradicts: instructions }),
				signal,
			);
			if ("error" in out) {
				warnings.push(
					`navigate_tree: continuity classifier ${model} failed (${out.error}); replacements of earlier items by it are skipped.`,
				);
				return undefined;
			}
			return acceptedContradiction(out.answers, items, minConfidence);
		};
		const confirmRetirement = async (
			model: string,
			item: (typeof items)[number],
		): Promise<boolean> => {
			if (verificationDown.has(model) || signal?.aborted) return false;
			const asker = resolved.get(model);
			if (asker === undefined) {
				verificationDown.add(model);
				warnings.push(
					`navigate_tree: continuity classifier ${model} is not available; the proposed retirement is not applied.`,
				);
				return false;
			}
			const { context } = buildRetirementCheckContext({
				message: input.text,
				item,
				otherItems: items.filter((other) => other.id !== item.id),
			});
			const text = policy.verification.instructions;
			const question = context.questions[RETIREMENT_QUESTION];
			const asked =
				text === undefined || question === undefined
					? context
					: {
							...context,
							questions: {
								...context.questions,
								[RETIREMENT_QUESTION]: { ...question, instructions: text },
							},
						};
			try {
				const answers = await asker(asked, signal);
				if (signal?.aborted) return false;
				return retirementConfirmed(answers, minConfidence);
			} catch (error) {
				if (signal?.aborted) return false;
				verificationDown.add(model);
				const reason = error instanceof Error ? error.message : String(error);
				warnings.push(
					`navigate_tree: continuity classifier ${model} failed (${reason}); the proposed retirement is not applied.`,
				);
				return false;
			}
		};
		let contradicts: string | undefined;
		let escalated = false;
		if (items.length > 0) {
			const primary = shared
				? acceptedContradiction(shared, items, minConfidence)
				: await askContradicts(supersession, policy.supersession.instructions);
			if (primary !== undefined) {
				contradicts = primary;
			} else {
				contradicts = await askContradicts(policy.escalation.model, policy.escalation.instructions);
				escalated = contradicts !== undefined;
			}
			if (signal?.aborted) return ephemeral();
		}
		const named = items.some((item) => item.id === contradicts) ? contradicts : undefined;
		const finish = (supersedes?: string): IntentVerdict => ({
			...base,
			...(supersedes !== undefined && { supersedes: [supersedes] }),
			...(warnings.length > 0 && { warning: warnings.join(" ") }),
		});
		const proposed =
			named === undefined ? undefined : items.find((candidate) => candidate.id === named);
		const verifier = policy.verification.model;
		if (!escalated || proposed === undefined || verifier === null) {
			return finish(named);
		}
		if (!(await confirmRetirement(verifier, proposed))) return finish();
		return finish(named);
	};
}

// Slash commands that reach the model are expanded text, not user intent; the
// `[navigate_tree` prefix is this extension's own injected user messages.
const SLASH_COMMAND_RE = /^\/[\w:.-]+(\s|$)/;
const OWN_MESSAGE_PREFIX = "[navigate_tree";

/** The user message `/anchor` injects to request a fold: machine-generated, never intent. */
export const FOLD_REQUEST_RE =
	/^Please fold the work since the '[^']*' anchor: call navigate_tree\(action='rewind'/;
function userCandidate(entry: SessionEntry, index: number): Candidate | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") {
		return undefined;
	}
	const text = userAuthoredText(extractTextContent(entry.message.content)).text.trim();
	if (
		text.length < MIN_MESSAGE_CHARS ||
		SLASH_COMMAND_RE.test(text) ||
		text.startsWith(OWN_MESSAGE_PREFIX) ||
		FOLD_REQUEST_RE.test(text)
	) {
		return undefined;
	}
	return { entryId: entry.id, index, text };
}

/**
 * Turn the entries after `watermark` into ledger ops.
 *
 * `branch` is root-to-leaf (`sm.getBranch()`). Scanning starts after the
 * watermark entry, or after the latest `branch_summary` when the watermark is
 * missing or off the branch. Entries that already sourced a ledger item are
 * skipped so a lost watermark cannot resurrect superseded items; anything else
 * re-captured is a ledger `duplicate`. If `opts.signal` aborts, no ops are
 * returned and the watermark does not move.
 */
export async function captureIntent(
	branch: readonly SessionEntry[],
	watermark: string | undefined,
	ledger: Ledger,
	classifier: IntentClassifier,
	opts: { signal?: AbortSignal } = {},
): Promise<CaptureResult> {
	const scanned = branch.slice(scanStart(branch, watermark));
	const warnings = new Set<string>();
	const done = (ops: CapturedOp[], classified: number): CaptureResult => ({
		ops,
		watermark: scanned.length > 0 ? scanned[scanned.length - 1]?.id : watermark,
		classified,
		warnings: [...warnings],
	});
	if (scanned.length === 0) return done([], 0);

	const captured = new Set(
		ledger.items.flatMap((item) =>
			item.source.entryId === undefined ? [] : [item.source.entryId],
		),
	);
	const offset = branch.length - scanned.length;
	const fresh = scanned.map((entry, i) => ({ entry, index: offset + i }));
	const candidates = fresh.flatMap(({ entry, index }) => {
		const candidate = captured.has(entry.id) ? undefined : userCandidate(entry, index);
		return candidate ? [candidate] : [];
	});

	const active = new Map(
		ledger.items
			.filter((item) => item.status === "active" && SUPERSEDABLE_KINDS.has(item.kind))
			.map((item) => [item.id, item] as const),
	);
	const activeItems = [...active.values()].map(({ id, kind, text }) => ({
		id,
		kind,
		text,
	}));
	const anchorFor = anchorAt(branch);
	const verdicts = await mapPool(candidates, CLASSIFY_CONCURRENCY, async (c) => {
		if (opts.signal?.aborted) return undefined;
		const anchor = anchorFor(c.index);
		try {
			return await classifier(
				{
					entryId: c.entryId,
					text: c.text,
					...(anchor !== undefined && { activeAnchor: anchor }),
					activeItems,
				},
				opts.signal,
			);
		} catch (error) {
			if (opts.signal?.aborted) return undefined;
			warnings.add(
				`navigate_tree: continuity intent classifier failed (${error instanceof Error ? error.message : String(error)}); the message was not captured.`,
			);
			return undefined;
		}
	});
	if (opts.signal?.aborted) return { ...done([], 0), watermark };

	for (const verdict of verdicts) {
		if (verdict?.warning !== undefined) warnings.add(verdict.warning);
	}
	const classified = new Map(
		candidates.map((c, i) => [c.entryId, { candidate: c, verdict: verdicts[i] }]),
	);
	const userEntries = new Map(
		branch.flatMap((entry, i) =>
			entry.type === "message" && entry.message.role === "user" ? [[entry.id, i] as const] : [],
		),
	);
	const userEntryIndex = (id: string) => userEntries.get(id);
	const state: ScanState = {
		objective: ledger.items
			.filter((item) => item.kind === "objective" && item.status === "active")
			.map((item) => ({ id: item.id, text: item.text }))[0],
		superseded: new Set(),
	};

	// Answers to one question are judged across the whole scan, including entries
	// already captured, so only the newest one is emitted and a lost watermark
	// cannot bring back an answer a later one replaced.
	const answers = new Map(fresh.map(({ entry }) => [entry.id, askUserAnswers(entry)] as const));
	const newest = new Map<string, AskAnswer>();
	for (const list of answers.values()) {
		for (const answer of list) newest.set(answer.question, answer);
	}

	const ops: CapturedOp[] = [];
	for (const { entry, index } of fresh) {
		if (captured.has(entry.id)) continue;
		for (const answer of answers.get(entry.id) ?? []) {
			if (newest.get(answer.question) === answer) {
				ops.push(askOp(answer, active, state));
			}
		}
		const hit = classified.get(entry.id);
		if (!hit?.verdict) continue;
		ops.push(...excerptOps(hit.verdict, entry.id, userEntryIndex));
		const op = userOp(hit.verdict, hit.candidate, anchorFor(index), active, state, userEntryIndex);
		if (op) ops.push(op);
	}
	return done(ops, candidates.length);
}
