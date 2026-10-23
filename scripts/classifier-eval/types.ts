import type { ClassifierContext } from "@earendil-works/pi-ai";
import type {
  MilestoneRecord,
  MilestoneStructure,
} from "../../extensions/navigate-tree/milestone-classifier.ts";

/** The independent decisions measured by this benchmark. */
export type EvalTask =
  | "intent"
  | "supersession"
  | "milestone-status"
  | "milestone-boundary";

/** Shared choice question, translated into the selected provider's contract. */
export interface EvalQuestion {
  instructions: string;
  choices: Record<string, string>;
}

/** A reference answer set and explicitly unsafe alternatives. */
export interface ExpectedAnswer {
  choices: string[];
  unsafeChoices: string[];
  rationale: string;
}

/** Production-shaped classifier input; requests are built by the shipped builders. */
export type EvalInput =
  | {
      type: "intent";
      /** The user's raw message, exactly as typed; no annotator commentary. */
      message: string;
      activeAnchor?: string;
      activeItems: { id: string; kind: string; text: string }[];
    }
  | {
      type: "milestone";
      lastAnchor?: string;
      records: MilestoneRecord[];
      /** Session structure shown with the records; absent in the base request. */
      structure?: MilestoneStructure;
    };

/** A synthetic evaluation case; expected answers must never enter a model request. */
export interface EvalCase {
  id: string;
  split: "development" | "holdout";
  family: string;
  /** The decision this case stresses; every expected question is still scored. */
  task: EvalTask;
  input: EvalInput;
  expected: Record<string, ExpectedAnswer>;
}

/** A case with the exact request the production builder sends. */
export interface PreparedCase extends EvalCase {
  context: ClassifierContext;
  questions: Record<string, EvalQuestion>;
}

/** Normalized model answer; confidence may be absent and is not assumed calibrated. */
export interface EvalAnswer {
  choice: string;
  confidence?: number;
}

/** How a candidate answers: a decision endpoint, a structured chat model, or local code. */
export type EvalAdapter = "decisions" | "chat" | "heuristic";

/** Where `costUsd` came from; catalog-computed usage is never billing evidence. */
export type CostSource = "generation" | "response" | "local" | "unknown";

/** A transport attempt with no credential/header fields; one JSONL line per attempt. */
export interface EvalObservation {
  caseId: string;
  /** `adapter:provider/model`, e.g. `decisions:typesafe/jev-1.14`. */
  model: string;
  adapter: EvalAdapter;
  repetition: number;
  status: "ok" | "error" | "unsupported";
  answers: Record<string, EvalAnswer>;
  durationMs: number;
  costUsd: number | null;
  costSource: CostSource;
  /** The worst case reserved in the budget ledger before dispatch. */
  costBoundUsd: number;
  /** Provider generation ID used for billing reconciliation. */
  generationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** SHA-256 of the exact serialized request body. */
  requestSha256?: string;
  /** ISO timestamp at dispatch. */
  startedAt: string;
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
