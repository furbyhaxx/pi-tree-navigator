/** Overflowing sessions and recovery-boundary drivers shared by pressure tests. */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { REWIND_CUSTOM_TYPE } from "../../src/fold/fold-receipts.ts";
import { fireAgentBeforeSettle, fireTurnEndAll } from "./boundary-drivers.ts";
import {
	type ConfigFixture,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
	writePiSettings,
} from "./config-fixtures.ts";
import {
	type BoundaryResult,
	type CapturedTool,
	type FakeCtx,
	type FakePi,
	setup,
} from "./extension-harness.ts";
import {
	appendToolCallAssistant,
	appendToolResult,
	appendTurn,
	assistantMessage,
} from "./session-messages.ts";

export const WINDOW = 100_000;

export const BIG = "x".repeat(48_000); // ~12k tokens

export const theme = { fg: (color: string, text: string) => `<${color}>${text}` };

export interface Forced {
	fixture: ConfigFixture;
	sm: SessionManager;
	pi: FakePi;
	ctx: FakeCtx;
	tool: CapturedTool;
	/** The batch: the issuing assistant and its two big results (r1, r2). */
	issuerId: string;
	r1: string;
	r2: string;
}

export async function forcedSetup(
	opts: {
		config?: Record<string, unknown>;
		piSettings?: Record<string, unknown>;
		anchor?: boolean;
		issuerTokens?: number;
	} = {},
): Promise<Forced> {
	const fixture = makeConfigFixture();
	writeGlobalConfig(fixture, JSON.stringify(opts.config ?? { rewindHintReserveTokens: 20_000 }));
	if (opts.piSettings) writePiSettings(fixture, opts.piSettings);
	const f = setup({ contextWindow: WINDOW });
	(f.ctx.model as { maxTokens?: number }).maxTokens = 64_000;
	f.ctx.cwd = fixture.projectDir;
	await runSessionStart(f.pi, f.ctx, fixture);
	const t = appendTurn(f.sm, "u1", "a1", 5_000);
	if (opts.anchor ?? true) f.pi.pi.setLabel(t.assistantId, "anchor:start");
	appendTurn(f.sm, "u2", "a2", 20_000);
	const issuer = appendToolCallAssistant(
		f.sm,
		[
			{ id: "r1", name: "read", arguments: { path: "a" } },
			{ id: "r2", name: "read", arguments: { path: "b" } },
		],
		opts.issuerTokens ?? 60_000,
	);
	const r1 = appendToolResult(f.sm, "r1", "read", BIG);
	const r2 = appendToolResult(f.sm, "r2", "read", BIG);
	return { fixture, ...f, issuerId: issuer.id, r1, r2 };
}

export function errorOverflow(sm: SessionManager, provider = "claude") {
	const message = {
		...assistantMessage([], "error", 0),
		provider,
		errorMessage: "prompt is too long: 106000 tokens > 100000 maximum",
	};
	return { id: sm.appendMessage(message as never), message };
}

/** pi's order after an error turn: turn_end, agent_end, before_settle. */
export async function runErrorEnd(f: Forced, message: unknown, cont = false) {
	const turn = await fireTurnEndAll(f.pi, f.ctx, message);
	for (const h of f.pi.onCalls.get("agent_end") ?? []) {
		h({ type: "agent_end", messages: [message] } as never, f.ctx as never);
	}
	const settle = await fireAgentBeforeSettle(f.pi, f.ctx, {
		outcome: "error",
		continue: cont,
	});
	return { turn, settle };
}

export function forcedDrafts(result: BoundaryResult) {
	return result.entries.filter((d) => d.customType === REWIND_CUSTOM_TYPE);
}
