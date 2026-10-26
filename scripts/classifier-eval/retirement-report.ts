/**
 * Offline analysis of the retirement-verifier spike; no provider is called.
 *
 *   node scripts/classifier-eval/retirement-report.ts screen --run <dir> [--top 3] [--out <file>]
 *   node scripts/classifier-eval/retirement-report.ts simulate --capture <dir> --verifier-run <dir> \
 *     [--split holdout] [--out <file>]
 *
 * `screen` ranks verifiers on retirement cases by the pre-registered rule:
 * fewest unsafe accepted answers, highest accepted-exact rate on positives,
 * lowest cost per 1,000 decisions, lowest p95 latency. `simulate` replays the
 * capture preset's `contradicts` pipeline (microsoft, then luna chat when
 * microsoft abstains) from recorded observations and adds a verifier step.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	RETIREMENT_QUESTION,
	retirementConfirmed,
} from "../../extensions/navigate-tree/retirement-check.ts";
import { parseObservations } from "./analyze.ts";
import { prepareCase } from "./prepare.ts";
import {
	CASES as RETIREMENT_CASES,
	retirementCaseId,
	retirementLabel,
} from "./retirement-cases.ts";
import { scoreObservation, summarizeScores } from "./scoring.ts";
import type { EvalCase, EvalObservation } from "./types.ts";

const MIN_CONFIDENCE = 0.7;
const NONE = "none";
const MS = "decisions:microsoft/microsoft-decision-1";
const LUNA = "chat:openai/gpt-6-luna";

const percentile = (values: readonly number[], fraction: number) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0
		? null
		: (sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null);
};

const callCost = (o: EvalObservation) => o.costUsd ?? o.costBoundUsd;

// ---------------------------------------------------------------------------
// Development screen
// ---------------------------------------------------------------------------

export interface ScreenRow {
	model: string;
	/** Accepted `yes` answers on negative cases. */
	unsafe: number;
	negatives: number;
	/** Accepted `no` answers on negative cases. */
	negativeAcceptedExact: number;
	positives: number;
	/** Accepted `yes` answers on positive cases. */
	positiveAcceptedExact: number;
	positiveRate: number | null;
	ambiguousConfirmed: number;
	ambiguous: number;
	errors: number;
	decisions: number;
	costPer1000: number;
	p95Ms: number | null;
}

/** One row per model over the retirement cases; every recorded attempt counts as a decision. */
export function screenRows(
	cases: readonly EvalCase[],
	observations: readonly EvalObservation[],
): ScreenRow[] {
	const byId = new Map(cases.map((c) => [c.id, prepareCase(c)]));
	const models = [...new Set(observations.map((o) => o.model))];
	return models.map((model) => {
		const own = observations.filter((o) => o.model === model);
		const scored = own.map((o) => {
			const prepared = byId.get(o.caseId);
			if (!prepared) throw new Error(`unknown retirement case ${o.caseId}`);
			return {
				label: retirementLabel(prepared),
				score: scoreObservation(prepared, o, MIN_CONFIDENCE),
				answer: o.answers[RETIREMENT_QUESTION],
			};
		});
		const of = (label: ReturnType<typeof retirementLabel>) =>
			scored.filter((s) => s.label === label);
		const positives = of("positive");
		const summary = summarizeScores(scored.map((s) => s.score));
		const positiveAcceptedExact = positives.filter((s) => s.score.acceptedExact).length;
		return {
			model,
			unsafe: scored.reduce((sum, s) => sum + s.score.unsafeAccepted, 0),
			negatives: of("negative").length,
			negativeAcceptedExact: of("negative").filter((s) => s.score.acceptedExact).length,
			positives: positives.length,
			positiveAcceptedExact,
			positiveRate: positives.length === 0 ? null : positiveAcceptedExact / positives.length,
			ambiguous: of("ambiguous").length,
			ambiguousConfirmed: of("ambiguous").filter(
				(s) => s.answer?.choice === "yes" && s.score.answers[0]?.accepted,
			).length,
			errors: summary.errors,
			decisions: scored.length,
			costPer1000: (summary.cost.boundUsd / Math.max(1, scored.length)) * 1000,
			p95Ms: summary.latency.p95Ms,
		};
	});
}

const ascNullLast = (a: number | null, b: number | null) =>
	a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;

/** The pre-registered order: unsafe, positive accepted-exact, cost, p95, label. */
export function rankScreen(rows: readonly ScreenRow[]): ScreenRow[] {
	return [...rows].sort(
		(a, b) =>
			a.unsafe - b.unsafe ||
			ascNullLast(
				a.positiveRate === null ? null : -a.positiveRate,
				b.positiveRate === null ? null : -b.positiveRate,
			) ||
			a.costPer1000 - b.costPer1000 ||
			ascNullLast(a.p95Ms, b.p95Ms) ||
			a.model.localeCompare(b.model),
	);
}

const pct = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const ms = (value: number | null) => (value === null ? "-" : `${Math.round(value)}`);

export function renderScreen(rows: readonly ScreenRow[], top: number): string {
	const ranked = rankScreen(rows);
	const lines = [
		"| rank | model | unsafe / negatives | positives accepted-exact | negatives accepted-exact | ambiguous yes | errors / decisions | $/1k | p95 ms |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...ranked.map(
			(r, i) =>
				`| ${i + 1}${i < top ? " (selected)" : ""} | \`${r.model}\` | ${r.unsafe} / ${r.negatives} | ${r.positiveAcceptedExact} / ${r.positives} (${pct(r.positiveRate)}) | ${r.negativeAcceptedExact} / ${r.negatives} | ${r.ambiguousConfirmed} / ${r.ambiguous} | ${r.errors} / ${r.decisions} | ${r.costPer1000.toFixed(4)} | ${ms(r.p95Ms)} |`,
		),
	];
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// End-to-end simulation
// ---------------------------------------------------------------------------

export type VerifyMode = "none" | "escalated" | "every";

export interface SimulationInput {
	/** Supersession cases of the split under test. */
	parents: readonly EvalCase[];
	ms: readonly EvalObservation[];
	luna: readonly EvalObservation[];
	/** Observations of one verifier over the retirement cases of those parents. */
	verifier: readonly EvalObservation[];
}

export interface Simulation {
	mode: VerifyMode;
	decisions: number;
	acceptedExact: number;
	/** Decisions whose rejected retirement counts as an accepted `none` instead of a withheld answer. */
	acceptedExactIfRejectedIsNone: number;
	unsafe: number;
	/** Proposed retirements that were checked. */
	verified: number;
	confirmed: number;
	rejected: number;
	/** Checks that errored; the retirement does not apply. */
	failed: number;
	/** Checked retirements with no verifier observation; excluded from every figure. */
	missing: { caseId: string; item: string; repetition: number }[];
	/** Rejected retirements of an item that is not replaced (a wrong retirement stopped). */
	unsafeRejected: number;
	/** Rejected retirements of an item the message truly replaces (a missed positive). */
	positivesBlocked: number;
	/** Rejected retirements the reference accepts either way. */
	ambiguousRejected: number;
	addedP95Ms: number | null;
	totalP95Ms: number | null;
	costPer1000: number;
	addedCostPer1000: number;
}

interface Vote {
	accepted: boolean;
	choice?: string;
	correct: boolean;
	unsafe: boolean;
}

function voteOf(
	parent: EvalCase,
	observation: EvalObservation,
	question: string,
	minConfidence: number,
): Vote {
	const answer = scoreObservation(prepareCase(parent), observation, minConfidence).answers.find(
		(a) => a.question === question,
	);
	return {
		accepted: answer?.accepted ?? false,
		...(answer?.valid && { choice: observation.answers[question]?.choice }),
		correct: answer?.correct ?? false,
		unsafe: answer?.unsafe ?? false,
	};
}

/** A question the first model did not accept goes to the second; an unaccepted answer there is withheld. */
const chain = (first: Vote, second: () => Vote): Vote => (first.accepted ? first : second());

const keyOf = (caseId: string, repetition: number) => `${caseId}#${repetition}`;

/**
 * Replay microsoft then luna chat for every (case, repetition) both recorded,
 * with the semantics of the holdout-v3 `chain(ms > luna)` policy: each
 * question goes to luna when microsoft did not accept it, a decision is
 * accepted-exact when both questions are accepted and correct, and luna is
 * called when any question needs it. The verifier acts on the accepted
 * `contradicts` item only.
 */
export function simulate(
	input: SimulationInput,
	mode: VerifyMode,
	minConfidence = MIN_CONFIDENCE,
): Simulation {
	const indexed = (list: readonly EvalObservation[]) =>
		new Map(list.map((o) => [keyOf(o.caseId, o.repetition), o]));
	const msByKey = indexed(input.ms);
	const lunaByKey = indexed(input.luna);
	const verifierByKey = indexed(input.verifier);
	const sim: Simulation = {
		mode,
		decisions: 0,
		acceptedExact: 0,
		acceptedExactIfRejectedIsNone: 0,
		unsafe: 0,
		verified: 0,
		confirmed: 0,
		rejected: 0,
		failed: 0,
		missing: [],
		unsafeRejected: 0,
		positivesBlocked: 0,
		ambiguousRejected: 0,
		addedP95Ms: null,
		totalP95Ms: null,
		costPer1000: 0,
		addedCostPer1000: 0,
	};
	const added: number[] = [];
	const totals: number[] = [];
	let cost = 0;
	let addedCost = 0;

	for (const parent of input.parents) {
		const expected = parent.expected.contradicts;
		if (!expected) continue;
		for (const [key, msObservation] of msByKey) {
			if (msObservation.caseId !== parent.id) continue;
			const lunaObservation = lunaByKey.get(key);
			if (!lunaObservation) continue;
			const vote = (question: string, observation: EvalObservation) =>
				voteOf(parent, observation, question, minConfidence);
			const msKind = vote("kind", msObservation);
			const msContradicts = vote("contradicts", msObservation);
			const kind = chain(msKind, () => vote("kind", lunaObservation));
			const final = chain(msContradicts, () => vote("contradicts", lunaObservation));
			const escalatedLuna = !msKind.accepted || !msContradicts.accepted;
			const escalatedRetirement = !msContradicts.accepted;
			let spend = callCost(msObservation);
			let latency = msObservation.durationMs;
			if (escalatedLuna) {
				spend += callCost(lunaObservation);
				latency += lunaObservation.durationMs;
			}

			const proposed =
				final.accepted && final.choice !== undefined && final.choice !== NONE
					? final.choice
					: undefined;
			const check =
				proposed !== undefined &&
				(mode === "every" || (mode === "escalated" && escalatedRetirement));
			let rejected = false;
			let extraMs = 0;
			let extraCost = 0;
			if (check && proposed !== undefined) {
				const verifierObservation = verifierByKey.get(
					keyOf(retirementCaseId(parent.id, proposed), msObservation.repetition),
				);
				if (!verifierObservation) {
					sim.missing.push({
						caseId: parent.id,
						item: proposed,
						repetition: msObservation.repetition,
					});
					continue;
				}
				sim.verified++;
				extraMs = verifierObservation.durationMs;
				extraCost = callCost(verifierObservation);
				const ok = verifierObservation.status === "ok";
				const answer = verifierObservation.answers[RETIREMENT_QUESTION];
				const confirmed =
					ok &&
					answer?.confidence !== undefined &&
					retirementConfirmed(
						{
							[RETIREMENT_QUESTION]: {
								choice: answer.choice,
								confidence: answer.confidence,
							},
						},
						minConfidence,
					);
				rejected = !confirmed;
				if (confirmed) sim.confirmed++;
				else if (ok) sim.rejected++;
				else sim.failed++;
				added.push(extraMs);
			}

			sim.decisions++;
			totals.push(latency + extraMs);
			cost += spend + extraCost;
			addedCost += extraCost;
			const kindExact = kind.accepted && kind.correct;
			if (kind.accepted && kind.unsafe) sim.unsafe++;
			if (rejected) {
				if (final.unsafe) sim.unsafeRejected++;
				if (final.correct && expected.choices.includes(NONE)) sim.ambiguousRejected++;
				else if (final.correct) sim.positivesBlocked++;
				if (kindExact && expected.choices.includes(NONE)) sim.acceptedExactIfRejectedIsNone++;
				continue;
			}
			if (final.accepted && final.unsafe) sim.unsafe++;
			if (kindExact && final.accepted && final.correct) {
				sim.acceptedExact++;
				sim.acceptedExactIfRejectedIsNone++;
			}
		}
	}
	sim.addedP95Ms = percentile(added, 0.95);
	sim.totalP95Ms = percentile(totals, 0.95);
	sim.costPer1000 = sim.decisions === 0 ? 0 : (cost / sim.decisions) * 1000;
	sim.addedCostPer1000 = sim.decisions === 0 ? 0 : (addedCost / sim.decisions) * 1000;
	return sim;
}

const VARIANTS: Record<VerifyMode, string> = {
	none: "no verification",
	escalated: "verify escalated only",
	every: "verify every retirement",
};

export function renderSimulations(
	rows: readonly { verifier: string; sims: readonly Simulation[] }[],
): string {
	const lines = [
		"| verifier | variant | accepted-exact | if a rejection keeps the item | unsafe | checked (confirmed / rejected / failed) | unsafe stopped | positives blocked | ambiguous rejected | p95 added ms | p95 total ms | $/1k | added $/1k | missing pairs |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const { verifier, sims } of rows)
		for (const s of sims) {
			const rate = (n: number) =>
				`${pct(s.decisions === 0 ? null : n / s.decisions)} (${n}/${s.decisions})`;
			lines.push(
				`| ${verifier} | ${VARIANTS[s.mode]} | ${rate(s.acceptedExact)} | ${rate(s.acceptedExactIfRejectedIsNone)} | ${s.unsafe} | ${s.verified} (${s.confirmed} / ${s.rejected} / ${s.failed}) | ${s.unsafeRejected} | ${s.positivesBlocked} | ${s.ambiguousRejected} | ${ms(s.addedP95Ms)} | ${ms(s.totalP95Ms)} | ${s.costPer1000.toFixed(4)} | ${s.addedCostPer1000.toFixed(4)} | ${s.missing.length} |`,
			);
		}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const readObservations = (dir: string) =>
	parseObservations(
		readFileSync(join(resolve(dir), "observations.jsonl"), "utf8"),
		join(dir, "observations.jsonl"),
	);

async function main(argv: readonly string[]): Promise<void> {
	const [command, ...rest] = argv;
	const { values } = parseArgs({
		args: rest,
		options: {
			run: { type: "string" },
			capture: { type: "string" },
			"verifier-run": { type: "string" },
			split: { type: "string", default: "holdout" },
			top: { type: "string", default: "3" },
			out: { type: "string" },
		},
	});
	const split = String(values.split);
	const emit = (text: string) =>
		values.out ? writeFileSync(String(values.out), text) : process.stdout.write(text);
	if (command === "screen" && values.run) {
		const cases = RETIREMENT_CASES.filter((c) => c.split === "development");
		const rows = screenRows(cases, readObservations(values.run));
		emit(renderScreen(rows, Number(values.top)));
		return;
	}
	if (command === "simulate" && values.capture && values["verifier-run"]) {
		const { CASES } = await import("./cases.ts");
		const parents = CASES.filter((c) => c.task === "supersession" && c.split === split);
		const ids = new Set(parents.map((c) => c.id));
		const capture = readObservations(values.capture).filter((o) => ids.has(o.caseId));
		const verifierObservations = readObservations(values["verifier-run"]);
		const verifiers = [...new Set(verifierObservations.map((o) => o.model))];
		const rows = verifiers.map((verifier) => {
			const input: SimulationInput = {
				parents,
				ms: capture.filter((o) => o.model === MS),
				luna: capture.filter((o) => o.model === LUNA),
				verifier: verifierObservations.filter((o) => o.model === verifier),
			};
			return {
				verifier: `\`${verifier}\``,
				sims: (["none", "escalated", "every"] as const).map((mode) => simulate(input, mode)),
			};
		});
		emit(renderSimulations(rows));
		return;
	}
	throw new Error(
		"usage: retirement-report.ts screen --run <dir> | simulate --capture <dir> --verifier-run <dir>",
	);
}

if (import.meta.main) await main(process.argv.slice(2));
