import type { ClassifierContext } from "@earendil-works/pi-ai";
import { buildIntentClassifierContext } from "../../extensions/navigate-tree/continuity-capture.ts";
import { buildMilestoneClassifierContext } from "../../extensions/navigate-tree/milestone-classifier.ts";
import { buildRetirementCheckContext } from "../../extensions/navigate-tree/retirement-check.ts";
import type { EvalCase, EvalQuestion, PreparedCase } from "./types.ts";

/** The choice questions of a request; any other question type is a benchmark error. */
export function choiceQuestions(
  caseId: string,
  context: ClassifierContext,
): Record<string, EvalQuestion> {
  const questions: Record<string, EvalQuestion> = {};
  for (const [id, question] of Object.entries(context.questions)) {
    if (question.type !== "choice")
      throw new Error(`${caseId}: question ${id} is not a choice`);
    questions[id] = {
      instructions: question.instructions,
      choices: { ...question.criteria },
    };
  }
  return questions;
}

/** Build the production request for a case and check its references against it. */
export function prepareCase(fixture: EvalCase): PreparedCase {
  const { context } =
    fixture.input.type === "intent"
      ? buildIntentClassifierContext({
          entryId: fixture.id,
          text: fixture.input.message,
          ...(fixture.input.activeAnchor !== undefined && {
            activeAnchor: fixture.input.activeAnchor,
          }),
          activeItems: fixture.input.activeItems,
        })
      : fixture.input.type === "retirement"
        ? buildRetirementCheckContext(fixture.input)
        : buildMilestoneClassifierContext(fixture.input);
  const questions = choiceQuestions(fixture.id, context);
  for (const [id, expected] of Object.entries(fixture.expected)) {
    const question = questions[id];
    if (!question)
      throw new Error(`${fixture.id}: expected answer for unsent ${id}`);
    for (const choice of [...expected.choices, ...expected.unsafeChoices])
      if (!Object.hasOwn(question.choices, choice))
        throw new Error(`${fixture.id}: ${id} has no choice ${choice}`);
    if (expected.choices.length === 0)
      throw new Error(`${fixture.id}: ${id} has no expected choice`);
    if (expected.choices.some((c) => expected.unsafeChoices.includes(c)))
      throw new Error(`${fixture.id}: ${id} marks an expected choice unsafe`);
  }
  for (const id of Object.keys(questions))
    if (!fixture.expected[id])
      throw new Error(`${fixture.id}: sent question ${id} has no reference`);
  return { ...fixture, context, questions };
}
