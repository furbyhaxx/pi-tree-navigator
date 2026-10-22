/**
 * Tests for Session Continuity Ledger capture.
 *
 * Node test runner. Run with: pnpm test
 *
 * Branches are built from plain entries; the `ask_user` details are trimmed
 * copies of real session results (pi-ask `AskResult`). No model is called:
 * classifiers are scripted and the classifier registry is a fake.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ClassifierContext,
  ClassifierResult,
} from "@earendil-works/pi-ai";
import type {
  ModelRegistry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type CapturedOp,
  captureIntent,
  createModelClassifier,
  FOLD_REQUEST_RE,
  heuristicClassifier,
  INTENT_KINDS,
  type IntentClassifier,
  type IntentInput,
  type IntentKind,
  type IntentVerdict,
  MAX_CLASSIFIER_ITEMS,
  MAX_CLASSIFIER_MESSAGE_CHARS,
} from "./continuity-capture.ts";
import {
  applyOps,
  createLedger,
  type Ledger,
  MAX_ITEM_TEXT_CHARS,
  TRUNCATION_MARKER,
} from "./continuity-ledger.ts";

const base = (id: string) => ({
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
});

const user = (id: string, text: string): SessionEntry =>
  ({
    type: "message",
    ...base(id),
    message: { role: "user", content: text, timestamp: 0 },
  }) as SessionEntry;

const toolResult = (
  id: string,
  details: unknown,
  extra: { isError?: boolean; toolName?: string } = {},
): SessionEntry =>
  ({
    type: "message",
    ...base(id),
    message: {
      role: "toolResult",
      toolCallId: "call",
      toolName: extra.toolName ?? "ask_user",
      content: [{ type: "text", text: "summary" }],
      details,
      isError: extra.isError ?? false,
      timestamp: 0,
    },
  }) as SessionEntry;

const filler = (id: string): SessionEntry =>
  ({
    type: "model_change",
    ...base(id),
    provider: "p",
    modelId: "m",
  }) as SessionEntry;

const label = (
  id: string,
  targetId: string,
  value: string | undefined,
): SessionEntry =>
  ({ type: "label", ...base(id), targetId, label: value }) as SessionEntry;

const foldSummary = (id: string): SessionEntry =>
  ({
    type: "branch_summary",
    ...base(id),
    fromId: "x",
    summary: "folded",
  }) as SessionEntry;

// Real ask_user result: two single-choice questions answered with labels.
const ASK_ANSWERED = {
  cancelled: false,
  mode: "submit",
  questions: [
    {
      id: "image_model",
      label: "Image model",
      prompt: "Which default should 07_image_output use?",
      type: "single",
    },
    {
      id: "persist_list",
      label: "Model list",
      prompt: "Should I store your model list in the repo?",
      type: "single",
    },
  ],
  answers: {
    image_model: {
      values: ["openrouter/google/gemini-3.1-flash-image"],
      labels: ["gemini-3.1-flash-image"],
      indices: [1],
    },
    persist_list: {
      values: ["yes"],
      labels: ["Store it + AGENTS.md rule"],
      indices: [1],
    },
  },
};

// Real ask_user result where the user wrote an "Other" answer: the custom text
// is both the only label and `customText`.
const CUSTOM_TEXT =
  "but our pi extension still works so it looks like a bug, maybe also analyze opencode-v2 source to get it working";
const ASK_CUSTOM = {
  cancelled: false,
  mode: "submit",
  questions: [
    {
      id: "opencode_generation",
      label: "OpenCode chat",
      prompt:
        "What should step 4 do with OpenCode generation and those headers?",
      type: "single",
    },
  ],
  answers: {
    opencode_generation: {
      values: [CUSTOM_TEXT],
      labels: [CUSTOM_TEXT],
      indices: [],
      customText: CUSTOM_TEXT,
    },
  },
};

const RULE_TEXT =
  "From now on, always run the full test suite before you commit.";

/** Scripted classifier: verdict by message text, else ephemeral. Records every input. */
function scripted(
  verdicts: Record<string, Partial<IntentVerdict>> = {},
): IntentClassifier & { inputs: IntentInput[] } {
  const inputs: IntentInput[] = [];
  const classifier = (async (input: IntentInput) => {
    inputs.push(input);
    return { kind: "ephemeral", by: "classifier", ...verdicts[input.text] };
  }) as IntentClassifier & { inputs: IntentInput[] };
  classifier.inputs = inputs;
  return classifier;
}

const verdict = (
  kind: IntentKind,
  supersedes?: readonly string[],
): Partial<IntentVerdict> => ({
  kind,
  by: "classifier",
  ...(supersedes && { supersedes }),
});

function apply(ledger: Ledger, captured: readonly CapturedOp[]) {
  let current = ledger;
  const effects: string[] = [];
  const rejected: { code: string }[] = [];
  for (const { op, ctx } of captured) {
    const result = applyOps(current, [op], ctx);
    current = result.ledger;
    effects.push(...result.applied.map((a) => a.effect));
    rejected.push(...result.rejected.map((r) => ({ code: r.reason.code })));
  }
  return { ledger: current, effects, rejected };
}

const active = (ledger: Ledger) =>
  ledger.items.filter((item) => item.status === "active");

describe("ask_user capture", () => {
  it("records each answered question as a decision owned by the user", async () => {
    const branch = [filler("m0"), toolResult("t1", ASK_ANSWERED)];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.equal(result.classified, 0);
    assert.deepEqual(
      result.ops.map(({ op, ctx }) => [op, ctx.origin, ctx.entryId]),
      [
        [
          {
            op: "add",
            kind: "decision",
            text: "Q: Which default should 07_image_output use? → A: gemini-3.1-flash-image",
            quote: "gemini-3.1-flash-image",
          },
          "ask_user",
          "t1",
        ],
        [
          {
            op: "add",
            kind: "decision",
            text: "Q: Should I store your model list in the repo? → A: Store it + AGENTS.md rule",
            quote: "Store it + AGENTS.md rule",
          },
          "ask_user",
          "t1",
        ],
      ],
    );
    const { ledger, rejected } = apply(createLedger(), result.ops);
    assert.deepEqual(rejected, []);
    assert.deepEqual(
      ledger.items.map((i) => [i.id, i.kind, i.source]),
      [
        ["D1", "decision", { entryId: "t1", origin: "ask_user" }],
        ["D2", "decision", { entryId: "t1", origin: "ask_user" }],
      ],
    );
  });

  it("keeps a custom 'other' answer verbatim in the quote", async () => {
    const result = await captureIntent(
      [toolResult("t1", ASK_CUSTOM)],
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.equal(result.ops.length, 1);
    const [{ op }] = result.ops;
    assert.equal(op.op === "add" && op.quote, CUSTOM_TEXT);
    assert.ok(op.op === "add" && op.text?.endsWith(`→ A: ${CUSTOM_TEXT}`));
  });

  it("records every chosen label of a multi-select answer", async () => {
    const details = {
      cancelled: false,
      mode: "submit",
      questions: [{ id: "q", label: "Targets", prompt: "Which targets?" }],
      answers: {
        q: { values: ["a", "b"], labels: ["Linux", "macOS"], indices: [1, 2] },
      },
    };
    const result = await captureIntent(
      [toolResult("t1", details)],
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    const [{ op }] = result.ops;
    assert.ok(
      op.op === "add" && op.text === "Q: Which targets? → A: Linux, macOS",
    );
  });

  it("keeps the answer when a long question hits the text cap", async () => {
    const details = {
      ...ASK_ANSWERED,
      questions: [
        { id: "image_model", label: "Q", prompt: "word ".repeat(300) },
      ],
    };
    const result = await captureIntent(
      [toolResult("t1", details)],
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    const [{ op }] = result.ops;
    assert.ok(op.op === "add" && op.text !== undefined);
    assert.ok(op.text.length <= MAX_ITEM_TEXT_CHARS);
    assert.ok(op.text.endsWith("→ A: gemini-3.1-flash-image"));
    assert.ok(op.text.includes(TRUNCATION_MARKER));
  });

  it("ignores cancelled, errored, elaborating, unanswered and foreign results", async () => {
    const branch = [
      toolResult("t1", { ...ASK_ANSWERED, cancelled: true }),
      toolResult("t2", ASK_ANSWERED, { isError: true }),
      toolResult("t3", { ...ASK_ANSWERED, mode: "elaborate" }),
      toolResult("t4", { ...ASK_ANSWERED, answers: {} }),
      toolResult("t5", {
        ...ASK_ANSWERED,
        answers: {
          image_model: { values: [], labels: [], indices: [], note: "hmm" },
        },
      }),
      toolResult("t6", { ...ASK_ANSWERED, error: { kind: "invalid_input" } }),
      toolResult("t7", ASK_ANSWERED, { toolName: "bash" }),
      toolResult("t8", "not an object"),
    ];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.deepEqual(result.ops, []);
  });
});

describe("user message capture", () => {
  it("keeps the user's exact words as a user-owned rule that agents cannot archive", async () => {
    const branch = [user("u1", `  ${RULE_TEXT}  `)];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.deepEqual(
      result.ops.map(({ op, ctx }) => [op, ctx.origin, ctx.entryId]),
      [
        [
          { op: "add", kind: "rule", text: RULE_TEXT, quote: RULE_TEXT },
          "user",
          "u1",
        ],
      ],
    );
    const { ledger, rejected } = apply(createLedger(), result.ops);
    assert.deepEqual(rejected, []);
    const [rule] = ledger.items;
    assert.equal(rule?.id, "R1");
    assert.deepEqual(rule?.source, { entryId: "u1", origin: "user" });

    const archived = applyOps(ledger, [{ op: "archive", id: "R1" }], {
      origin: "agent",
    });
    assert.deepEqual(
      archived.rejected.map((r) => r.reason.code),
      ["protected_item"],
    );
    assert.equal(archived.ledger.items[0]?.status, "active");
  });

  it("skips short, slash-command, own and empty messages without classifying them", async () => {
    const classifier = scripted({ [RULE_TEXT]: verdict("rule") });
    const branch = [
      user("u1", "ok"),
      user("u2", "/tree-clone old-session"),
      user(
        "u3",
        "[navigate_tree auto_navigate] Completed milestone 'x' ready to fold.",
      ),
      user("u4", "                "),
      user("u5", "/mnt/work/notes.md has the details, always read it first"),
      user("u6", RULE_TEXT),
    ];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      classifier,
    );
    assert.deepEqual(
      classifier.inputs.map((i) => i.entryId),
      ["u5", "u6"],
    );
    assert.equal(result.classified, 2);
  });

  it("scans only after the watermark, or after the last fold when it is unknown", async () => {
    const classifier = scripted();
    const branch = [
      user("u1", "an early message that is long enough"),
      foldSummary("s1"),
      user("u2", "a message after the fold, long enough"),
      user("u3", "a later message after the fold, long enough"),
    ];
    const fromFold = await captureIntent(
      branch,
      undefined,
      createLedger(),
      classifier,
    );
    assert.deepEqual(
      classifier.inputs.map((i) => i.entryId),
      ["u2", "u3"],
    );
    assert.equal(fromFold.watermark, "u3");

    classifier.inputs.length = 0;
    const fromMark = await captureIntent(
      branch,
      "u2",
      createLedger(),
      classifier,
    );
    assert.deepEqual(
      classifier.inputs.map((i) => i.entryId),
      ["u3"],
    );
    assert.equal(fromMark.watermark, "u3");

    classifier.inputs.length = 0;
    const stale = await captureIntent(
      branch,
      "gone",
      createLedger(),
      classifier,
    );
    assert.deepEqual(
      classifier.inputs.map((i) => i.entryId),
      ["u2", "u3"],
    );
    assert.equal(stale.watermark, "u3");

    classifier.inputs.length = 0;
    const nothingNew = await captureIntent(
      branch,
      "u3",
      createLedger(),
      classifier,
    );
    assert.deepEqual(classifier.inputs, []);
    assert.deepEqual(nothingNew, {
      ops: [],
      watermark: "u3",
      classified: 0,
      warnings: [],
    });
  });

  it("hands the classifier the active items and the anchor in force", async () => {
    const seeded = apply(createLedger(), [
      {
        op: { op: "add", kind: "rule", text: "Use tabs" },
        ctx: { origin: "user", entryId: "u0" },
      },
      {
        op: { op: "add", kind: "fact", text: "The repo uses pnpm" },
        ctx: { origin: "agent" },
      },
    ]).ledger;
    const classifier = scripted();
    const branch = [
      user("u0", "Use tabs from now on, please."),
      filler("f1"),
      label("l1", "f1", "anchor:impl"),
      user("u2", "A message after the anchor was set."),
    ];
    await captureIntent(branch, "u0", seeded, classifier);
    assert.deepEqual(classifier.inputs, [
      {
        entryId: "u2",
        text: "A message after the anchor was set.",
        activeAnchor: "impl",
        activeItems: [{ id: "R1", kind: "rule", text: "Use tabs" }],
      },
    ]);
  });

  it("aborting returns no ops and leaves the watermark where it was", async () => {
    const controller = new AbortController();
    const classifier: IntentClassifier = async () => {
      controller.abort();
      return { kind: "rule", by: "classifier" };
    };
    const result = await captureIntent(
      [user("u1", RULE_TEXT), toolResult("t1", ASK_ANSWERED)],
      undefined,
      createLedger(),
      classifier,
      { signal: controller.signal },
    );
    assert.deepEqual(result.ops, []);
    assert.equal(result.watermark, undefined);
  });
});

describe("repeated ask_user answers", () => {
  const PROMPT = "Which default should 07_image_output use?";
  const ask = (id: string, chosen: string, prompt = PROMPT) =>
    toolResult(id, {
      cancelled: false,
      mode: "submit",
      questions: [{ id: "image_model", label: "Image model", prompt }],
      answers: {
        image_model: { values: [chosen], labels: [chosen], indices: [1] },
      },
    });
  const capture = (
    branch: SessionEntry[],
    ledger: Ledger,
    watermark?: string,
  ) => captureIntent(branch, watermark, ledger, heuristicClassifier);
  const texts = (ledger: Ledger) => active(ledger).map((i) => i.text);

  it("a later answer supersedes the earlier one, citing the new entry", async () => {
    const first = await capture([ask("t1", "flash")], createLedger());
    const once = apply(createLedger(), first.ops).ledger;
    assert.deepEqual(texts(once), [`Q: ${PROMPT} \u2192 A: flash`]);

    const branch = [ask("t1", "flash"), filler("f1"), ask("t2", "pro")];
    const second = await capture(branch, once, "t1");
    assert.deepEqual(
      second.ops.map(({ op }) => op.op),
      ["supersede"],
    );
    const [{ op, ctx }] = second.ops;
    assert.ok(op.op === "supersede");
    assert.deepEqual(op.ids, ["D1"]);
    assert.equal(op.citedEntryId, "t2");
    assert.deepEqual([ctx.origin, ctx.entryId], ["ask_user", "t2"]);

    const twice = apply(once, second.ops);
    assert.deepEqual(twice.rejected, []);
    assert.deepEqual(twice.effects, ["superseded"]);
    assert.deepEqual(texts(twice.ledger), [`Q: ${PROMPT} \u2192 A: pro`]);
    assert.deepEqual(active(twice.ledger)[0]?.source, {
      entryId: "t2",
      origin: "ask_user",
    });
  });

  it("answers repeated within one scan collapse to the newest", async () => {
    const branch = [ask("t1", "flash"), ask("t2", "pro"), ask("t3", "ultra")];
    const result = await capture(branch, createLedger());
    assert.deepEqual(
      result.ops.map(({ ctx }) => ctx.entryId),
      ["t3"],
    );
    const { ledger, rejected } = apply(createLedger(), result.ops);
    assert.deepEqual(rejected, []);
    assert.deepEqual(texts(ledger), [`Q: ${PROMPT} \u2192 A: ultra`]);

    const rescanned = await capture(branch, ledger);
    assert.deepEqual(rescanned.ops, []);
  });

  it("a lost watermark does not bring back the replaced answer", async () => {
    const branch = [ask("t1", "flash"), ask("t2", "pro")];
    const settled = apply(
      createLedger(),
      (await capture(branch, createLedger())).ops,
    ).ledger;
    assert.deepEqual(texts(settled), [`Q: ${PROMPT} \u2192 A: pro`]);
    assert.deepEqual((await capture(branch, settled)).ops, []);
  });

  it("leaves answers to other questions alone", async () => {
    const seeded = apply(
      createLedger(),
      (await capture([toolResult("t1", ASK_ANSWERED)], createLedger())).ops,
    ).ledger;
    const result = await capture(
      [toolResult("t1", ASK_ANSWERED), ask("t2", "pro", "Which theme?")],
      seeded,
      "t1",
    );
    assert.deepEqual(
      result.ops.map(({ op }) => op.op),
      ["add"],
    );
    const { ledger } = apply(seeded, result.ops);
    assert.equal(active(ledger).length, 3);

    const again = await capture(
      [
        toolResult("t1", ASK_ANSWERED),
        ask("t2", "pro", "Which theme?"),
        ask("t3", "flash", "Which theme?"),
      ],
      ledger,
      "t2",
    );
    assert.deepEqual(
      apply(ledger, again.ops).ledger.items.filter((i) => i.status === "active")
        .length,
      3,
    );
  });

  it("the same answer again changes nothing", async () => {
    const once = apply(
      createLedger(),
      (await capture([ask("t1", "flash")], createLedger())).ops,
    ).ledger;
    const result = await capture(
      [ask("t1", "flash"), ask("t2", "flash")],
      once,
      "t1",
    );
    const again = apply(once, result.ops);
    assert.deepEqual(again.effects, ["duplicate"]);
    assert.deepEqual(again.ledger, once);
  });

  it("recognizes a question whose stored text was cut to fit", async () => {
    const long = "word ".repeat(300).trim();
    const first = await capture([ask("t1", "flash", long)], createLedger());
    const once = apply(createLedger(), first.ops).ledger;
    assert.ok(once.items[0]?.text.includes(TRUNCATION_MARKER));

    const second = await capture(
      [
        ask("t1", "flash", long),
        ask("t2", "a considerably longer answer", long),
      ],
      once,
      "t1",
    );
    const twice = apply(once, second.ops);
    assert.deepEqual(twice.rejected, []);
    assert.deepEqual(twice.effects, ["superseded"]);
    assert.equal(active(twice.ledger).length, 1);
  });

  it("a user message that replaced the answer is not superseded a second time", async () => {
    const once = apply(
      createLedger(),
      (await capture([ask("t1", "flash")], createLedger())).ops,
    ).ledger;
    const change = "Let's go with the pro model for image output instead.";
    const result = await captureIntent(
      [ask("t1", "flash"), user("u2", change), ask("t3", "pro")],
      "t1",
      once,
      scripted({ [change]: verdict("decision", ["D1"]) }),
    );
    assert.deepEqual(
      result.ops.map(({ op }) => op.op),
      ["supersede", "add"],
    );
    assert.deepEqual(apply(once, result.ops).rejected, []);
  });
});

describe("fold request messages", () => {
  const foldRequest = (anchor: string, newLabel: string, chars: number) =>
    `Please fold the work since the '${anchor}' anchor: call navigate_tree(action='rewind', rewindTo='${anchor}', newLabel='${newLabel}'), with a summaryFocus of at least ${chars} characters covering my latest instruction, what is done since that anchor and what remains.`;

  it("matches the /anchor template for any anchor, label and number", () => {
    for (const [anchor, newLabel, chars] of [
      ["impl", "impl-folded", 20],
      ["milestone-2", "milestone-2-folded-3", 250],
    ] as const) {
      assert.match(foldRequest(anchor, newLabel, chars), FOLD_REQUEST_RE);
    }
  });

  it("does not match text that merely mentions the call", () => {
    for (const text of [
      "Always call navigate_tree(action='rewind', rewindTo='impl') when I say so.",
      `Thanks. ${foldRequest("impl", "impl-folded", 20)}`,
      "Please fold the work since the 'impl' anchor, I will do it myself.",
    ]) {
      assert.doesNotMatch(text, FOLD_REQUEST_RE);
    }
  });

  it("is skipped before any classifier sees it", async () => {
    const request = foldRequest("impl", "impl-folded", 20);
    const classifier = scripted({ [request]: verdict("steering") });
    const result = await captureIntent(
      [filler("f1"), label("l1", "f1", "anchor:impl"), user("u1", request)],
      undefined,
      createLedger(),
      classifier,
    );
    assert.deepEqual(classifier.inputs, []);
    assert.deepEqual(result.ops, []);
    assert.equal(result.classified, 0);
    assert.equal(result.watermark, "u1");

    const heuristic = await captureIntent(
      [user("u1", `${request} Always keep it short.`)],
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.deepEqual(heuristic.ops, []);
    assert.equal(heuristic.classified, 0);
  });
});

describe("long message capture", () => {
  const FILLER =
    "The importer reads the CSV export and maps every column to the schema. ";
  const TABS = "From now on always use tabs for indentation.";
  const capture = (text: string, ledger = createLedger()) =>
    captureIntent([user("u1", text)], undefined, ledger, heuristicClassifier);
  const longMessage = (...middle: string[]) =>
    `${FILLER.repeat(10)}${middle.join(" ")} ${FILLER.repeat(10)}`;

  it("captures the one rule sentence of a 1500-character message verbatim", async () => {
    const text = longMessage(TABS);
    assert.ok(text.length > 1400 && text.length < 1600);
    const result = await capture(text);
    assert.deepEqual(
      result.ops.map(({ op, ctx }) => [op, ctx.origin, ctx.entryId]),
      [[{ op: "add", kind: "rule", text: TABS, quote: TABS }, "user", "u1"]],
    );
    assert.equal(result.classified, 1);

    const { ledger, rejected } = apply(createLedger(), result.ops);
    assert.deepEqual(rejected, []);
    assert.deepEqual(ledger.items[0]?.source, {
      entryId: "u1",
      origin: "user",
    });
    const archived = applyOps(ledger, [{ op: "archive", id: "R1" }], {
      origin: "agent",
    });
    assert.deepEqual(
      archived.rejected.map((r) => r.reason.code),
      ["protected_item"],
    );
  });

  it("keeps sentence order, kinds and a cap of three items", async () => {
    const sentences = [
      "Let's go with option B for the config layout.",
      "From now on never write to the main checkout.",
      "We decided to keep the ledger in branch summaries.",
      "Always run the full test suite before you commit.",
      "I prefer small commits over big ones.",
    ];
    const result = await capture(longMessage(...sentences));
    assert.deepEqual(
      result.ops.map(({ op }) => [
        op.op === "add" && op.kind,
        op.op === "add" && op.quote,
      ]),
      [
        ["decision", sentences[0]],
        ["rule", sentences[1]],
        ["decision", sentences[2]],
      ],
    );
  });

  it("takes each line as its own sentence and counts a repeat once", async () => {
    const lines = [
      "- from now on rebase before you push",
      "- don't ever skip the hooks",
    ];
    const text = `${FILLER.repeat(12)}\n${lines[0]}\n${lines[1]}\n${lines[0]}`;
    const result = await capture(text);
    assert.deepEqual(
      result.ops.map(({ op }) => op.op === "add" && op.quote),
      lines,
    );
  });

  it("restores the original curly apostrophe in the quote", async () => {
    const sentence = "Let\u2019s go with option B for the config layout.";
    const result = await capture(longMessage(sentence));
    const [{ op }] = result.ops;
    assert.ok(
      op.op === "add" && op.kind === "decision" && op.quote === sentence,
    );
  });

  it("never yields an objective or a steering item", async () => {
    const goal = "Goal: every binding instruction survives a fold.";
    const objective = await capture(longMessage(goal));
    assert.deepEqual(objective.ops, []);

    const text = longMessage("The goal is endless sessions.");
    const steered = await captureIntent(
      [
        filler("f1"),
        label("l1", "f1", "anchor:impl"),
        user("u1", `${text} Focus on the parser first.`),
      ],
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    assert.deepEqual(steered.ops, []);
  });

  it("judges each sentence by the short-message rules", async () => {
    const cases: [string, string][] = [
      ["question", "Should we always use tabs here?"],
      ["dismissal", "Never mind that, keep going with the plan."],
      ["fenced code", "```\nalways use tabs in this file\n```"],
      ["unclosed fence", "```ts\nconst always = 1;\nnever call this"],
      ["blockquote", "> From now on always use tabs, he wrote."],
      ["indented code", "    // always call close() in finally"],
      ["too short", "Always."],
      ["too long", `Always ${"keep going ".repeat(40)}.`],
    ];
    for (const [name, middle] of cases) {
      const result = await capture(`${longMessage()}\n${middle}\n${FILLER}`);
      assert.deepEqual(result.ops, [], name);
    }
  });

  it("ignores bare always, never and prefer inside a long message", async () => {
    const result = await capture(
      longMessage(
        "The retry loop is always running.",
        "It never succeeds against the stale host.",
        "Most teams prefer the older client.",
      ),
    );
    assert.deepEqual(result.ops, []);
  });

  it("still captures a rule that follows a question or a code block", async () => {
    const text = `${longMessage()}\nShould we use tabs? From now on use tabs.\n\`\`\`\nnever mind\n\`\`\`\n${"Remember: never edit the lockfile by hand."}`;
    const result = await capture(text);
    assert.deepEqual(
      result.ops.map(({ op }) => op.op === "add" && op.quote),
      ["From now on use tabs.", "Remember: never edit the lockfile by hand."],
    );
  });

  it("leaves short messages and marker-free long ones as they were", async () => {
    assert.deepEqual(
      await heuristicClassifier({
        entryId: "e",
        text: RULE_TEXT,
        activeItems: [],
      }),
      {
        kind: "rule",
        by: "heuristic",
      },
    );
    assert.deepEqual(
      await heuristicClassifier({
        entryId: "e",
        text: longMessage(),
        activeItems: [],
      }),
      { kind: "ephemeral", by: "heuristic" },
    );
    assert.deepEqual((await capture(longMessage())).ops, []);
  });
});

describe("idempotence", () => {
  const branch = [
    user("u1", RULE_TEXT),
    toolResult("t1", ASK_ANSWERED),
    user("u2", "Goal: keep every binding instruction alive across folds"),
  ];

  it("a second scan of the same branch changes nothing", async () => {
    const first = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    const once = apply(createLedger(), first.ops);
    assert.deepEqual(
      active(once.ledger).map((i) => i.kind),
      ["rule", "decision", "decision", "objective"],
    );

    const second = await captureIntent(
      branch,
      undefined,
      once.ledger,
      heuristicClassifier,
    );
    const twice = apply(once.ledger, second.ops);
    assert.deepEqual(twice.ledger, once.ledger);
  });

  it("ops re-derived without the ledger are duplicates, never double items", async () => {
    const first = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    const once = apply(createLedger(), first.ops);
    const again = await captureIntent(
      branch,
      undefined,
      createLedger(),
      heuristicClassifier,
    );
    const twice = apply(once.ledger, again.ops);
    assert.deepEqual(twice.effects, [
      "duplicate",
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    assert.deepEqual(twice.ledger, once.ledger);
  });

  it("does not resurrect a superseded rule when the watermark is lost", async () => {
    const spaces = "Actually spaces, not tabs, from now on.";
    const tabs = "Always indent with tabs in this repo.";
    const rules = [user("u1", tabs), user("u2", spaces)];
    const first = await captureIntent(
      rules,
      undefined,
      createLedger(),
      scripted({ [tabs]: verdict("rule") }),
    );
    const seeded = apply(createLedger(), first.ops).ledger;
    const second = await captureIntent(
      rules,
      "u1",
      seeded,
      scripted({ [spaces]: verdict("rule", ["R1"]) }),
    );
    const settled = apply(seeded, second.ops).ledger;
    assert.deepEqual(
      active(settled).map((i) => i.text),
      [spaces],
    );

    const rescanned = await captureIntent(
      rules,
      undefined,
      settled,
      scripted({ [tabs]: verdict("rule"), [spaces]: verdict("rule") }),
    );
    assert.deepEqual(rescanned.ops, []);
  });
});

describe("heuristicClassifier", () => {
  const kindOf = async (text: string) =>
    (await heuristicClassifier({ entryId: "e", text, activeItems: [] })).kind;

  const cases: [string, IntentKind][] = [
    [RULE_TEXT, "rule"],
    ["Never write to the main checkout.", "rule"],
    ["I prefer small commits over big ones.", "rule"],
    ["Remember: the build runs on node 22.", "rule"],
    ["Don't ever force push to main.", "rule"],
    ["Let’s go with option B for the config layout.", "decision"],
    ["We decided to keep the ledger in branch summaries.", "decision"],
    ["Decision: capture stays heuristic-first.", "decision"],
    ["Goal: user intent must survive every fold", "objective"],
    ["The goal is endless sessions without losing instructions.", "objective"],
    // Real phrasing from this project: no marker, so only a model classifier catches it.
    ["drop /tree-clone completely and only keep /anchor clone", "ephemeral"],
    ["rename the helper and then rerun the tests", "ephemeral"],
    ["Why does the fold always fail on this branch?", "ephemeral"],
    ["Should we never fold below the start anchor?", "ephemeral"],
    ["never mind, keep going with the current plan", "ephemeral"],
    ["ok thanks", "ephemeral"],
    [`${"Logs: always retrying, never succeeding. ".repeat(15)}`, "ephemeral"],
  ];
  for (const [text, want] of cases) {
    it(`${want}: ${text.slice(0, 60)}`, async () => {
      assert.equal(await kindOf(text), want);
    });
  }

  it("never proposes a supersession", async () => {
    const out = await heuristicClassifier({
      entryId: "e",
      text: RULE_TEXT,
      activeItems: [{ id: "R1", kind: "rule", text: "old" }],
    });
    assert.deepEqual(out, { kind: "rule", by: "heuristic" });
  });
});

describe("supersession and objectives", () => {
  const tabs = "Always indent with tabs in this repo.";
  const spaces = "Scratch that: spaces from now on, not tabs.";
  const branch = [user("u1", tabs), filler("f1"), user("u2", spaces)];
  const seeded = apply(createLedger(), [
    {
      op: { op: "add", kind: "rule", text: tabs, quote: tabs },
      ctx: { origin: "user", entryId: "u1" },
    },
  ]).ledger;

  it("emits a supersede that cites the new message and the ledger accepts it", async () => {
    const result = await captureIntent(
      branch,
      undefined,
      seeded,
      scripted({ [spaces]: verdict("rule", ["R1"]) }),
    );
    assert.equal(result.ops.length, 1);
    const [{ op, ctx }] = result.ops;
    assert.deepEqual(op, {
      op: "supersede",
      ids: ["R1"],
      with: { kind: "rule", text: spaces, quote: spaces },
      citedEntryId: "u2",
    });
    const { ledger, effects } = apply(seeded, result.ops);
    assert.deepEqual(effects, ["superseded"]);
    assert.deepEqual(
      ledger.items.map((i) => [i.id, i.status, i.source]),
      [
        ["R1", "superseded", { entryId: "u1", origin: "user" }],
        ["R2", "active", { entryId: "u2", origin: "user" }],
      ],
    );

    const ownSource = applyOps(
      seeded,
      [{ ...(op as object), citedEntryId: "u1" } as typeof op],
      ctx,
    );
    assert.deepEqual(
      ownSource.rejected.map((r) => r.reason.code),
      ["invalid_citation"],
    );
  });

  it("drops named ids that are unknown, inactive or of another kind", async () => {
    const withDecision = apply(seeded, [
      {
        op: { op: "add", kind: "decision", text: "Use sqlite for the index" },
        ctx: { origin: "user", entryId: "u0" },
      },
    ]).ledger;
    for (const named of [["R9"], ["D2"]]) {
      const result = await captureIntent(
        branch,
        "u1",
        withDecision,
        scripted({ [spaces]: verdict("rule", named) }),
      );
      assert.deepEqual(
        result.ops.map((c) => c.op.op),
        ["add"],
      );
    }
  });

  it("keeps a single active objective: downgrades to a sub-goal unless the classifier named it", async () => {
    const goal = "Goal: ship the continuity ledger end to end";
    const other = "New goal: also redesign the tree panel";
    const replace = "Actually the real goal is shipping capture first";
    const withObjective = apply(createLedger(), [
      {
        op: { op: "add", kind: "objective", text: goal },
        ctx: { origin: "user", entryId: "u0" },
      },
    ]).ledger;

    const downgraded = await captureIntent(
      [user("u1", other)],
      undefined,
      withObjective,
      scripted({ [other]: verdict("objective") }),
    );
    assert.deepEqual(
      downgraded.ops.map((c) => c.op),
      [{ op: "add", kind: "sub-goal", text: other, quote: other }],
    );

    const replaced = await captureIntent(
      [user("u1", replace)],
      undefined,
      withObjective,
      scripted({ [replace]: verdict("objective", ["G1"]) }),
    );
    const out = apply(withObjective, replaced.ops);
    assert.deepEqual(out.rejected, []);
    assert.deepEqual(
      active(out.ledger).map((i) => [i.kind, i.text]),
      [["objective", replace]],
    );

    const twoNew = await captureIntent(
      [user("u1", goal), user("u2", other)],
      undefined,
      createLedger(),
      scripted({ [goal]: verdict("objective"), [other]: verdict("objective") }),
    );
    assert.deepEqual(
      twoNew.ops.map((c) => c.op.op === "add" && c.op.kind),
      ["objective", "sub-goal"],
    );
    assert.deepEqual(apply(createLedger(), twoNew.ops).rejected, []);
  });
});

describe("steering", () => {
  const steer = "Keep the diff small while you work on this part.";
  const classifier = () => scripted({ [steer]: verdict("steering") });

  it("without an anchor on the branch is ephemeral", async () => {
    const result = await captureIntent(
      [user("u1", steer)],
      undefined,
      createLedger(),
      classifier(),
    );
    assert.deepEqual(result.ops, []);
  });

  it("is scoped to the latest anchor set before the message", async () => {
    const branch = [
      user("u0", "Start the capture module, please."),
      filler("f1"),
      label("l1", "f1", "anchor:capture"),
      filler("f2"),
      label("l2", "f2", "anchor:ledger-wiring"),
      user("u1", steer),
      filler("f3"),
      label("l3", "f3", "anchor:later"),
    ];
    const result = await captureIntent(
      branch,
      "u0",
      createLedger(),
      classifier(),
    );
    assert.deepEqual(
      result.ops.map((c) => c.op),
      [
        {
          op: "add",
          kind: "steering",
          text: steer,
          quote: steer,
          scopeAnchor: "ledger-wiring",
        },
      ],
    );
    assert.deepEqual(apply(createLedger(), result.ops).rejected, []);
  });

  it("ignores cleared, non-anchor and not-yet-set labels", async () => {
    const branch = [
      filler("f1"),
      label("l1", "f1", "anchor:old"),
      label("l2", "f1", undefined),
      filler("f2"),
      label("l3", "f2", "branch:done"),
      user("u1", steer),
      filler("f3"),
      label("l4", "f3", "anchor:after"),
    ];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      classifier(),
    );
    assert.deepEqual(result.ops, []);
  });
});

describe("createModelClassifier", () => {
  type Registry = Pick<ModelRegistry, "getModelOfType" | "classify">;

  const answer = (choice: string, confidence = 0.95) => ({
    type: "choice" as const,
    choice,
    probabilities: {},
    confidence,
  });

  function fakeRegistry(
    respond: (context: ClassifierContext) => Partial<ClassifierResult> | Error,
    known = ["typesafe/jev-latest"],
  ) {
    const calls: { context: ClassifierContext; signal?: AbortSignal }[] = [];
    const registry = {
      getModelOfType: (_type: string, provider: string, id: string) =>
        known.includes(`${provider}/${id}`) ? { provider, id } : undefined,
      classify: async (
        _model: unknown,
        context: ClassifierContext,
        options?: { signal?: AbortSignal },
      ) => {
        calls.push({ context, signal: options?.signal });
        const out = respond(context);
        if (out instanceof Error) throw out;
        return {
          api: "test",
          provider: "typesafe",
          model: "jev-latest",
          answers: {},
          stopReason: "stop",
          timestamp: 0,
          ...out,
        } as ClassifierResult;
      },
    } as unknown as Registry;
    return { registry, calls };
  }

  const input = (over: Partial<IntentInput> = {}): IntentInput => ({
    entryId: "u1",
    text: "From now on use spaces, not tabs.",
    activeItems: [{ id: "R1", kind: "rule", text: "Use tabs" }],
    ...over,
  });

  async function make(
    respond: Parameters<typeof fakeRegistry>[0],
    opts?: { minConfidence?: number },
  ) {
    const fake = fakeRegistry(respond);
    const classifier = await createModelClassifier(
      fake.registry,
      "typesafe/jev-latest",
      opts,
    );
    assert.ok(classifier);
    return { classifier, calls: fake.calls };
  }

  it("asks the kind and the contradicted item, and returns the verdict", async () => {
    const { classifier, calls } = await make(() => ({
      answers: { kind: answer("rule"), contradicts: answer("R1") },
    }));
    const out = await classifier(input({ activeAnchor: "impl" }));
    assert.deepEqual(out, {
      kind: "rule",
      supersedes: ["R1"],
      by: "classifier",
    });
    const [{ context }] = calls;
    assert.deepEqual(Object.keys(context.questions), ["kind", "contradicts"]);
    const kind = context.questions.kind;
    assert.equal(kind?.type, "choice");
    assert.deepEqual(
      kind && Object.keys(kind.criteria as Record<string, string>),
      [...INTENT_KINDS],
    );
    assert.deepEqual(context.questions.contradicts?.criteria, {
      R1: "Use tabs",
      none: "The message changes none of the items",
    });
    assert.deepEqual(context.state, {
      message: "From now on use spaces, not tabs.",
      activeAnchor: "impl",
      activeItems: [{ id: "R1", kind: "rule", text: "Use tabs" }],
    });
  });

  it("answers 'none' and unknown ids add no supersession; an ephemeral kind stays ephemeral", async () => {
    const none = await make(() => ({
      answers: { kind: answer("decision"), contradicts: answer("none") },
    }));
    assert.deepEqual(await none.classifier(input()), {
      kind: "decision",
      by: "classifier",
    });

    const bogus = await make(() => ({
      answers: { kind: answer("rule"), contradicts: answer("R77") },
    }));
    assert.deepEqual(await bogus.classifier(input()), {
      kind: "rule",
      by: "classifier",
    });

    const chatter = await make(() => ({
      answers: { kind: answer("ephemeral"), contradicts: answer("R1") },
    }));
    assert.deepEqual(await chatter.classifier(input()), {
      kind: "ephemeral",
      by: "classifier",
    });
  });

  it("skips the contradiction question when there are no active items", async () => {
    const { classifier, calls } = await make(() => ({
      answers: { kind: answer("rule") },
    }));
    await classifier(input({ activeItems: [] }));
    assert.deepEqual(Object.keys(calls[0]?.context.questions ?? {}), ["kind"]);
  });

  it("treats a low-confidence answer as ephemeral, without a warning", async () => {
    const { classifier } = await make(() => ({
      answers: { kind: answer("rule", 0.69), contradicts: answer("R1") },
    }));
    assert.deepEqual(await classifier(input()), {
      kind: "ephemeral",
      by: "classifier",
    });
  });

  it("honors a custom minConfidence", async () => {
    const { classifier } = await make(
      () => ({ answers: { kind: answer("rule", 0.5) } }),
      { minConfidence: 0.4 },
    );
    assert.equal((await classifier(input())).kind, "rule");
  });

  it("a provider error is ephemeral with one warning, and the instance stops calling the model", async () => {
    const { classifier, calls } = await make(() => ({
      stopReason: "error",
      errorMessage: "rate limited",
    }));
    const first = await classifier(input());
    assert.equal(first.kind, "ephemeral");
    assert.match(
      first.warning ?? "",
      /typesafe\/jev-latest failed \(rate limited\)/,
    );
    const second = await classifier(input());
    assert.deepEqual(second, { kind: "ephemeral", by: "classifier" });
    assert.equal(calls.length, 1);
  });

  it("a thrown error is handled like a provider error", async () => {
    const { classifier } = await make(() => new Error("socket closed"));
    const out = await classifier(input());
    assert.equal(out.kind, "ephemeral");
    assert.match(out.warning ?? "", /socket closed/);
  });

  it("surfaces the warning once in a capture result", async () => {
    const { classifier } = await make(() => ({
      stopReason: "error",
      errorMessage: "boom",
    }));
    const branch = [
      user("u1", "From now on use spaces, not tabs."),
      user("u2", "Also never touch the generated files."),
      user("u3", "And always rebase before opening a pull request."),
    ];
    const result = await captureIntent(
      branch,
      undefined,
      createLedger(),
      classifier,
    );
    assert.deepEqual(result.ops, []);
    assert.equal(result.classified, 3);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /boom/);
  });

  it("resolves undefined and warns for an unknown or malformed model", async () => {
    const { registry } = fakeRegistry(() => ({}));
    const warnings: string[] = [];
    for (const model of ["typesafe/missing", "no-slash", ""]) {
      assert.equal(
        await createModelClassifier(registry, model, {
          onWarning: (m) => warnings.push(m),
        }),
        undefined,
      );
    }
    assert.equal(warnings.length, 3);
    assert.match(
      warnings[0] ?? "",
      /"typesafe\/missing" is not a known classifier model/,
    );
    assert.equal(
      await createModelClassifier(registry, "typesafe/missing"),
      undefined,
    );
  });

  it("splits provider and id at the first slash", async () => {
    const fake = fakeRegistry(() => ({}), ["openrouter/typesafe/jev-1.13"]);
    assert.ok(
      await createModelClassifier(
        fake.registry,
        "openrouter/typesafe/jev-1.13",
      ),
    );
  });

  it("bounds what is sent: truncated message, 30 items with rules and decisions first", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({
      id: `${i % 2 === 0 ? "S" : "R"}${i + 1}`,
      kind: i % 2 === 0 ? "sub-goal" : "rule",
      text: `item ${i + 1}`,
    }));
    const { classifier, calls } = await make(() => ({
      answers: { kind: answer("rule") },
    }));
    await classifier(
      input({
        text: "x".repeat(MAX_CLASSIFIER_MESSAGE_CHARS + 500),
        activeItems: items,
      }),
    );
    const state = calls[0]?.context.state as {
      message: string;
      activeItems: { id: string; kind: string }[];
    };
    assert.equal(state.message.length, MAX_CLASSIFIER_MESSAGE_CHARS);
    assert.ok(state.message.endsWith(TRUNCATION_MARKER));
    assert.equal(state.activeItems.length, MAX_CLASSIFIER_ITEMS);
    assert.deepEqual(
      state.activeItems.slice(0, 3).map((i) => i.id),
      ["R40", "R38", "R36"],
    );
    assert.ok(state.activeItems.slice(0, 20).every((i) => i.kind === "rule"));
  });

  it("is never asked about a fold request", async () => {
    const { classifier, calls } = await make(() => ({
      answers: { kind: answer("steering") },
    }));
    const request =
      "Please fold the work since the 'impl' anchor: call navigate_tree(action='rewind', rewindTo='impl', newLabel='impl-folded'), with a summaryFocus of at least 20 characters covering my latest instruction, what is done since that anchor and what remains.";
    const result = await captureIntent(
      [filler("f1"), label("l1", "f1", "anchor:impl"), user("u1", request)],
      undefined,
      createLedger(),
      classifier,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(result.ops, []);
    assert.equal(result.classified, 0);
  });

  it("does not call the model once the signal is aborted", async () => {
    const { classifier, calls } = await make(() => ({
      answers: { kind: answer("rule") },
    }));
    const controller = new AbortController();
    controller.abort();
    const out = await classifier(input(), controller.signal);
    assert.deepEqual(out, { kind: "ephemeral", by: "classifier" });
    assert.equal(calls.length, 0);
  });
});
