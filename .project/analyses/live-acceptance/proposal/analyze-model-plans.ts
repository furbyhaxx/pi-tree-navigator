/**
 * Diagnostic for the model-refined plans produced by run-proposal-acceptance.ts.
 *
 * Reads the raw model output, the snapshot, the saved (adopted) plan and the
 * heuristic base, then reports why the model plan was not adopted, whether the
 * boundaries it chose split tool batches, and whether its factual claims exist
 * in the source. No provider calls, no source changes.
 *
 * Usage: node analyze-model-plans.ts [--run run-1-full] [--run run-2-calls-only]
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseRetrospectivePlan,
  type RetrospectiveGroup,
  type RetrospectivePlan,
  readSessionSnapshot,
  type SessionSnapshot,
} from "../../../../src/retrospective/retrospective-plan.ts";
import { validateRetrospectivePlan } from "../../../../src/retrospective/retrospective.ts";

const OUT = resolve(
  process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : import.meta.dirname,
);
const CORPUS =
  "/mnt/Projects/furbyhaxx/pi-tree-navigator/.project/analyses/live-acceptance/parallel-01/corpus-manifest.json";
const SNAPSHOT = join(OUT, "input", "source-copy.jsonl");
const argv = process.argv.slice(2);
const tags = argv
  .map((value, index) => (value === "--run" ? argv[index + 1] : undefined))
  .filter((value): value is string => Boolean(value));
const runs = tags.length ? tags : ["run-1-full", "run-2-calls-only"];

const hashes = (value: string | undefined) => value?.match(/[a-f0-9]{64}/g) ?? [];

function flatten(
  groups: readonly RetrospectiveGroup[],
  depth = 0,
): { group: RetrospectiveGroup; depth: number }[] {
  return groups.flatMap((group) => [
    { group, depth },
    ...flatten(group.children, depth + 1),
  ]);
}

function lastGroups(text: string): unknown {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || !("groups" in value))
    throw new Error("model output has no groups");
  return (value as { groups: unknown }).groups;
}

function timeline(snapshot: SessionSnapshot, from: number, to: number) {
  return snapshot.entries.slice(Math.max(0, from), Math.min(snapshot.entries.length, to + 1)).map((entry, offset) => ({
    index: Math.max(0, from) + offset,
    id: entry.id,
    type: entry.type === "message" ? `${entry.type}/${entry.message.role}` : entry.type,
    tool: entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolName : undefined,
    safeCut: snapshot.safeCuts.has(Math.max(0, from) + offset),
  }));
}

/**
 * The four accepted partition payloads. Refused load_partition calls also return
 * short results, so select by the "Partition N/4;" banner rather than by order.
 */
function partitionTexts(snapshot: SessionSnapshot) {
  const byIndex = new Map<number, string>();
  for (const entry of snapshot.entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (entry.message.toolName !== "load_partition") continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      : String(content);
    const banner = /Partition (\d)\/4; SHA-256/.exec(text);
    if (banner) byIndex.set(Number(banner[1]), text);
  }
  return [1, 2, 3, 4].map((index) => byIndex.get(index) ?? "");
}

const CLAIM_TOKEN = /[a-z0-9-]+\.(?:ts|md)\b|\b[a-z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*){2,}\b/g;

/** Do the files and symbols a group claims actually occur in that partition? */
function claimGrounding(
  groups: readonly RetrospectiveGroup[],
  partitions: string[],
  wholeSource: string,
) {
  const rows: { group: string; partition: number | "all"; claims: number; present: number; missing: string[] }[] = [];
  for (const group of flatten(groups).map(({ group }) => group)) {
    const match = /^partition-(one|two|three|four)/.exec(group.name);
    const at = match ? ["one", "two", "three", "four"].indexOf(match[1]) : -1;
    const text = match ? (partitions[at] ?? "") : wholeSource;
    const claims = [
      ...new Set(
        [group.summary, group.goal ?? "", group.outcome ?? ""]
          .join(" ")
          .match(CLAIM_TOKEN) ?? [],
      ),
    ];
    rows.push({
      group: group.name,
      partition: match ? at + 1 : "all",
      claims: claims.length,
      present: claims.filter((claim) => text.includes(claim)).length,
      missing: claims.filter((claim) => !text.includes(claim)),
    });
  }
  return rows;
}

function describe(snapshot: SessionSnapshot, plan: RetrospectivePlan) {
  const index = new Map(snapshot.entries.map((entry, at) => [entry.id, at]));
  const code = (entry: (typeof snapshot.entries)[number] | undefined) => {
    if (!entry) return "missing";
    if (entry.type === "message") {
      const tool = entry.message.role === "assistant"
        ? entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.name)
        : entry.message.role === "toolResult"
          ? [entry.message.toolName]
          : [];
      return `${entry.type}/${entry.message.role}${tool.length ? `(${tool.join(",")})` : ""}`;
    }
    return entry.type;
  };
  const rows = flatten(plan.groups).map(({ group, depth }) => {
    const first = index.get(group.firstEntryId);
    const last = index.get(group.lastEntryId);
    const parentId = first === undefined ? undefined : snapshot.entries[first].parentId;
    const parent = parentId === null || parentId === undefined
      ? undefined
      : index.get(parentId);
    const inside = (at: number | undefined) =>
      at === undefined ? null : at >= (first ?? 0) && at <= (last ?? -1);
    const crossingEdits = snapshot.entries.filter((entry, at) => {
      if (entry.type !== "context_edit") return false;
      const target = index.get(entry.targetId);
      return inside(at) !== inside(target);
    }).length;
    return {
      name: group.name,
      depth,
      state: group.state,
      start: first,
      end: last,
      startType: code(first === undefined ? undefined : snapshot.entries[first]),
      endType: code(last === undefined ? undefined : snapshot.entries[last]),
      parentType: code(parent === undefined ? undefined : snapshot.entries[parent]),
      cutBeforeStartSafe: parent !== undefined && snapshot.safeCuts.has(parent),
      cutAfterEndSafe: last !== undefined && snapshot.safeCuts.has(last),
      files: parentId === null,
      contextEditCrossings: crossingEdits,
      entryCount: first === undefined || last === undefined ? 0 : last - first + 1,
    };
  });
  return rows;
}

/**
 * Isolate one folded group and search backwards for a start index that makes
 * that range safe in the clone graph. Every other folded group is opened so one
 * failure cannot mask another.
 */
function searchRepairs(plan: RetrospectivePlan, snapshot: SessionSnapshot) {
  const index = new Map(snapshot.entries.map((entry, at) => [entry.id, at]));
  const mapTree = (
    list: readonly RetrospectiveGroup[],
    target: RetrospectiveGroup,
    startId: string,
    isolate: boolean,
  ): RetrospectiveGroup[] =>
    list.map((group) => {
      const base =
        group === target
          ? { ...group, firstEntryId: startId }
          : isolate && group.state === "folded"
            ? { ...group, state: "open" as const, summary: group.summary || "open" }
            : group;
      return { ...base, children: mapTree(group.children, target, startId, isolate) };
    });
  const attempts: { group: string; start: number; startType: string; error?: string }[] = [];
  const folded = flatten(plan.groups)
    .map(({ group }) => group)
    .filter((group) => group.state === "folded");
  const found: { group: string; start: number }[] = [];
  for (const group of folded) {
    const at = index.get(group.firstEntryId) ?? 1;
    for (let candidate = at; candidate >= 0; candidate--) {
      const startId = snapshot.entries[candidate].id;
      const test: RetrospectivePlan = {
        ...plan,
        groups: mapTree(plan.groups, group, startId, true),
      };
      let failure: string | undefined;
      try {
        validateRetrospectivePlan(snapshot, test);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (!failure || !failure.startsWith(`${group.name}:`)) {
        attempts.push({
          group: group.name,
          start: candidate,
          startType: describe(snapshot, { ...plan, groups: [{ ...group, firstEntryId: startId }] })[0]?.startType ?? "?",
          error: failure,
        });
        found.push({ group: group.name, start: candidate });
        break;
      }
      attempts.push({
        group: group.name,
        start: candidate,
        startType: describe(snapshot, { ...plan, groups: [{ ...group, firstEntryId: startId }] })[0]?.startType ?? "?",
        error: failure,
      });
    }
  }
  let combined: string | undefined = "no candidate starts found";
  if (found.length) {
    let groups = plan.groups;
    for (const item of found) {
      const target = flatten(groups)
        .map(({ group }) => group)
        .find((group) => group.name === item.group);
      if (!target) continue;
      const startId = snapshot.entries[item.start].id;
      const mapAll = (list: readonly RetrospectiveGroup[]): RetrospectiveGroup[] =>
        list.map((group) => ({
          ...(group === target ? { ...group, firstEntryId: startId } : group),
          children: mapAll(group.children),
        }));
      groups = mapAll(groups);
    }
    try {
      validateRetrospectivePlan(snapshot, { ...plan, groups });
      combined = undefined;
    } catch (error) {
      combined = error instanceof Error ? error.message : String(error);
    }
  }
  return { attempts, found, combinedError: combined };
}

/** Move unsafe folded starts back to the nearest preceding safe cut. */
function repaired(plan: RetrospectivePlan, snapshot: SessionSnapshot) {
  const index = new Map(snapshot.entries.map((entry, at) => [entry.id, at]));
  const fix = (groups: readonly RetrospectiveGroup[]): RetrospectiveGroup[] =>
    groups.map((group) => {
      let firstEntryId = group.firstEntryId;
      const at = index.get(firstEntryId);
      const parentId = at === undefined ? null : snapshot.entries[at].parentId;
      const parent = parentId === null ? undefined : index.get(parentId);
      if (group.state === "folded" && (parent === undefined || !snapshot.safeCuts.has(parent))) {
        let cut = (parent ?? -1);
        while (cut > -1 && !snapshot.safeCuts.has(cut)) cut--;
        if (cut + 1 <= (index.get(group.lastEntryId) ?? -1))
          firstEntryId = snapshot.entries[cut + 1].id;
      }
      return { ...group, firstEntryId, children: fix(group.children) };
    });
  return { ...plan, groups: fix(plan.groups) };
}

async function main() {
  const snapshot = await readSessionSnapshot(SNAPSHOT);
  const corpus = JSON.parse(await readFile(CORPUS, "utf8")) as {
    partitions: { index: number; sha256: string }[];
  };
  const sourceText = await readFile(SNAPSHOT, "utf8");
  const report: Record<string, unknown>[] = [];
  for (const tag of runs) {
    const outputs = (await readFile(join(OUT, `${tag}-model-outputs.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { call: number; text: string; usage: { input: number; output: number } });
    const final = outputs.at(-1);
    if (!final) continue;
    let modelGroups: unknown;
    try {
      modelGroups = lastGroups(final.text);
    } catch (error) {
      report.push({
        tag,
        finalCall: final.call,
        finalUsage: final.usage,
        calls: outputs.length,
        outputParseError: error instanceof Error ? error.message : String(error),
        outputHead: final.text.slice(0, 200),
        outputTail: final.text.slice(-120),
        outputBytes: final.text.length,
      });
      continue;
    }
    const adopted = parseRetrospectivePlan(
      JSON.parse(await readFile(join(OUT, "plans", `${tag}.json`), "utf8")),
    );
    const base = { ...adopted, groups: [] as RetrospectiveGroup[] };
    const modelPlan = parseRetrospectivePlan({ ...base, groups: modelGroups });
    const boundaries = describe(snapshot, modelPlan);
    let error: string | undefined;
    try {
      validateRetrospectivePlan(snapshot, modelPlan);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const repair = repaired(modelPlan, snapshot);
    let repairError: string | undefined;
    try {
      validateRetrospectivePlan(snapshot, repair);
    } catch (failure) {
      repairError = failure instanceof Error ? failure.message : String(failure);
    }
    const claims = flatten(modelPlan.groups).flatMap(({ group }) => [
      ...hashes(group.summary),
      ...hashes(group.goal),
      ...hashes(group.outcome),
    ]);
    const uniqueClaims = [...new Set(claims)];
    const adoptedNames = flatten(adopted.groups).map(({ group }) => group.name);
    report.push({
      tag,
      finalCall: final.call,
      finalUsage: final.usage,
      modelGroups: flatten(modelPlan.groups).length,
      modelFolded: flatten(modelPlan.groups).filter(({ group }) => group.state === "folded").length,
      adoptedEqualsModel: JSON.stringify(adopted.groups) === JSON.stringify(modelPlan.groups),
      adoptedNames,
      modelNames: flatten(modelPlan.groups).map(({ group }) => group.name),
      validationError: error,
      boundaries,
      unsafeStarts: boundaries.filter((row) => row.state === "folded" && !row.cutBeforeStartSafe).map((row) => row.name),
      unsafeEnds: boundaries.filter((row) => row.state === "folded" && !row.cutAfterEndSafe).map((row) => row.name),
      search: searchRepairs(modelPlan, snapshot),
      timeline: boundaries.flatMap((row) =>
        row.start === undefined || row.end === undefined
          ? []
          : timeline(snapshot, Math.max(0, row.start - 1), row.end + 1).filter(
              (entry) => entry.index <= row.start + 1 || entry.index >= row.end - 1,
            ),
      ),
      claimGrounding: claimGrounding(
        modelPlan.groups,
        partitionTexts(snapshot),
        sourceText,
      ),
      repair: {
        error: repairError,
        adoptedNames: flatten(repair.groups).map(({ group }) => group.name),
        startsChanged: flatten(repair.groups)
          .filter(({ group }, at) => group.firstEntryId !== flatten(modelPlan.groups)[at]?.group.firstEntryId)
          .map(({ group }) => group.name),
      },
      claims: {
        total: uniqueClaims.length,
        inSource: uniqueClaims.filter((value) => sourceText.includes(value)).length,
        matchesCorpusManifest: uniqueClaims.filter((value) =>
          corpus.partitions.some((partition) => partition.sha256 === value),
        ).length,
        values: uniqueClaims,
      },
      summaries: flatten(modelPlan.groups).map(({ group }) => ({
        name: group.name,
        state: group.state,
        title: group.title,
        summary: group.summary,
        outcome: group.outcome,
      })),
    });
  }
  await writeFile(
    join(OUT, "model-plan-analysis.json"),
    `${JSON.stringify({ runs: report }, null, 2)}\n`,
    { mode: 0o600 },
  );
  for (const run of report)
    console.log(
      JSON.stringify({
        tag: run.tag,
        folded: run.modelFolded,
        adoptedEqualsModel: run.adoptedEqualsModel,
        validationError: run.validationError,
        unsafeStarts: run.unsafeStarts,
        unsafeEnds: run.unsafeEnds,
        repairError: (run.repair as { error?: string } | undefined)?.error,
        claims: run.claims,
      }),
    );
}

await main();
