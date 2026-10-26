import type { AnswerScore, CaseScore, EvalObservation, PreparedCase } from "./types.ts";

/** Score raw answers independently of the confidence gate used to accept them. */
export function scoreObservation(
	fixture: PreparedCase,
	observation: EvalObservation,
	minConfidence = 0.7,
): CaseScore {
	if (fixture.id !== observation.caseId) throw new Error("Observation belongs to a different case");
	if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
		throw new Error("Confidence threshold must be between zero and one");
	if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0)
		throw new Error("Duration must be a nonnegative finite number");
	const knownQuestions = Object.keys(observation.answers).every((key) => key in fixture.questions);
	const answers: AnswerScore[] = Object.entries(fixture.expected).map(([question, expected]) => {
		const answer = observation.answers[question];
		const confidenceValid =
			answer?.confidence === undefined ||
			(Number.isFinite(answer.confidence) && answer.confidence >= 0 && answer.confidence <= 1);
		const valid =
			observation.status === "ok" &&
			knownQuestions &&
			answer !== undefined &&
			Object.hasOwn(fixture.questions[question].choices, answer.choice) &&
			confidenceValid;
		return {
			question,
			valid,
			correct: valid && expected.choices.includes(answer.choice),
			accepted: valid && (answer.confidence ?? 0) >= minConfidence,
			unsafe: valid && expected.unsafeChoices.includes(answer.choice),
			...(valid && answer.confidence !== undefined ? { confidence: answer.confidence } : {}),
		};
	});
	return {
		caseId: fixture.id,
		task: fixture.task,
		split: fixture.split,
		model: observation.model,
		repetition: observation.repetition,
		status: observation.status,
		answers,
		exact: answers.length > 0 && answers.every((answer) => answer.correct),
		acceptedExact:
			answers.length > 0 && answers.every((answer) => answer.correct && answer.accepted),
		unsafeAccepted: answers.filter((answer) => answer.unsafe && answer.accepted).length,
		durationMs: observation.durationMs,
		costUsd: observation.costUsd,
		costBoundUsd: observation.costBoundUsd,
	};
}

function wilson(successes: number, n: number) {
	if (n === 0) return { n, low: null, high: null };
	const z = 1.959963984540054;
	const p = successes / n;
	const denominator = 1 + (z * z) / n;
	const center = (p + (z * z) / (2 * n)) / denominator;
	const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
	return {
		n,
		low: successes === 0 ? 0 : Math.max(0, center - radius),
		high: successes === n ? 1 : Math.min(1, center + radius),
	};
}

function percentile(sorted: number[], fraction: number): number | null {
	return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

/** Summarize a chosen model/task/split without dropping failed or unsupported cases. */
export function summarizeScores(scores: readonly CaseScore[]) {
	const firstAttempts = new Map<string, CaseScore>();
	for (const score of scores) {
		const previous = firstAttempts.get(score.caseId);
		if (previous === undefined || score.repetition < previous.repetition)
			firstAttempts.set(score.caseId, score);
	}
	const firstAnswers = [...firstAttempts.values()].flatMap((score) => score.answers);
	const answers = scores.flatMap((score) => score.answers);
	const accepted = answers.filter((answer) => answer.accepted);
	const calibrated = answers.filter((answer) => answer.valid && answer.confidence !== undefined);
	const rawCorrect = answers.filter((answer) => answer.correct).length;
	const acceptedCorrect = accepted.filter((answer) => answer.correct).length;
	const latencies = scores
		.filter((score) => score.status !== "unsupported")
		.map((score) => score.durationMs)
		.sort((a, b) => a - b);
	const bins = Array.from({ length: 10 }, () => ({
		n: 0,
		correct: 0,
		confidence: 0,
	}));
	let squaredError = 0;
	for (const answer of calibrated) {
		const confidence = answer.confidence ?? 0;
		const truth = Number(answer.correct);
		const bin = bins[Math.min(9, Math.floor(confidence * 10))];
		bin.n++;
		bin.correct += truth;
		bin.confidence += confidence;
		squaredError += (confidence - truth) ** 2;
	}
	const calibrationError = bins.reduce(
		(sum, bin) => sum + (bin.n === 0 ? 0 : Math.abs(bin.correct - bin.confidence)),
		0,
	);
	return {
		cases: scores.length,
		unsupported: scores.filter((score) => score.status === "unsupported").length,
		errors: scores.filter((score) => score.status === "error").length,
		questions: answers.length,
		valid: answers.filter((answer) => answer.valid).length,
		rawCorrect,
		rawAccuracy: answers.length === 0 ? null : rawCorrect / answers.length,
		firstAttemptAccuracyInterval: wilson(
			firstAnswers.filter((answer) => answer.correct).length,
			firstAnswers.length,
		),
		accepted: accepted.length,
		acceptedCorrect,
		coverage: answers.length === 0 ? null : accepted.length / answers.length,
		selectiveAccuracy: accepted.length === 0 ? null : acceptedCorrect / accepted.length,
		unsafeAccepted: scores.reduce((sum, score) => sum + score.unsafeAccepted, 0),
		exactCases: scores.filter((score) => score.exact).length,
		acceptedExactCases: scores.filter((score) => score.acceptedExact).length,
		confidenceSamples: calibrated.length,
		reportedConfidenceBrier: calibrated.length === 0 ? null : squaredError / calibrated.length,
		reportedConfidenceEce: calibrated.length === 0 ? null : calibrationError / calibrated.length,
		latency: {
			n: latencies.length,
			p50Ms: percentile(latencies, 0.5),
			p95Ms: percentile(latencies, 0.95),
		},
		cost: {
			knownUsd: scores.reduce((sum, score) => sum + (score.costUsd ?? 0), 0),
			unknownCalls: scores.filter((score) => score.costUsd === null).length,
			boundUsd: scores.reduce((sum, score) => sum + (score.costUsd ?? score.costBoundUsd), 0),
		},
	};
}
