import assert from "node:assert/strict";
import { test } from "bun:test";
import { heuristicClassifier } from "../../extensions/navigate-tree/continuity-capture.ts";
import { CASE_LANGUAGES, CASES } from "./cases.ts";
import { prepareCase } from "./prepare.ts";
import type { EvalCase, EvalTask } from "./types.ts";

const TASKS: EvalTask[] = [
  "intent",
  "supersession",
  "milestone-status",
  "milestone-boundary",
];
const SPLITS: EvalCase["split"][] = ["development", "holdout"];
const KINDS = [
  "objective",
  "sub-goal",
  "rule",
  "decision",
  "steering",
  "ephemeral",
];
const PROTECTED = new Set(["rule", "decision", "objective"]);
const ID_PREFIX: Record<string, string> = {
  objective: "G",
  "sub-goal": "S",
  rule: "R",
  decision: "D",
  steering: "T",
};
const STATUSES = ["continue", "milestone", "await-user", "blocked"];
const MAX_MESSAGE_CHARS = 3_800;
const MAX_ITEM_CHARS = 200;
const MAX_RECORDS = 24;
const MAX_RECORD_CHARS = 680;
const MAX_STATE_BYTES = 3_000;
const MIN_HOLDOUT_PER_CLASS = 3;
const MAX_STRUCTURE_TEXT_CHARS = 300;
const MAX_STRUCTURE_ITEMS = 12;
const COUNTS = { development: 16, holdout: 32 } as const;

const LEAK_PATTERNS: RegExp[] = [
  /classif/i,
  /expected/i,
  /label/i,
  /the answer/i,
  /this is a rule/i,
  /not a lasting/i,
  /annotat/i,
  /ground truth/i,
  /rationale/i,
  /correct choice/i,
  /\bunsafe\b/i,
  /[[(](rule|decision|objective|sub-goal|steering|ephemeral|milestone|await-user|blocked)[\])]/i,
];

const userCases = CASES.filter(
  (c) => c.task === "intent" || c.task === "supersession",
);
const milestoneCases = CASES.filter((c) => c.input.type === "milestone");
const sorted = (values: readonly string[]) => [...values].sort();

function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(textsOf);
  return [];
}
const idsOf = (c: EvalCase) =>
  c.input.type === "milestone" ? c.input.records.map((r) => r.id) : [];

function milestoneInput(c: EvalCase) {
  assert.equal(c.input.type, "milestone");
  return c.input;
}

function intentInput(c: EvalCase) {
  assert.equal(c.input.type, "intent");
  return c.input;
}

test("case ids are unique and every task uses its own input type", () => {
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const c of CASES) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)+$/, c.id);
    assert.equal(
      c.input.type,
      c.task.startsWith("milestone") ? "milestone" : "intent",
      c.id,
    );
    assert.ok(CASE_LANGUAGES.has(c.id), `${c.id} has no language`);
  }
});

test("each task has 16 development and 32 holdout cases", () => {
  assert.equal(CASES.length, 4 * (COUNTS.development + COUNTS.holdout));
  for (const task of TASKS)
    for (const split of SPLITS)
      assert.equal(
        CASES.filter((c) => c.task === task && c.split === split).length,
        COUNTS[split],
        `${task}/${split}`,
      );
});

test("holdout cases come from many independent families", () => {
  for (const task of TASKS) {
    const families = new Set(
      CASES.filter((c) => c.task === task && c.split === "holdout").map(
        (c) => c.family,
      ),
    );
    assert.ok(families.size >= 10, `${task}: ${families.size} families`);
  }
});

test("no family spans development and holdout", () => {
  const splits = new Map<string, Set<string>>();
  for (const c of CASES) {
    assert.ok(c.family.length > 0, c.id);
    splits.set(c.family, (splits.get(c.family) ?? new Set()).add(c.split));
  }
  for (const [family, seen] of splits)
    assert.equal(seen.size, 1, `family ${family} spans both splits`);
});

test("inputs stay inside the limits where truncation would change a reference", () => {
  for (const c of CASES) {
    if (c.input.type === "intent") {
      assert.ok(c.input.message.length <= MAX_MESSAGE_CHARS, c.id);
      assert.ok(c.input.activeItems.length <= 8, c.id);
      if (c.task === "supersession")
        assert.ok(
          c.input.activeItems.length >= 2 && c.input.activeItems.length <= 8,
          `${c.id} needs 2-8 active items`,
        );
      const numbers = new Set<string>();
      for (const i of c.input.activeItems) {
        assert.ok(i.text.length <= MAX_ITEM_CHARS, `${c.id} ${i.id}`);
        assert.doesNotMatch(i.text, /\s{2}|\n/, `${c.id} ${i.id}`);
        const prefix =
          ID_PREFIX[i.kind] ?? assert.fail(`${c.id} ${i.id}: kind ${i.kind}`);
        assert.match(i.id, new RegExp(`^${prefix}[1-9]\\d*$`), c.id);
        numbers.add(i.id.slice(1));
      }
      assert.equal(numbers.size, c.input.activeItems.length, c.id);
    } else if (c.input.type === "milestone") {
      const { records } = c.input;
      assert.ok(records.length >= 3 && records.length <= MAX_RECORDS, c.id);
      assert.equal(new Set(idsOf(c)).size, records.length, c.id);
      for (const r of records)
        assert.ok(r.text.length > 0 && r.text.length <= MAX_RECORD_CHARS, c.id);
      assert.equal(records[0].role, "user", c.id);
    }
  }
});

test("prepared requests carry every reference and keep the text unchanged", () => {
  for (const c of CASES) {
    const prepared = prepareCase(c);
    const state = prepared.context.state as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(prepared.questions).sort(),
      Object.keys(c.expected).sort(),
      c.id,
    );
    if (c.input.type === "intent") {
      const hasItems = c.input.activeItems.length > 0;
      assert.deepEqual(
        Object.keys(prepared.questions).sort(),
        hasItems ? ["contradicts", "kind"] : ["kind"],
        c.id,
      );
      assert.equal(state.message, c.input.message, c.id);
      const byId = (x: { id: string }, y: { id: string }) =>
        x.id.localeCompare(y.id);
      assert.deepEqual(
        [...(state.activeItems as { id: string }[])].sort(byId),
        [...c.input.activeItems].sort(byId),
        c.id,
      );
    } else if (c.input.type === "milestone") {
      assert.ok(state.structure, `${c.id} sends no structure`);
      assert.deepEqual(
        Object.keys(prepared.questions).sort(),
        ["boundary", "status"],
        c.id,
      );
      assert.deepEqual(
        state.records,
        c.input.records.map(({ id, role, text }) => ({ id, role, text })),
        c.id,
      );
    }
  }
});

test("requests contain no annotator commentary or reference text", () => {
  const leaky = "This is one patch, not a lasting convention.";
  assert.ok(LEAK_PATTERNS.some((p) => p.test(leaky)));
  for (const c of CASES) {
    const context = prepareCase(c).context;
    const state = JSON.stringify(context.state);
    const text = textsOf(context.state).join("\n");
    for (const pattern of LEAK_PATTERNS)
      assert.doesNotMatch(text, pattern, `${c.id}: ${pattern}`);
    assert.ok(!state.includes(c.id), `${c.id} appears in its own request`);
    for (const answer of Object.values(c.expected))
      assert.ok(!state.includes(answer.rationale), c.id);
  }
});

test("every request state stays small", () => {
  for (const c of CASES) {
    const bytes = Buffer.byteLength(
      JSON.stringify(prepareCase(c).context.state),
    );
    assert.ok(bytes < MAX_STATE_BYTES, `${c.id}: ${bytes} bytes`);
  }
});

test("every milestone case carries session structure within the sent limits", () => {
  for (const c of milestoneCases) {
    const { structure } = milestoneInput(c);
    assert.ok(structure?.objective, `${c.id} has no objective`);
    const { goals = [], folds = [], anchors = [] } = structure;
    assert.ok(goals.length >= 1 && folds.length >= 1, c.id);
    for (const items of [goals, folds, anchors])
      assert.ok(items.length <= MAX_STRUCTURE_ITEMS, c.id);
    assert.equal(new Set(folds.map((f) => f.label)).size, folds.length, c.id);
    for (const fold of folds)
      assert.ok(fold.goal && fold.outcome, `${c.id} ${fold.label}`);
    for (const text of textsOf(structure))
      assert.ok(text.length <= MAX_STRUCTURE_TEXT_CHARS, `${c.id}: ${text}`);
  }
});

test("structure describes earlier phases and never marks the judged records", () => {
  for (const c of milestoneCases) {
    const { records, structure, lastAnchor } = milestoneInput(c);
    const ids = new Set(records.map((r) => r.id));
    const last = records[records.length - 1].id;
    const marked = new Set([...c.expected.boundary.choices, last]);
    const recordTexts = records.map((r) => r.text.toLowerCase());
    const { folds = [], anchors = [] } = structure ?? {};
    const named = { ...structure, anchors: anchors.map((a) => a.name) };
    for (const text of textsOf(named))
      for (const id of ids)
        assert.ok(!text.includes(id), `${c.id}: structure names record ${id}`);
    for (const fold of folds)
      for (const text of [fold.goal ?? "", fold.outcome ?? ""]) {
        const lower = text.toLowerCase();
        assert.ok(
          !recordTexts.some((r) => r.includes(lower) || lower.includes(r)),
          `${c.id}: ${fold.label} copies a record: ${text}`,
        );
      }
    const older = anchors.filter((a) => a.afterRecordId === undefined);
    assert.deepEqual(
      older.map((a) => a.name),
      lastAnchor === undefined ? [] : [lastAnchor],
      `${c.id}: anchors before the records must end in lastAnchor`,
    );
    for (const { name, afterRecordId } of anchors) {
      if (afterRecordId === undefined) continue;
      assert.ok(
        ids.has(afterRecordId),
        `${c.id}: ${name} follows no shown record`,
      );
      assert.ok(
        !marked.has(afterRecordId),
        `${c.id}: ${name} marks a boundary`,
      );
    }
  }
});

test("every reference has a short rationale", () => {
  for (const c of CASES)
    for (const [question, answer] of Object.entries(c.expected)) {
      assert.ok(answer.rationale.length > 20, `${c.id}/${question}`);
      assert.ok(answer.rationale.length <= 420, `${c.id}/${question}`);
    }
});

test("kind references mark lost protection and spurious protection as unsafe", () => {
  for (const c of userCases) {
    const { choices, unsafeChoices } = c.expected.kind;
    assert.ok(choices.length >= 1 && choices.length <= 3, c.id);
    for (const choice of choices) assert.ok(KINDS.includes(choice), c.id);
    const expectedUnsafe = choices.some((k) => PROTECTED.has(k))
      ? ["ephemeral"]
      : [...PROTECTED].filter((k) => !choices.includes(k));
    assert.deepEqual(sorted(unsafeChoices), sorted(expectedUnsafe), c.id);
  }
});

test("contradicts references mark false supersession as unsafe", () => {
  for (const c of userCases) {
    const items = intentInput(c).activeItems;
    const answer = c.expected.contradicts;
    if (items.length === 0) {
      assert.equal(answer, undefined, c.id);
      continue;
    }
    assert.ok(answer, `${c.id} needs a contradicts reference`);
    const ids = items.map((i) => i.id);
    for (const choice of answer.choices)
      assert.ok([...ids, "none"].includes(choice), c.id);
    assert.ok(!answer.unsafeChoices.includes("none"), c.id);
    if (answer.choices.length === 1 && answer.choices[0] === "none")
      assert.deepEqual(sorted(answer.unsafeChoices), sorted(ids), c.id);
    else
      assert.deepEqual(
        sorted(answer.unsafeChoices),
        sorted(ids.filter((id) => !answer.choices.includes(id))),
        c.id,
      );
    if (c.task === "intent") assert.deepEqual(answer.choices, ["none"], c.id);
  }
});

test("status references mark premature folds as unsafe", () => {
  for (const c of CASES.filter((x) => x.input.type === "milestone")) {
    const { choices, unsafeChoices } = c.expected.status;
    assert.equal(choices.length, 1, c.id);
    assert.ok(STATUSES.includes(choices[0]), c.id);
    assert.deepEqual(
      unsafeChoices,
      choices[0] === "continue" || choices[0] === "await-user"
        ? ["milestone"]
        : [],
      c.id,
    );
  }
});

test("boundary references mark folding unfinished work as unsafe", () => {
  for (const c of CASES.filter((x) => x.input.type === "milestone")) {
    const { records } = milestoneInput(c);
    const ids = records.map((r) => r.id);
    const { choices, unsafeChoices } = c.expected.boundary;
    if (choices.length === 1 && choices[0] === "none") {
      assert.deepEqual(unsafeChoices, ids, c.id);
      assert.notEqual(c.expected.status.choices[0], "milestone", c.id);
      continue;
    }
    const positions = choices.map((id) => ids.indexOf(id));
    assert.ok(!positions.includes(-1), `${c.id}: unknown boundary record`);
    assert.ok(!choices.includes("none"), c.id);
    for (const p of positions)
      assert.notEqual(records[p].role, "user", `${c.id}: phase ends on a user`);
    assert.deepEqual(
      unsafeChoices,
      ids.slice(Math.max(...positions) + 1),
      c.id,
    );
  }
});

test("every split covers each kind, status, boundary form and language", () => {
  for (const split of SPLITS) {
    const inSplit = (task: EvalTask) =>
      CASES.filter((c) => c.task === task && c.split === split);
    const kinds = new Set(
      inSplit("intent").flatMap((c) => c.expected.kind.choices),
    );
    for (const kind of KINDS)
      assert.ok(kinds.has(kind), `${split} kind ${kind}`);
    const contradicts = new Set(
      inSplit("supersession").flatMap((c) => c.expected.contradicts.choices),
    );
    assert.ok(contradicts.has("none"), `${split} none`);
    assert.ok(contradicts.size > 1, `${split} item reversal`);
    for (const task of ["milestone-status", "milestone-boundary"] as const) {
      const statuses = new Set(
        inSplit(task).flatMap((c) => c.expected.status.choices),
      );
      for (const status of STATUSES)
        assert.ok(statuses.has(status), `${split} ${task} status ${status}`);
      const boundaries = inSplit(task).map(
        (c) => c.expected.boundary.choices[0] === "none",
      );
      assert.ok(boundaries.includes(true) && boundaries.includes(false), task);
    }
    const languages = new Set(
      userCases
        .filter((c) => c.split === split)
        .map((c) => CASE_LANGUAGES.get(c.id)),
    );
    for (const language of ["en", "de", "gsw", "mixed"])
      assert.ok(languages.has(language as never), `${split} ${language}`);
  }
});

test("holdout has several cases for every reference class", () => {
  const holdout = (task: EvalTask) =>
    CASES.filter((c) => c.task === task && c.split === "holdout");
  for (const kind of KINDS)
    assert.ok(
      holdout("intent").filter((c) => c.expected.kind.choices.includes(kind))
        .length >= MIN_HOLDOUT_PER_CLASS,
      `intent ${kind}`,
    );
  for (const task of ["milestone-status", "milestone-boundary"] as const)
    for (const status of STATUSES)
      assert.ok(
        holdout(task).filter((c) => c.expected.status.choices[0] === status)
          .length >= MIN_HOLDOUT_PER_CLASS,
        `${task} ${status}`,
      );
});

test("intent cases separate marker words from marker-free instructions", async () => {
  let spuriousCapture = 0;
  let missedProtected = 0;
  for (const c of CASES.filter((x) => x.task === "intent")) {
    const input = intentInput(c);
    const verdict = await heuristicClassifier({
      entryId: c.id,
      text: input.message,
      activeItems: input.activeItems,
    });
    const protectedReference = c.expected.kind.choices.some((k) =>
      PROTECTED.has(k),
    );
    if (
      !protectedReference &&
      (PROTECTED.has(verdict.kind) || verdict.excerpts !== undefined)
    )
      spuriousCapture += 1;
    if (protectedReference && verdict.kind === "ephemeral" && !verdict.excerpts)
      missedProtected += 1;
  }
  assert.ok(spuriousCapture >= 3, `${spuriousCapture} cases trap marker words`);
  assert.ok(missedProtected >= 3, `${missedProtected} cases hide a marker`);
});
