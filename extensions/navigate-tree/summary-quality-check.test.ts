import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "bun:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "..", "scripts", "summary-quality-check.mjs");

type Meta = Record<string, unknown> & { report: string; title: string };

interface Entry {
  type: string;
  id: string;
  summary: string;
  details?: { treeNavigator: Meta };
}

// An unchanged branch_summary from a real live fold: own report 2401 chars,
// total handoff 5962 chars (the continuity ledger is the difference).
const live: Entry = JSON.parse(
  readFileSync(
    join(here, "fixtures", "live-fold-branch-summary.jsonl"),
    "utf8",
  ),
);
const liveMeta = live.details?.treeNavigator as Meta;
const report = liveMeta.report;
const ledgerAt = live.summary.lastIndexOf("\n\n## Continuity ledger\n\n");
const ledger = live.summary.slice(ledgerAt);
const CHILD_MARK = "\n\n---\n\n## Child handoffs in chronological order\n\n";

/** Rebuild an entry around a different own report, as `materializeHandoff` would. */
function withReport(
  report: string,
  overrides: Record<string, unknown> = {},
  childSection = "",
): Entry {
  const meta: Meta = { ...liveMeta, ...overrides, report };
  return {
    ...live,
    id: "parent01",
    summary: `# Work handoff: ${meta.title}\n\n${report}${childSection}${ledger}`,
    details: { treeNavigator: meta },
  };
}

function check(entries: Entry[]) {
  const dir = mkdtempSync(join(tmpdir(), "summary-check-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    const result = spawnSync(process.execPath, [script, file, "--all"], {
      encoding: "utf8",
    });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("summary-quality-check", () => {
  it("passes a real modern fold whose total exceeds the own-report cap", () => {
    assert.ok(live.summary.length > 4500 && report.length < 4500);
    const { status, out } = check([live]);
    assert.equal(status, 0, out);
    assert.match(out, /own report 2401 chars \(cap 4500\)/);
    assert.match(out, /total handoff 5962 chars/);
    assert.doesNotMatch(out, /FAIL/);
  });

  it("rejects malformed headings, a placeholder and a model preamble in the own report", () => {
    const noBlocked = check([
      withReport(report.replace("### Blocked", "Blocked")),
    ]);
    assert.equal(noBlocked.status, 1);
    assert.match(noBlocked.out, /own report is missing heading "### Blocked"/);

    const swapped = check([
      withReport(
        report
          .replace("## Key Decisions", "## @")
          .replace("## Next Steps", "## Key Decisions")
          .replace("## @", "## Next Steps"),
      ),
    ]);
    assert.equal(swapped.status, 1);
    assert.match(swapped.out, /heading "## Next Steps" out of order/);

    const placeholder = check([
      withReport(`${report}\nmessages {first} onwards`),
    ]);
    assert.equal(placeholder.status, 1);
    assert.match(
      placeholder.out,
      /unresolved "\{first\}" placeholder in own report/,
    );

    const preamble = check([withReport(`Here is the summary:\n\n${report}`)]);
    assert.equal(preamble.status, 1);
    assert.match(
      preamble.out,
      /preamble\/commentary before "## Goal" in own report/,
    );
  });

  it("caps a non-parent own report and labels own versus total length", () => {
    const { status, out } = check([
      withReport(`${report}\n${"x".repeat(2200)}`),
    ]);
    assert.equal(status, 1);
    assert.match(
      out,
      /own report 4602 chars > 4500 .*no child handoffs.*total handoff \d+ chars/,
    );
  });

  it("applies no fixed cap to a parent, but not its children's headings to the parent's own report", () => {
    const child = { ...live, id: "child001" };
    const childText = live.summary.slice(0, ledgerAt);
    const section = `${CHILD_MARK}${childText}`;
    const long = `${report}\n${"x".repeat(2200)}`;

    const parent = check([
      child,
      withReport(long, { children: ["child001"] }, section),
    ]);
    assert.equal(parent.status, 0, parent.out);
    assert.match(
      parent.out,
      /own report 4602 chars \(no fixed cap: parent of 1 child handoff\)/,
    );

    const hollow = check([
      child,
      withReport("## Goal\nonly a goal", { children: ["child001"] }, section),
    ]);
    assert.equal(hollow.status, 1);
    assert.match(
      hollow.out,
      /own report is missing heading "## Constraints & Preferences"/,
    );

    const missingSection = check([
      child,
      withReport(long, { children: ["child001"] }),
    ]);
    assert.equal(missingSection.status, 1);
    assert.match(missingSection.out, /no "## Child handoffs" section/);

    const unknownChild = check([
      withReport(long, { children: ["nope0000"] }, section),
    ]);
    assert.equal(unknownChild.status, 1);
    assert.match(unknownChild.out, /names no branch_summary entry/);
  });

  it("rejects malformed metadata and a summary that is not the materialized report", () => {
    const badMeta = check([withReport(report, { version: 2 })]);
    assert.equal(badMeta.status, 1);
    assert.match(badMeta.out, /malformed details\.treeNavigator metadata/);

    const noChildren = check([withReport(report, { children: "none" })]);
    assert.equal(noChildren.status, 1);
    assert.match(noChildren.out, /malformed details\.treeNavigator metadata/);

    const mismatch = check([
      { ...live, summary: live.summary.replace("## Goal", "## Goal\nextra") },
    ]);
    assert.equal(mismatch.status, 1);
    assert.match(
      mismatch.out,
      /summary does not start with "# Work handoff: reviewed three"/,
    );

    const stray = check([withReport(report, {}, "\n\nstray text")]);
    assert.equal(stray.status, 1);
    assert.match(stray.out, /unexpected chars after the own report/);
  });

  it("keeps the legacy contract: preamble required, whole-summary cap", () => {
    const preamble =
      "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";
    const legacy = {
      type: "branch_summary",
      id: "legacy01",
      summary: `${preamble}${report}`,
    };
    assert.equal(check([legacy]).status, 0);

    const bare = check([{ ...legacy, summary: report }]);
    assert.equal(bare.status, 1);
    assert.match(bare.out, /missing pi summary preamble/);

    const modernShaped = check([
      { ...legacy, summary: `# Work handoff: x\n\n${report}` },
    ]);
    assert.equal(modernShaped.status, 1);
    assert.match(modernShaped.out, /missing pi summary preamble/);

    const long = check([
      { ...legacy, summary: `${legacy.summary}\n${"x".repeat(2200)}` },
    ]);
    assert.equal(long.status, 1);
    assert.match(long.out, /legacy summary \d+ chars > 4500/);
  });
});
