/** Chat-stage question formatting, answer schema, and response parsing. */

import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { StageAnswer } from "./intent-policy.ts";
import { isRecord } from "./intent-policy-settings.ts";

// The message sits inside the JSON state and the model is told to judge only
// that state, so the user's words are data to it, not instructions.
export const CHAT_SYSTEM_PROMPT =
	"You classify structured state. For every question, choose exactly one choice key from its list and judge only the state provided. " +
	'Reply with a single JSON object and nothing else, shaped {"answers": {"<question id>": {"choice": "<choice key>", "confidence": <number from 0 to 1, your probability that the choice is correct>}}}. Answer every question.';

/** Offered choice keys by question id. */
type ChoiceKeys = Record<string, string[]>;

export function choiceKeys(context: ClassifierContext): ChoiceKeys {
	return Object.fromEntries(
		Object.entries(context.questions).flatMap(([id, question]) =>
			question.type === "choice" ? [[id, Object.keys(question.criteria)]] : [],
		),
	);
}

export function chatPrompt(context: ClassifierContext): string {
	const questions = Object.entries(context.questions).flatMap(([id, q]) =>
		q.type === "choice"
			? [
					`## ${id}\n${q.instructions}\nChoices:\n${Object.entries(q.criteria)
						.map(([key, description]) => `- ${key}: ${description}`)
						.join("\n")}`,
				]
			: [],
	);
	return `State:\n${JSON.stringify(context.state)}\n\nQuestions:\n\n${questions.join("\n\n")}`;
}

/** Strict JSON schema of the chat answer; `choice` is limited to each question's keys. */
export function answerSchema(questions: ChoiceKeys) {
	return {
		type: "object",
		properties: {
			answers: {
				type: "object",
				properties: Object.fromEntries(
					Object.entries(questions).map(([id, keys]) => [
						id,
						{
							type: "object",
							properties: {
								choice: { type: "string", enum: keys },
								confidence: { type: "number" },
							},
							required: ["choice", "confidence"],
							additionalProperties: false,
						},
					]),
				),
				required: Object.keys(questions),
				additionalProperties: false,
			},
		},
		required: ["answers"],
		additionalProperties: false,
	};
}

export function parseChatAnswers(text: string, questions: ChoiceKeys): Record<string, StageAnswer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		return {};
	}
	const raw = isRecord(parsed) ? parsed["answers"] : undefined;
	const answers: Record<string, StageAnswer> = {};
	if (!isRecord(raw)) return answers;
	for (const [id, keys] of Object.entries(questions)) {
		const entry = raw[id];
		if (
			isRecord(entry) &&
			typeof entry["choice"] === "string" &&
			keys.includes(entry["choice"]) &&
			typeof entry["confidence"] === "number" &&
			entry["confidence"] >= 0 &&
			entry["confidence"] <= 1
		) {
			answers[id] = { choice: entry["choice"], confidence: entry["confidence"] };
		}
	}
	return answers;
}
