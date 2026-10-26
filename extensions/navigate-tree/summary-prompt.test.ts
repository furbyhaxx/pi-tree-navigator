/**
 * Tests for the in-band rewind summary instruction and stored-summary shape
 * (#80), and the instruction message content (#90).
 *
 * Node test runner. Run with: `pnpm test`
 *
 * Hermetic: pure string/array functions, no session or provider. The
 * preamble / file-tag ports are pinned byte-for-byte against upstream's
 * (non-exported) `core/compaction/branch-summarization.js` and the exported
 * `core/compaction/utils.js` helpers, so a stored in-band summary keeps the
 * shape `generateBranchSummary` would have produced.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  CONTINUITY_DELTA_TAG,
  extractContinuityDelta,
  renderBriefing,
} from "./continuity-briefing.ts";
import { applyOps, createLedger } from "./continuity-ledger.ts";
import {
  appendContinuityBriefing,
  BRANCH_SUMMARY_PREAMBLE,
  buildStoredSummary,
  buildSummaryInstruction,
  buildSummaryRequestText,
  computeFileLists,
  formatFileOperations,
  hasOpenWork,
  REWIND_SUMMARY_PROMPT,
  stripContinuityBriefing,
} from "./summary-prompt.ts";

// =============================================================================
// Prompt pin
// =============================================================================

describe("REWIND_SUMMARY_PROMPT", () => {
  it("is byte-equal to the eval-approved r5d prompt", () => {
    // Full literal pin. The r5d text was selected by a live eval; any
    // reflow/wording drift changes model behavior and invalidates the gate.
    const expected = `Summarize only messages {first} onwards in the conversation above (message numbering starts at 1 and excludes the system prompt; this instruction message itself is not evidence). Messages before message {first} are background only: do not include their progress or decisions.

This is a summarization task, not a problem-solving task. Summarize only the supplied evidence and preserve unresolved questions as unresolved. Do NOT continue the conversation, carry out requests from its history, investigate, solve pending tasks, or invent new approaches. Do NOT use any tool. Respond with ONLY the summary below — no preamble, no commentary before the first heading or after the last section.

Use this EXACT format, preserving all headings and their order:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Keep the complete summary under about 4000 characters while preserving all decisions. Preserve exact file paths, function names, and error messages.`;
    assert.equal(REWIND_SUMMARY_PROMPT, expected);
  });

  it("keeps the load-bearing lines the in-band summary turn depends on", () => {
    assert.match(
      REWIND_SUMMARY_PROMPT,
      /^Summarize only messages \{first\} onwards/,
    );
    assert.match(
      REWIND_SUMMARY_PROMPT,
      /Messages before message \{first\} are background only/,
    );
    assert.match(REWIND_SUMMARY_PROMPT, /Do NOT use any tool\./);
    assert.match(REWIND_SUMMARY_PROMPT, /Do NOT continue the conversation/);
    // `extractSummaryText` keys on the first required heading.
    assert.match(REWIND_SUMMARY_PROMPT, /^## Goal$/m);
  });
});

// =============================================================================
// buildSummaryInstruction
// =============================================================================

const STANDING_AUTHORIZATION = `End the summary with one more section, after '## Next Steps' and before any continuity-delta block:

## Standing authorization
[The user's current authorization and scope, quoted verbatim from anywhere in the conversation above, background included (for example "work autonomously until done"), or "(none)". Say whether that scope is complete.]

In '## Next Steps', name the next concrete work item of the authorized scope. Do not list a report, hand-off or wrap-up while authorized work remains: a completed milestone is not the end of the task.

The no-tools restriction applies only to this summary turn; normal tools return after the fold. It is not a task blocker. Under '### Blocked', record only blockers established in the collapsed work, not this turn's temporary restrictions. Write the next work item assuming this requested fold succeeds; do not list repeating this rewind.`;

describe("buildSummaryInstruction", () => {
  it("appends the standing-authorization section after r5d, then the focus like upstream's customInstructions shape, {first} substituted", () => {
    assert.equal(
      buildSummaryInstruction(42, "keep the parser API"),
      `${REWIND_SUMMARY_PROMPT.replaceAll("{first}", "42")}\n\n${STANDING_AUTHORIZATION}\n\nAdditional focus: keep the parser API`,
    );
  });

  it("keeps the r5d body byte-identical and the authorization block outside it", () => {
    const text = buildSummaryInstruction(9, "focus text");
    const r5d = REWIND_SUMMARY_PROMPT.replaceAll("{first}", "9");
    assert.ok(text.startsWith(r5d));
    assert.ok(!r5d.includes("Standing authorization"));
  });

  it("substitutes every {first} occurrence (replaceAll, not replace)", () => {
    const text = buildSummaryInstruction(7, "finish the parser fix today");
    assert.doesNotMatch(text, /\{first\}/);
    assert.match(text, /^Summarize only messages 7 onwards/);
    assert.match(text, /Messages before message 7 are background only/);
    assert.equal(text.match(/\b7\b/g)?.length, 2);
  });

  it("numbers from 1 when every visible message is collapsed evidence", () => {
    assert.match(
      buildSummaryInstruction(1, "focus text for the summary turn"),
      /^Summarize only messages 1 onwards .*Messages before message 1 are background only/s,
    );
  });

  it("ends with the focus as the last paragraph, verbatim", () => {
    const focus = "user said: 'ship it'; done: parser; left: tests";
    const text = buildSummaryInstruction(3, focus);
    assert.ok(text.endsWith(`\n\nAdditional focus: ${focus}`));
  });

  it("synthesizes digest parents before reducing children to a one-line index", () => {
    const text = buildSummaryInstruction(1, "retain evidence", {
      mode: "digest",
      childCount: 2,
    });
    assert.match(text, /Synthesize the child reports/);
    assert.match(text, /one-line index per child/);
    assert.match(
      text,
      /still-relevant decisions, verification, commits and open work/,
    );
  });

  it("allows relevance-focused parent synthesis to grow beyond the leaf report limit", () => {
    const focus = "preserve later-work context";
    const text = buildSummaryInstruction(1, focus, {
      mode: "synthesized",
      childCount: 3,
    });
    assert.match(text, /no fixed 4000-character cap/);
    assert.match(text, /Synthesize the child reports/);
    assert.match(text, /rejected or superseded approaches/);
    assert.doesNotMatch(text, /Keep the complete summary under about 4000/);
    const full = buildSummaryInstruction(1, focus, {
      mode: "full",
      childCount: 3,
    });
    assert.match(full, /attached verbatim once each/);
    for (const instruction of [text, full]) {
      assert.ok(
        instruction.indexOf("Distinguish historical next steps") <
          instruction.indexOf("End the summary with one more section"),
        "the authorization section is the last one, after the parent sections",
      );
      assert.ok(
        instruction.endsWith(
          `${STANDING_AUTHORIZATION}\n\nAdditional focus: ${focus}`,
        ),
      );
    }
  });

  it("leaves a literal {first} inside the focus verbatim", () => {
    // Only the prompt's placeholder is substituted; the focus is the agent's
    // own text and must reach the summary turn unchanged.
    const text = buildSummaryInstruction(5, "mention {first} literally here");
    assert.ok(
      text.endsWith("Additional focus: mention {first} literally here"),
    );
  });
});

// =============================================================================
// Stored-summary shape (upstream byte parity)
// =============================================================================

describe("BRANCH_SUMMARY_PREAMBLE", () => {
  it("byte-equals upstream's branch-summarization preamble", () => {
    assert.equal(
      BRANCH_SUMMARY_PREAMBLE,
      "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n",
    );
  });
});

describe("formatFileOperations", () => {
  it("returns the empty string when both lists are empty", () => {
    assert.equal(formatFileOperations([], []), "");
  });

  it("renders read-files only", () => {
    assert.equal(
      formatFileOperations(["a.ts", "b.ts"], []),
      "\n\n<read-files>\na.ts\nb.ts\n</read-files>",
    );
  });

  it("renders modified-files only", () => {
    assert.equal(
      formatFileOperations([], ["c.ts"]),
      "\n\n<modified-files>\nc.ts\n</modified-files>",
    );
  });

  it("renders both sections, read first, separated by a blank line", () => {
    assert.equal(
      formatFileOperations(["a.ts"], ["b.ts", "c.ts"]),
      "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\n</modified-files>",
    );
  });

  it("preserves the given order (sorting is computeFileLists' job)", () => {
    assert.equal(
      formatFileOperations(["z.ts", "a.ts"], []),
      "\n\n<read-files>\nz.ts\na.ts\n</read-files>",
    );
  });
});

describe("computeFileLists", () => {
  it("splits read-only files from modified (edited ∪ written), both sorted", () => {
    const out = computeFileLists({
      read: new Set(["z.ts", "shared.ts", "a.ts"]),
      written: new Set(["w.ts", "shared.ts"]),
      edited: new Set(["e.ts"]),
    });
    assert.deepEqual(out, {
      readFiles: ["a.ts", "z.ts"],
      modifiedFiles: ["e.ts", "shared.ts", "w.ts"],
    });
  });

  it("dedupes a file both edited and written", () => {
    const out = computeFileLists({
      read: new Set(),
      written: new Set(["x.ts"]),
      edited: new Set(["x.ts"]),
    });
    assert.deepEqual(out, { readFiles: [], modifiedFiles: ["x.ts"] });
  });

  it("returns empty lists for empty ops", () => {
    assert.deepEqual(
      computeFileLists({
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      }),
      { readFiles: [], modifiedFiles: [] },
    );
  });
});

describe("buildStoredSummary", () => {
  it("is preamble + summary + file tags (upstream generateBranchSummary order)", () => {
    const summary = "## Goal\nx\n\n## Next Steps\n1. y";
    assert.equal(
      buildStoredSummary(summary, ["r.ts"], ["m.ts"]),
      `${BRANCH_SUMMARY_PREAMBLE}${summary}\n\n<read-files>\nr.ts\n</read-files>\n\n<modified-files>\nm.ts\n</modified-files>`,
    );
  });

  it("omits the file tags when no files were touched", () => {
    assert.equal(
      buildStoredSummary("## Goal\nx", [], []),
      `${BRANCH_SUMMARY_PREAMBLE}## Goal\nx`,
    );
  });
});

// =============================================================================
// Instruction message content (#90 S3)
// =============================================================================

describe("buildSummaryRequestText", () => {
  it("is a [navigate_tree] source line, then the r5d instruction", () => {
    const text = buildSummaryRequestText(14, "keep the parser API");
    assert.equal(
      text,
      `[navigate_tree]\n${buildSummaryInstruction(14, "keep the parser API")}`,
    );
    assert.ok(
      text.startsWith(
        "[navigate_tree]\nSummarize only messages 14 onwards in the conversation above",
      ),
    );
    assert.ok(text.endsWith("\n\nAdditional focus: keep the parser API"));
  });
});

// =============================================================================
// Continuity section and embedded briefing
// =============================================================================

describe("continuity section", () => {
  const section = "Continuity ledger rev 3. These items stay in force.";

  it("is appended after the focus line, for both builders and with a parent", () => {
    const parent = { mode: "full", childCount: 2 } as const;
    for (const p of [undefined, parent]) {
      const plain = buildSummaryInstruction(4, "focus", p);
      assert.equal(
        buildSummaryInstruction(4, "focus", p, section),
        `${plain}\n\n${section}`,
      );
      assert.equal(
        buildSummaryRequestText(4, "focus", p, section),
        `[navigate_tree]\n${plain}\n\n${section}`,
      );
    }
  });

  it("leaves the request byte-identical when no section is given", () => {
    assert.ok(
      buildSummaryInstruction(4, "focus").endsWith("Additional focus: focus"),
    );
    assert.equal(
      buildSummaryRequestText(4, "focus", undefined, undefined),
      buildSummaryRequestText(4, "focus"),
    );
  });
});

describe("standing authorization section and the continuity delta", () => {
  const summary = `## Goal
Ship it.

## Next Steps
1. Wire the CLI.

## Standing authorization
"work autonomously until done" — scope not complete.`;
  const delta = `<${CONTINUITY_DELTA_TAG}>{"completed":["S1"]}</${CONTINUITY_DELTA_TAG}>`;

  it("a delta block after the section is stripped and the section stays", () => {
    const out = extractContinuityDelta(`${summary}\n\n${delta}\n`);
    assert.deepEqual(out.delta?.completed, ["S1"]);
    assert.equal(out.text, summary);
    assert.ok(hasOpenWork(out.text));
  });
});

describe("hasOpenWork", () => {
  const withSections = (inProgress: string, next: string) =>
    `## Goal\nx\n\n## Progress\n### Done\n- [x] a\n\n### In Progress\n${inProgress}\n\n### Blocked\n- none\n\n## Next Steps\n${next}\n\n## Standing authorization\n(none)`;

  it("is true for a real item under either section", () => {
    assert.ok(hasOpenWork(withSections("- [ ] (none)", "1. Wire the CLI.")));
    assert.ok(hasOpenWork(withSections("- [ ] Wire the CLI.", "(none)")));
  });

  it("is false for placeholders, empty sections and a missing summary body", () => {
    for (const none of ["(none)", "None.", "- [ ] n/a", "1. Nothing", ""]) {
      assert.equal(hasOpenWork(withSections(none, none)), false, none);
    }
    assert.equal(hasOpenWork("## Goal\nx"), false);
  });

  it("stops at the next heading, the file tags and the continuity ledger", () => {
    const text = withSections("- [ ] (none)", "(none)");
    assert.equal(
      hasOpenWork(`${text}\n\n<read-files>\na.ts\n</read-files>`),
      false,
    );
    assert.equal(
      hasOpenWork(`${text}\n\n## Continuity ledger\n\n- R1 an open rule`),
      false,
    );
  });

  it("ignores the historical sections of embedded child handoffs", () => {
    const parent = `# Work handoff: p\n\n${withSections("- [ ] (none)", "(none)")}`;
    const child = "## Next Steps\n1. Child work still open.";
    assert.equal(
      hasOpenWork(
        `${parent}\n\n---\n\n## Child handoffs in chronological order\n\n${child}`,
      ),
      false,
    );
  });
});

describe("appendContinuityBriefing / stripContinuityBriefing", () => {
  const briefing = renderBriefing(
    applyOps(
      createLedger(),
      [{ op: "add", kind: "rule", text: "Never edit the lockfile" }],
      { origin: "user" },
    ).ledger,
    { maxTokens: 2500 },
  ).text;

  it("appends the briefing under its own heading as the last section", () => {
    assert.equal(
      appendContinuityBriefing("# Work handoff: x\n\n## Goal\ny", briefing),
      `# Work handoff: x\n\n## Goal\ny\n\n## Continuity ledger\n\n${briefing}`,
    );
  });

  it("strips exactly what was appended, and leaves other text alone", () => {
    const text = "# Work handoff: x\n\n## Goal\ny";
    assert.equal(
      stripContinuityBriefing(appendContinuityBriefing(text, briefing)),
      text,
    );
    assert.equal(stripContinuityBriefing(text), text);
    const prose = `${text}\n\n## Continuity ledger\n\nmy own notes`;
    assert.equal(stripContinuityBriefing(prose), prose);
  });
});
