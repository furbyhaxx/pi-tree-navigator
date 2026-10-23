/** Shared instructions and stored handoff format for independent fold summaries. */

/**
 * The eval-approved "r5d" branch-summary instruction, byte-exact from
 * `cad0p/pi@eval/branch-summary-prompt`
 * `packages/coding-agent/src/core/compaction/branch-summarization.ts`
 * (`BRANCH_SUMMARY_PROMPT`). Do NOT reflow, re-wrap, or "fix" the wording:
 * the r5d text was selected by a live eval and the `{first}` scope sentence
 * is what keeps pre-branch background out of the summary. `{first}` is
 * substituted (via `replaceAll`) with the 1-based number of the first
 * collapsed message in the projection the model sees.
 */
export const REWIND_SUMMARY_PROMPT = `Summarize only messages {first} onwards in the conversation above (message numbering starts at 1 and excludes the system prompt; this instruction message itself is not evidence). Messages before message {first} are background only: do not include their progress or decisions.

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

/**
 * Appended after r5d (and the parent block), never inside it: a fold drops the
 * user's standing authorization unless the summary carries it. The section
 * sits before any continuity-delta block, which stays last.
 */
const STANDING_AUTHORIZATION_INSTRUCTION = `End the summary with one more section, after '## Next Steps' and before any continuity-delta block:

## Standing authorization
[The user's current authorization and scope, quoted verbatim from anywhere in the conversation above, background included (for example "work autonomously until done"), or "(none)". Say whether that scope is complete.]

In '## Next Steps', name the next concrete work item of the authorized scope. Do not list a report, hand-off or wrap-up while authorized work remains: a completed milestone is not the end of the task.

The no-tools restriction applies only to this summary turn; normal tools return after the fold. It is not a task blocker. Under '### Blocked', record only blockers established in the collapsed work, not this turn's temporary restrictions. Write the next work item assuming this requested fold succeeds; do not list repeating this rewind.`;

/**
 * Compose the summary instruction: r5d with `{first}` substituted, plus the
 * focus. Mirrors upstream's `customInstructions` append shape
 * (`${PROMPT}\n\nAdditional focus: ...`).
 */
export function buildSummaryInstruction(
  first: number,
  focus: string,
  parent?: { mode: "full" | "synthesized"; childCount: number },
  continuitySection?: string,
): string {
  // Substitute in the prompt only: a focus that quotes `{first}` stays
  // verbatim.
  let prompt = REWIND_SUMMARY_PROMPT.replaceAll("{first}", String(first));
  if (parent && parent.childCount > 0) {
    prompt = prompt.replace(
      "Keep the complete summary under about 4000 characters while preserving all decisions.",
      "This parent folds completed child handoffs. Use the length needed to preserve what remains relevant to this parent; there is no fixed 4000-character cap.",
    );
    prompt += `\n\nThis is a work handoff, not an alternative conversation. There are ${parent.childCount} child handoffs in scope. ${parent.mode === "full" ? "Child reports will be attached verbatim once each; write the parent's own scope, final outcome, superseding decisions and remaining work without recopying child reports." : "Synthesize the child reports into this parent's handoff. Keep their relevant decisions, rejected or superseded approaches, deliverables, verification evidence and limits, commits, deferred/open work, and key facts needed for subsequent work. Omit child detail only when it is no longer relevant to the parent."} Include explicit Delivered, Verification, Rejected or Superseded, Commits, and Open or Deferred sections when supported by the evidence. Distinguish historical next steps from still-open work.`;
  }
  prompt += `\n\n${STANDING_AUTHORIZATION_INSTRUCTION}`;
  const instruction = `${prompt}\n\nAdditional focus: ${focus}`;
  return continuitySection === undefined
    ? instruction
    : `${instruction}\n\n${continuitySection}`;
}

/** Build the user instruction appended to an independent summarization request. */
export function buildSummaryRequestText(
  first: number,
  focus: string,
  parent?: { mode: "full" | "synthesized"; childCount: number },
  continuitySection?: string,
): string {
  return `[navigate_tree]\n${buildSummaryInstruction(first, focus, parent, continuitySection)}`;
}

/**
 * The summary turn's text, from its `## Goal` heading on (r5d's first
 * required heading), or `null` when the heading is missing — an
 * acknowledgement or commentary turn is a failed attempt, never a stored
 * summary. Any preamble before the heading is dropped.
 */
export function extractSummaryText(text: string): string | null {
  const start = text.search(/^## Goal\b/m);
  if (start < 0) return null;
  const summary = text.slice(start).trim();
  // A bare heading is not a summary: storing it would lose the collapsed work.
  const body = summary.replace(/^## Goal\b[^\n]*/, "").trim();
  return body.length > 0 ? summary : null;
}

/**
 * Byte-exact copy of upstream's (non-exported) `BRANCH_SUMMARY_PREAMBLE`
 * (`core/compaction/branch-summarization.js`), so a stored legacy summary
 * has the same shape as one produced by `generateBranchSummary`.
 */
export const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/**
 * Byte-exact port of upstream's (non-exported) `formatFileOperations`
 * (`core/compaction/utils.js`): file lists appended to the stored summary.
 */
export function formatFileOperations(
  readFiles: string[],
  modifiedFiles: string[],
): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Port of upstream's (non-exported) `computeFileLists`: read-only files
 * (read but never edited/written) and modified files, both sorted.
 */
export function computeFileLists(fileOps: {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/** Compose a legacy stored branch_summary from generated text and file lists. */
export function buildStoredSummary(
  summaryText: string,
  readFiles: string[],
  modifiedFiles: string[],
): string {
  return (
    BRANCH_SUMMARY_PREAMBLE +
    summaryText +
    formatFileOperations(readFiles, modifiedFiles)
  );
}

const CONTINUITY_HEADING = "## Continuity ledger";
// First line of the rendered briefing (`renderBriefing`), the marker of an embedded one.
const CONTINUITY_MARKER = "[navigate_tree continuity ledger rev ";

/** Append a rendered continuity briefing to stored handoff text, as its last section. */
export function appendContinuityBriefing(
  text: string,
  briefing: string,
): string {
  return `${text}\n\n${CONTINUITY_HEADING}\n\n${briefing}`;
}

/**
 * Remove the briefing `appendContinuityBriefing` added. A child's handoff
 * is embedded in its parent's, and only the parent's current briefing may
 * stay in force.
 */
export function stripContinuityBriefing(text: string): string {
  const at = text.lastIndexOf(
    `\n\n${CONTINUITY_HEADING}\n\n${CONTINUITY_MARKER}`,
  );
  return at < 0 ? text : text.slice(0, at);
}

// A parent's embedded child handoffs carry their own, historical, sections.
const CHILD_HANDOFFS_MARK = "\n\n---\n\n## Child handoffs";
const NO_ITEM = /^\(?(?:none|n\/a|nothing|empty)\b[^a-z]*$/i;

function sectionItems(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const at = lines.findIndex(
    (line) => line.trimEnd().toLowerCase() === heading.toLowerCase(),
  );
  if (at < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const next = /^(#+)\s/.exec(line);
    if (
      (next && next[1].length <= level) ||
      /^<(?:read|modified)-files>/.test(line)
    )
      break;
    items.push(
      line.replace(/^\s*(?:[-*]|\d+[.)])?\s*(?:\[[ xX]\])?\s*/, "").trim(),
    );
  }
  return items.filter((item) => item !== "" && !NO_ITEM.test(item));
}

/**
 * True when a stored summary records unfinished work: a non-placeholder
 * item under `### In Progress` or `## Next Steps`.
 */
export function hasOpenWork(summary: string): boolean {
  const own = summary.split(CHILD_HANDOFFS_MARK)[0];
  return (
    sectionItems(own, "### In Progress").length > 0 ||
    sectionItems(own, "## Next Steps").length > 0
  );
}
