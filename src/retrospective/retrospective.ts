/** Retrospective plan previews and atomic session-family publication. */
import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { discoverDescendantSessions, planDescendantCopies } from "./descendant-sessions.ts";
import { buildClone } from "./retrospective-clone.ts";
import {
	type RetrospectivePlan,
	readRetrospectivePlan,
	readSessionSnapshot,
	type SessionSnapshot,
	sha256,
} from "./retrospective-plan.ts";

/** Reviewable conversion output; its token binds both the source and complete plan. */
export interface RetrospectivePreview {
	readonly source: string;
	readonly sourceSha256: string;
	readonly name: string;
	readonly previewToken: string;
	readonly originalEntries: number;
	readonly addedEntries: number;
	readonly groups: readonly {
		name: string;
		depth: number;
		firstEntryId: string;
		lastEntryId: string;
		summary: string;
		state: "folded" | "open";
		mode: "full" | "synthesized" | "digest";
	}[];
	readonly descendants: readonly {
		source: string;
		sourceSha256: string;
		mode: "copied" | "restructured";
	}[];
	readonly warnings: readonly string[];
}

/** Validate a plan entirely in memory without discovering or publishing sessions. */
export function validateRetrospectivePlan(
	snapshot: SessionSnapshot,
	plan: RetrospectivePlan,
): void {
	if (snapshot.sha256 !== plan.sourceSha256) throw new Error("Source snapshot changed");
	buildClone(snapshot, plan);
}

async function prepare(path: string) {
	const plan = await readRetrospectivePlan(path);
	const snapshot = await readSessionSnapshot(plan.source);
	if (snapshot.sha256 !== plan.sourceSha256)
		throw new Error(
			"Source snapshot changed: inspect it again and review the plan against the new hash",
		);
	const clone = buildClone(snapshot, plan);
	const descendants = await discoverDescendantSessions(snapshot.path);
	const descendantClones = new Map<
		string,
		{ plan: RetrospectivePlan; clone: ReturnType<typeof buildClone> }
	>();
	if (!plan.recurse && plan.descendantPlans.length)
		throw new Error(
			"descendantPlans requires recurse: true; otherwise descendant histories are copied unchanged",
		);
	if (plan.recurse) {
		for (const planPath of plan.descendantPlans) {
			const childPlan = await readRetrospectivePlan(planPath);
			const child = await readSessionSnapshot(childPlan.source);
			if (!descendants.some((descendant) => descendant.path === child.path))
				throw new Error(`Plan source is not a descendant of this session: ${child.path}`);
			if (child.sha256 !== childPlan.sourceSha256)
				throw new Error(`Descendant snapshot changed: ${child.path}`);
			if (descendantClones.has(child.path))
				throw new Error(`Duplicate descendant plan: ${child.path}`);
			descendantClones.set(child.path, {
				plan: childPlan,
				clone: buildClone(child, childPlan),
			});
		}
		const missing = descendants.filter((descendant) => !descendantClones.has(descendant.path));
		if (missing.length)
			throw new Error(
				`Recursive restructuring requires a reviewed plan for every descendant. Missing ${missing.length}: ${missing.map((item) => item.path).join(", ")}. Supply descendantPlans or leave recurse off to copy their histories unchanged.`,
			);
	}
	const family = descendants.map((descendant) => ({
		source: descendant.path,
		sourceSha256: descendant.sha256,
		mode: descendantClones.has(descendant.path) ? ("restructured" as const) : ("copied" as const),
	}));
	const preview: RetrospectivePreview = {
		source: snapshot.path,
		sourceSha256: snapshot.sha256,
		name: clone.name,
		previewToken: sha256(
			JSON.stringify({
				source: snapshot.path,
				plan,
				family,
				descendantPlans: [...descendantClones].map(([source, item]) => ({
					source,
					plan: item.plan,
				})),
			}),
		),
		descendants: family,
		originalEntries: snapshot.entries.length,
		addedEntries: clone.entries.length - snapshot.entries.length,
		groups: clone.groups,
		warnings: [
			"Summary accuracy is not machine-verifiable. Review every handoff before creating the clone.",
			"Extension-specific custom state remains on its original branch; external provider histories and extension sidecar files are not cloned.",
		],
	};
	return { snapshot, clone, preview, descendants, descendantClones };
}

/** Validate a conversion and return its complete review surface without creating a session. */
export async function previewRetrospectiveSession(planPath: string): Promise<RetrospectivePreview> {
	return (await prepare(planPath)).preview;
}

/** Publish a new independently resumable session, only for the exact previewed plan and snapshot. */
export async function cloneRetrospectiveSession(planPath: string, previewToken: string) {
	const { snapshot, clone, preview, descendants, descendantClones } = await prepare(planPath);
	if (previewToken !== preview.previewToken)
		throw new Error("Preview changed or missing; preview the plan again before creating a clone");
	const sessionId = randomUUID();
	const dir = dirname(snapshot.path);
	const path = join(dir, `${clone.timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	const header = {
		...snapshot.header,
		id: sessionId,
		timestamp: clone.timestamp,
	};
	const data = `${[header, ...clone.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const copied = planDescendantCopies(descendants, snapshot.path, path).map((copy) => {
		const replacement = descendantClones.get(copy.source.path);
		if (!replacement) return copy;
		const newline = copy.bytes.indexOf(10);
		const childHeader: unknown = JSON.parse(copy.bytes.subarray(0, newline).toString("utf8"));
		return {
			...copy,
			bytes: Buffer.from(
				`${[childHeader, ...replacement.clone.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			),
		};
	});
	const files = [
		...copied.map((copy) => ({ path: copy.path, bytes: copy.bytes })),
		{ path, bytes: Buffer.from(data) },
	];
	const staged: { path: string; temporary: string }[] = [];
	const published: string[] = [];
	const warnings: string[] = [];
	let failure: { error: unknown } | undefined;
	try {
		for (const file of files) {
			const temporary = join(dirname(file.path), `.tree-clone-${randomUUID()}.tmp`);
			const handle = await open(temporary, "wx", 0o600);
			staged.push({ path: file.path, temporary });
			try {
				await handle.writeFile(file.bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		const root = staged.at(-1);
		if (!root) throw new Error("Missing staged root");
		const reopened = SessionManager.open(root.temporary);
		if (
			reopened.getSessionId() !== sessionId ||
			reopened.getSessionName() !== preview.name ||
			reopened.getEntries().length !== clone.entries.length
		) {
			throw new Error("Clone failed Pi session reload validation");
		}
		if (
			!isDeepStrictEqual(
				buildSessionContext(reopened.getEntries()),
				buildSessionContext(clone.entries),
			)
		)
			throw new Error("Clone context changed after reloading");
		if (sha256(await readFile(snapshot.path)) !== snapshot.sha256)
			throw new Error("Source changed during conversion; no clone was published");
		for (const descendant of descendants)
			if (sha256(await readFile(descendant.path)) !== descendant.sha256)
				throw new Error(`Descendant changed during conversion: ${descendant.path}`);
		const currentFamily = await discoverDescendantSessions(snapshot.path);
		if (
			!isDeepStrictEqual(
				currentFamily.map((item) => [item.path, item.sha256]),
				descendants.map((item) => [item.path, item.sha256]),
			)
		)
			throw new Error("Descendant family changed during conversion; preview again");
		for (const file of staged) {
			await link(file.temporary, file.path);
			published.push(file.path);
		}
	} catch (error) {
		failure = { error };
		const rollback = await Promise.allSettled(published.map((path) => unlink(path)));
		const incomplete = rollback.flatMap((result, index) =>
			result.status === "rejected" ? [published[index]] : [],
		);
		if (incomplete.length)
			failure = {
				error: new Error(
					`Conversion failed and rollback left cloned files: ${incomplete.join(", ")}`,
					{ cause: error },
				),
			};
	}
	for (const file of staged) {
		try {
			await unlink(file.temporary);
		} catch {
			warnings.push(`Temporary file cleanup failed: ${file.temporary}`);
		}
	}
	if (failure) throw failure.error;
	if (process.platform !== "win32") {
		try {
			for (const location of new Set(files.map((file) => dirname(file.path)))) {
				const directory = await open(location, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
			}
		} catch {
			warnings.push(
				"Clone published, but directory sync failed; crash durability could not be confirmed.",
			);
		}
	}
	return {
		path,
		warnings,
		sessionId,
		name: preview.name,
		source: snapshot.path,
		sourceSha256: snapshot.sha256,
		descendants: copied.map((copy) => ({
			source: copy.source.path,
			path: copy.path,
			sessionId: copy.sessionId,
			mode: descendantClones.has(copy.source.path) ? "restructured" : "copied",
		})),
	};
}
