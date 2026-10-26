import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";

/** An immutable-body source snapshot, bound to the complete source bytes. */
export interface DescendantSnapshot {
	readonly path: string;
	readonly sha256: string;
	readonly header: SessionHeader;
	readonly body: Buffer;
}

function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function header(value: unknown, path: string): SessionHeader {
	if (
		!record(value) ||
		value.type !== "session" ||
		value.version !== 3 ||
		typeof value.id !== "string" ||
		!value.id.trim() ||
		typeof value.timestamp !== "string" ||
		!Number.isFinite(Date.parse(value.timestamp)) ||
		typeof value.cwd !== "string" ||
		!value.cwd.trim() ||
		(value.parentSession !== undefined &&
			(typeof value.parentSession !== "string" || !value.parentSession.trim()))
	)
		throw new Error(`Invalid session header/version: ${path}`);
	return {
		...value,
		type: "session",
		version: value.version,
		id: value.id,
		timestamp: value.timestamp,
		cwd: value.cwd,
		parentSession: value.parentSession,
	};
}

async function firstLine(path: string): Promise<unknown> {
	const file = await open(path, "r");
	try {
		const chunks: Buffer[] = [];
		const chunk = Buffer.alloc(1024);
		for (;;) {
			const { bytesRead } = await file.read(chunk);
			if (!bytesRead) break;
			const end = chunk.subarray(0, bytesRead).indexOf(10);
			chunks.push(Buffer.from(chunk.subarray(0, end < 0 ? bytesRead : end)));
			if (end >= 0) break;
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await file.close();
	}
}

/** Relative parentSession links resolve from the owning file's directory, never cwd. */
function parentPath(path: string, parent: string): string {
	return realpathSync(resolve(dirname(path), parent));
}

/** Discover only path-linked descendants within bounded session-store directories. */
export async function discoverDescendantSessions(
	sourcePath: string,
	searchRoot?: string,
): Promise<DescendantSnapshot[]> {
	const source = await realpath(sourcePath);
	const root = searchRoot ? await realpath(searchRoot) : dirname(source);
	const encoded = (name: string) => name.startsWith("--") && name.endsWith("--");
	const scope =
		!searchRoot && encoded(basename(root)) && basename(dirname(root)) === "sessions"
			? dirname(root)
			: root;
	const directories = [root];
	for (const entry of await readdir(scope, { withFileTypes: true })) {
		if (entry.isDirectory() && encoded(entry.name)) directories.push(join(scope, entry.name));
	}
	const candidates = new Map<string, { raw: unknown; parent?: string }>();
	for (const directory of new Set(directories)) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
			try {
				const path = await realpath(join(directory, entry.name));
				if (candidates.has(path)) continue;
				const raw = await firstLine(path);
				let parent: string | undefined;
				if (record(raw) && typeof raw.parentSession === "string") {
					try {
						parent = parentPath(path, raw.parentSession);
					} catch {
						/* Orphan links cannot select a descendant. */
					}
				}
				candidates.set(path, { raw, parent });
			} catch {
				/* Unrelated malformed files are not sessions in this family. */
			}
		}
	}
	const rootHeader = header(await firstLine(source), source);
	const selected = new Set([source]);
	const ordered: string[] = [];
	for (;;) {
		let added = false;
		for (const [path, candidate] of candidates) {
			if (!selected.has(path) && candidate.parent && selected.has(candidate.parent)) {
				selected.add(path);
				ordered.push(path);
				added = true;
			}
		}
		if (!added) break;
	}
	let rootParent: string | undefined;
	if (rootHeader.parentSession) {
		try {
			rootParent = parentPath(source, rootHeader.parentSession);
		} catch {
			/* The root may have an unavailable parent. */
		}
	}
	if (rootParent && selected.has(rootParent)) throw new Error("Cycle in selected session family");
	const ids = new Set([rootHeader.id]);
	const result: DescendantSnapshot[] = [];
	for (const path of ordered) {
		const bytes = await readFile(path);
		const end = bytes.indexOf(10);
		if (end < 0) throw new Error(`Missing session header newline: ${path}`);
		const parsed = header(JSON.parse(bytes.subarray(0, end).toString("utf8")), path);
		const candidate = candidates.get(path);
		if (JSON.stringify(parsed) !== JSON.stringify(candidate?.raw))
			throw new Error(`Source changed during discovery: ${path}`);
		if (ids.has(parsed.id)) throw new Error(`Duplicate session ID: ${parsed.id}`);
		ids.add(parsed.id);
		result.push({
			path,
			sha256: hash(bytes),
			header: parsed,
			body: Buffer.from(bytes.subarray(end + 1)),
		});
	}
	return result;
}

/** Plan new headers and filenames without writing or changing transcript bodies. */
export function planDescendantCopies(
	snapshots: readonly DescendantSnapshot[],
	rootSourcePath: string,
	rootClonePath: string,
): Array<{
	source: DescendantSnapshot;
	path: string;
	sessionId: string;
	bytes: Buffer;
}> {
	const paths = new Map([[realpathSync(rootSourcePath), resolve(rootClonePath)]]);
	return snapshots.map((source) => {
		const parent = source.header.parentSession;
		const parentSession = parent && paths.get(parentPath(source.path, parent));
		if (!parentSession || paths.has(source.path))
			throw new Error(`Unordered or duplicate descendant: ${source.path}`);
		const sessionId = randomUUID();
		const timestamp = new Date().toISOString();
		const path = join(
			dirname(source.path),
			`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
		);
		paths.set(source.path, path);
		const newHeader = {
			...source.header,
			id: sessionId,
			timestamp,
			parentSession,
		};
		return {
			source,
			path,
			sessionId,
			bytes: Buffer.concat([Buffer.from(`${JSON.stringify(newHeader)}\n`), source.body]),
		};
	});
}
