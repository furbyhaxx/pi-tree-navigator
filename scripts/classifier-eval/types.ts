/** JSON evidence supplied to a classifier, never the expected answer. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The independent decisions measured by this benchmark. */
export type EvalTask = "intent" | "supersession" | "milestone" | "fold-readiness" | "authority";

/** Shared choice question, translated into the selected provider's contract. */
export interface EvalQuestion {
  instructions: string;
  choices: Record<string, string>;
}

/** A reviewed acceptable answer set and explicitly unsafe alternatives. */
export interface ExpectedAnswer {
  choices: string[];
  unsafeChoices: string[];
  rationale: string;
}

/** A synthetic evaluation case; expected answers must never enter a model request. */
export interface EvalCase {
  id: string;
  split: "development" | "holdout";
  family: string;
  task: EvalTask;
  state: JsonValue;
  questions: Record<string, EvalQuestion>;
  expected: Record<string, ExpectedAnswer>;
}

/** Normalized model answer; confidence may be absent and is not assumed calibrated. */
export interface EvalAnswer {
  choice: string;
  confidence?: number;
}

/** A transport attempt with no credential/header fields. */
export interface EvalObservation {
  caseId: string;
  model: string;
  repetition: number;
  status: "ok" | "error" | "unsupported";
  answers: Record<string, EvalAnswer>;
  durationMs: number;
  costUsd: number | null;
  costBoundUsd: number;
  error?: string;
}

/** Per-answer measurements separate wrong decisions from abstention and invalid output. */
export interface AnswerScore {
  question: string;
  valid: boolean;
  correct: boolean;
  accepted: boolean;
  unsafe: boolean;
  confidence?: number;
}

/** The complete decision result for one case and one model attempt. */
export interface CaseScore {
  caseId: string;
  task: EvalTask;
  split: EvalCase["split"];
  model: string;
  repetition: number;
  status: EvalObservation["status"];
  answers: AnswerScore[];
  exact: boolean;
  acceptedExact: boolean;
  unsafeAccepted: number;
  durationMs: number;
  costUsd: number | null;
  costBoundUsd: number;
}
