/** Temporary configuration trees and session lifecycle drivers for extension tests. */
import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ContextUsage,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { TREE_NAVIGATOR_CONFIG_FILENAME } from "../../src/core/config.ts";
import { buildRewindHintText } from "../../src/core/rewind-hint.ts";
import type { FakeCtx, FakePi } from "./extension-harness.ts";
import { appendTurn } from "./session-messages.ts";

export interface ConfigFixture {
	root: string;
	agentDir: string;
	projectDir: string;
}

export function makeConfigFixture(): ConfigFixture {
	const root = mkdtempSync(join(tmpdir(), "navigate-tree-hint-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// pi's auto-compaction defaults to on, which turns the hint off (#101,
	// D9): the fixture's pi settings turn it off unless a test says otherwise.
	writePiSettings({ root, agentDir, projectDir }, { compaction: { enabled: false } });
	return { root, agentDir, projectDir };
}

/** Write the fixture's global pi `settings.json` (#101). */
export function writePiSettings(fixture: ConfigFixture, settings: unknown): void {
	writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify(settings));
}

export function cleanupConfigFixture(fixture: ConfigFixture): void {
	rmSync(fixture.root, { recursive: true, force: true });
}

export function writeGlobalConfig(fixture: ConfigFixture, raw: string): void {
	writeFileSync(join(fixture.agentDir, TREE_NAVIGATOR_CONFIG_FILENAME), raw);
}

export function writeProjectConfig(fixture: ConfigFixture, raw: string): void {
	const dir = join(fixture.projectDir, CONFIG_DIR_NAME);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, TREE_NAVIGATOR_CONFIG_FILENAME), raw);
}

export function projectConfigPath(fixture: ConfigFixture): string {
	return join(fixture.projectDir, CONFIG_DIR_NAME, TREE_NAVIGATOR_CONFIG_FILENAME);
}

/** Context-usage shape at `percent` of `contextWindow`. */
export function usageAt(percent: number, contextWindow = 1_000_000): ContextUsage {
	return {
		tokens: Math.round((percent / 100) * contextWindow),
		contextWindow,
		percent,
	};
}

/**
 * The hint text at `percent` of `contextWindow` (via `usageAt`), with the
 * reserve the test config sets and the active-anchor list the handler must
 * render (default: the lone `anchorStart` label at 0.0% of 1.0M).
 */
export function expectedHint(
	percent: number,
	anchors = "Active anchors (root → leaf, % of 1.0M):\n   0.0%  start",
	reserve = 100_000,
	contextWindow = 1_000_000,
): string {
	const usage = usageAt(percent, contextWindow);
	return buildRewindHintText(
		percent,
		contextWindow - (usage.tokens ?? 0),
		reserve,
		contextWindow,
		anchors,
	);
}

/**
 * Drive the captured `session_start` handler with `PI_CODING_AGENT_DIR`
 * pointed at the fixture's agent dir (the loader reads the real fs). The env
 * var is always restored, so the suite never touches the user's real config.
 */
export async function runSessionStart(
	pi: FakePi,
	ctx: FakeCtx,
	fixture: ConfigFixture,
	reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): Promise<void> {
	const handlers = pi.onCalls.get("session_start");
	assert.ok(handlers, "factory must register a session_start handler");
	assert.equal(handlers.length, 3);
	const prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = fixture.agentDir;
	try {
		for (const handler of handlers)
			await handler({ type: "session_start", reason } as never, ctx as never);
	} finally {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
	}
}

/**
 * Fire the captured synchronous hint / start-anchor `turn_end` handler. The
 * factory registers two `turn_end` handlers: the async rewind summary
 * handler (#80) first, this one last. Only this one is fired here so the
 * stale-ctx pins (exactly one `sessionManager` read) stay about this
 * handler; rewind tests use `fireTurnEndAll`.
 */
export function fireTurnEnd(pi: FakePi, ctx: FakeCtx, turnIndex = 0): void {
	const handlers = pi.onCalls.get("turn_end");
	assert.ok(handlers, "factory must register a turn_end handler");
	assert.equal(handlers.length, 2);
	const handler = handlers[1];
	assert.ok(handler, "factory must register the turn_end handler");
	handler({ type: "turn_end", turnIndex } as never, ctx as never);
}

/** Drive the `before_agent_start` handler to (re)compute the tool gate. */
export async function fireBeforeAgentStart(
	pi: FakePi,
	ctx: FakeCtx,
	selectedTools: string[] | undefined,
): Promise<void> {
	const handlers = pi.onCalls.get("before_agent_start");
	assert.ok(handlers, "factory must register a before_agent_start handler");
	assert.equal(handlers.length, 1);
	const handler = handlers[0];
	assert.ok(handler, "factory must register a before_agent_start handler");
	await handler(
		{
			type: "before_agent_start",
			prompt: "p",
			systemPrompt: "BASE",
			systemPromptOptions: selectedTools === undefined ? {} : { selectedTools },
		} as never,
		ctx as never,
	);
}

/** Label the current leaf `anchor:start` so the hint path has an anchor. */
export function anchorStart(sm: SessionManager, pi: FakePi): void {
	const t = appendTurn(sm, "u-anchor", "a-anchor");
	pi.pi.setLabel(t.assistantId, "anchor:start");
}
