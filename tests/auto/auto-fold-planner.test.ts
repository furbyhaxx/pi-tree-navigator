import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AssistantMessage, ClassifierContext } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type AutoFoldState, planAutomaticFold } from "../../src/auto/auto-fold-planner.ts";
import { DEFAULT_AUTO_NAVIGATE_CONFIG } from "../../src/auto/auto-navigate-config.ts";
import type { PolicyRegistry } from "../../src/continuity/intent-policy.ts";

const POLICY = JSON.stringify({
	classifier: { model: "fixture/first" },
	confirmer: { model: "fixture/second" },
});
const config = {
	...DEFAULT_AUTO_NAVIGATE_CONFIG,
	enabled: true,
	milestonePolicy: POLICY,
	rewindAtTokens: 100_000,
	minTokensSinceAnchor: 1_000,
	checkEveryTurns: 3,
};
const user = (content: string) => ({
	role: "user" as const,
	content,
	timestamp: 1,
});
const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	stopReason: "stop",
	timestamp: 1,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
});

function fixture() {
	const sm = SessionManager.inMemory();
	sm.appendMessage(user("Implement the adapter"));
	const boundary = sm.appendMessage(assistant("# Adapter verified\nTests pass."));
	const sent: ClassifierContext[] = [];
	let disagree = false;
	let fail = false;
	let onAsk = () => {};
	let selected = boundary;
	const registry = {
		getAvailableOfType: async (type: string) =>
			type === "classifier"
				? ["first", "second"].map((id) => ({
						provider: "fixture",
						id,
						api: "decisions",
					}))
				: [],
		classify: async (model: { id: string }, context: ClassifierContext) => {
			sent.push(context);
			onAsk();
			if (fail) throw new Error("offline failure");
			const choices = {
				status: disagree && model.id === "second" ? "continue" : "milestone",
				boundary: selected,
			};
			for (const [id, choice] of Object.entries(choices)) {
				const question = context.questions[id];
				assert.equal(question?.type, "choice");
				if (question?.type === "choice" && choice !== "invalid")
					assert.ok(choice in question.criteria, `${id}: ${choice} was offered`);
			}
			return {
				answers: Object.fromEntries(
					Object.entries(choices).map(([id, choice]) => [
						id,
						{ type: "choice", choice, confidence: 0.95, probabilities: {} },
					]),
				),
				stopReason: "stop",
			};
		},
		streamSimple: () => {
			throw new Error("No chat calls expected");
		},
	} as unknown as PolicyRegistry;
	const options = () => ({
		sessionId: "session",
		modelKey: "fixture/live",
		config,
		activeTokens: 10_000,
		anchorTokens: 0,
		calledNavigateTree: false,
		entries: sm.getEntries(),
		leafId: sm.getLeafId() ?? "missing",
		getLabel: (id: string) => sm.getLabel(id),
		registry,
		isCurrent: () => true,
	});
	return {
		sm,
		boundary,
		sent,
		options,
		disagree: () => {
			disagree = true;
		},
		fail: () => {
			fail = true;
		},
		onAsk: (fn: () => void) => {
			onAsk = fn;
		},
		select: (id: string) => {
			selected = id;
		},
	};
}

test("an older accepted milestone never folds an unfinished exposed suffix", async () => {
	for (const suffix of ["user", "assistant", "tool", "custom", "image"] as const) {
		const f = fixture();
		if (suffix === "user") f.sm.appendMessage(user("Next unfinished task"));
		if (suffix === "assistant") f.sm.appendMessage(assistant("Next I will edit"));
		if (suffix === "tool")
			f.sm.appendMessage({
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "unfinished output" }],
				isError: false,
				timestamp: 1,
			});
		if (suffix === "custom") f.sm.appendCustomMessageEntry("notice", "Late input", false);
		if (suffix === "image")
			f.sm.appendMessage({
				role: "user",
				content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
				timestamp: 1,
			});
		const out = await planAutomaticFold(f.options());
		assert.deepEqual(
			out.action,
			{
				kind: "anchor",
				entryId: f.boundary,
				suggestedName: "adapter-verified",
			},
			suffix,
		);
	}
});

test("an accepted milestone with a complete tail only places an anchor", async () => {
	const f = fixture();
	const hidden = f.sm.appendMessage(user("Removed by context edit"));
	f.sm.appendContextEdit(hidden, null);
	f.sm.appendCustomEntry("metadata", { ignored: true });
	const out = await planAutomaticFold(f.options());
	assert.deepEqual(out.action, {
		kind: "anchor",
		entryId: f.boundary,
		suggestedName: "adapter-verified",
	});
	assert.equal(out.state.lastActionTokens, 10_000);
	assert.equal(f.sent.length, 2);
	assert.equal(out.evaluation?.status.kind, "accept");
});

test("crossing rewind_at_tokens folds deterministically without asking a classifier", async () => {
	const f = fixture();
	f.disagree();
	const out = await planAutomaticFold({
		...f.options(),
		activeTokens: 100_000,
	});
	assert.deepEqual(out.action, { kind: "pressure-fold" });
	assert.equal(out.state.lastPressureTokens, 100_000);
	assert.equal(f.sent.length, 0);
});

test("a navigate_tree call in the turn does not postpone pressure relief", async () => {
	const f = fixture();
	f.disagree();
	const out = await planAutomaticFold({
		...f.options(),
		activeTokens: 100_000,
		calledNavigateTree: true,
	});
	assert.deepEqual(out.action, { kind: "pressure-fold" });
	assert.equal(f.sent.length, 0);
});

test("a pressure fold that did not get below the threshold waits for half the threshold of fresh tokens, even after its own new anchor", async () => {
	const f = fixture();
	f.disagree();
	let out = await planAutomaticFold({
		...f.options(),
		activeTokens: 120_000,
	});
	assert.equal(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 110_000,
		newestAnchorId: f.boundary,
		anchorTokens: 105_000,
	});
	assert.notEqual(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 110_500,
		newestAnchorId: f.boundary,
		anchorTokens: 105_000,
	});
	assert.notEqual(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 159_000,
		newestAnchorId: f.boundary,
		anchorTokens: 105_000,
	});
	assert.notEqual(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 160_000,
		newestAnchorId: f.boundary,
		anchorTokens: 105_000,
	});
	assert.equal(out.action.kind, "pressure-fold");
});

test("after a fold reduced the context, the next pressure fold fires on the next crossing", async () => {
	const f = fixture();
	f.disagree();
	let out = await planAutomaticFold({
		...f.options(),
		activeTokens: 100_000,
	});
	assert.equal(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 30_000,
	});
	assert.notEqual(out.action.kind, "pressure-fold");
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 100_000,
	});
	assert.equal(out.action.kind, "pressure-fold");
});

test("anchor-only mode, a disabled controller and a stale check never pressure-fold", async () => {
	const f = fixture();
	f.disagree();
	for (const options of [
		{ config: { ...config, mode: "anchor-only" as const } },
		{ config: { ...config, enabled: false } },
		{ isCurrent: () => false },
	]) {
		const out = await planAutomaticFold({
			...f.options(),
			activeTokens: 150_000,
			...options,
		});
		assert.notEqual(out.action.kind, "pressure-fold");
		assert.equal(out.state.lastPressureTokens, undefined);
	}
});

test("anchor-only mode and below-pressure checks only suggest anchors", async () => {
	for (const override of [
		{ config: { ...config, mode: "anchor-only" as const } },
		{ activeTokens: 2_000 },
	]) {
		const f = fixture();
		const out = await planAutomaticFold({ ...f.options(), ...override });
		assert.equal(out.action.kind, "anchor");
	}
});

test("disagreement, invalid boundaries and operational errors abstain", async () => {
	for (const failure of ["disagree", "invalid", "error"] as const) {
		const f = fixture();
		if (failure === "disagree") f.disagree();
		if (failure === "invalid") f.select("invalid");
		if (failure === "error") f.fail();
		const out = await planAutomaticFold(f.options());
		assert.equal(out.action.kind, "none");
		assert.equal(out.state.lastCheckTokens, 10_000);
		if (failure !== "disagree") assert.ok(out.warnings.length > 0);
	}
});

test("stale and aborted checks cannot yield an action, including late input during evaluation", async () => {
	const f = fixture();
	let current = false;
	const options = { ...f.options(), isCurrent: () => current };
	assert.equal((await planAutomaticFold(options)).action.kind, "none");
	assert.equal(f.sent.length, 0);
	current = true;
	f.onAsk(() => {
		current = false;
	});
	const out = await planAutomaticFold(options);
	assert.equal(out.action.kind, "none");
	assert.equal(out.state.lastActionTokens, undefined);
	assert.ok(out.evaluation);
	const signal = AbortSignal.abort();
	assert.equal((await planAutomaticFold({ ...f.options(), signal })).action.kind, "none");
});

test("an anchor action waits for fresh work and new anchors do not recount old work", async () => {
	const f = fixture();
	let out = await planAutomaticFold(f.options());
	assert.equal(out.action.kind, "anchor");
	for (let i = 0; i < 8; i++) {
		out = await planAutomaticFold({ ...f.options(), state: out.state });
		assert.equal(out.action.kind, "none");
	}
	assert.equal(f.sent.length, 2);
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 11_000,
	});
	assert.equal(out.action.kind, "anchor");
	assert.equal(f.sent.length, 4);
	const state: AutoFoldState = out.state;
	out = await planAutomaticFold({
		...f.options(),
		state,
		activeTokens: 11_000,
		newestAnchorId: f.boundary,
		anchorTokens: 5_000,
	});
	assert.equal(out.action.kind, "none");
	assert.equal(out.state.lastCheckTokens, 11_000);
	assert.equal(f.sent.length, 4);
});

test("no-decision checks rearm by turn cadence or fresh token delta, not a repeated crossing", async () => {
	const f = fixture();
	f.disagree();
	let out = await planAutomaticFold(f.options());
	assert.equal(f.sent.length, 2);
	for (let i = 0; i < 2; i++) out = await planAutomaticFold({ ...f.options(), state: out.state });
	assert.equal(f.sent.length, 2);
	out = await planAutomaticFold({ ...f.options(), state: out.state });
	assert.equal(f.sent.length, 4);
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 11_000,
	});
	assert.equal(f.sent.length, 6);
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		activeTokens: 11_000,
	});
	assert.equal(f.sent.length, 6);
});

test("navigate_tree turns install counters without semantic calls; effective model/config changes reset cadence", async () => {
	const f = fixture();
	f.disagree();
	let out = await planAutomaticFold({
		...f.options(),
		calledNavigateTree: true,
	});
	assert.equal(out.state.turnsSinceCheck, 0);
	assert.equal(out.state.lastCheckTokens, 10_000);
	assert.equal(out.state.aboveRewindThreshold, false);
	assert.equal(f.sent.length, 0);
	out = await planAutomaticFold({ ...f.options(), state: out.state });
	assert.equal(f.sent.length, 0);
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		modelKey: "fixture/other",
	});
	assert.equal(f.sent.length, 2);
	out = await planAutomaticFold({
		...f.options(),
		state: out.state,
		modelKey: "fixture/other",
		config: { ...config, tools: { read: "omit" } },
	});
	assert.equal(f.sent.length, 4);
});

test("policy changes reset cadence, equivalent settings do not, and previous state stays immutable", async () => {
	const f = fixture();
	f.disagree();
	const first = await planAutomaticFold(f.options());
	const saved = structuredClone(first.state);
	const same = await planAutomaticFold({
		...f.options(),
		state: first.state,
		config: {
			...config,
			milestonePolicy: JSON.stringify(JSON.parse(POLICY), null, 2),
		},
	});
	assert.deepEqual(first.state, saved);
	assert.equal(same.state.turnsSinceCheck, 1);
	assert.equal(f.sent.length, 2);
	await planAutomaticFold({
		...f.options(),
		state: same.state,
		config: {
			...config,
			milestonePolicy: JSON.stringify({
				...JSON.parse(POLICY),
				minConfidence: 0.8,
			}),
		},
	});
	assert.equal(f.sent.length, 4);
});

test("new anchors retain the consumed token baseline instead of recounting their old suffix", async () => {
	const f = fixture();
	f.disagree();
	const first = await planAutomaticFold({
		...f.options(),
		activeTokens: 2_000,
	});
	assert.equal(f.sent.length, 2);
	const second = await planAutomaticFold({
		...f.options(),
		state: first.state,
		activeTokens: 2_500,
		newestAnchorId: f.boundary,
		anchorTokens: 1_000,
	});
	assert.equal(second.action.kind, "none");
	assert.equal(second.state.lastCheckTokens, 2_000);
	assert.equal(f.sent.length, 2);
	await planAutomaticFold({
		...f.options(),
		state: second.state,
		activeTokens: 3_000,
		newestAnchorId: f.boundary,
		anchorTokens: 1_000,
	});
	assert.equal(f.sent.length, 4);
});

test("long readable anchor names stay within forty characters including collision suffix", async () => {
	const f = fixture();
	const text = "Verified adapter integration with all supported database connection variants";
	const boundary = f.sm.appendMessage(assistant(text));
	f.select(boundary);
	const first = await planAutomaticFold({
		...f.options(),
		config: { ...config, mode: "anchor-only" },
	});
	assert.equal(first.action.kind, "anchor");
	if (first.action.kind !== "anchor") return;
	assert.ok(first.action.suggestedName.length <= 40);
	const collision = f.sm.appendCustomEntry("metadata", {});
	f.sm.appendLabelChange(collision, `anchor:${first.action.suggestedName}`);
	f.sm.branch(boundary);
	const second = await planAutomaticFold({
		...f.options(),
		config: { ...config, mode: "anchor-only" },
	});
	assert.equal(second.action.kind, "anchor");
	if (second.action.kind !== "anchor") return;
	assert.ok(second.action.suggestedName.length <= 40);
	assert.match(second.action.suggestedName, /^[a-z0-9]+(?:-[a-z0-9]+)*-2$/);
	assert.notEqual(first.action.suggestedName, second.action.suggestedName);
});

test("disabled policies and empty evidence make no requests", async () => {
	for (const override of [
		{ enabled: false },
		{ milestonePolicy: null },
		{ milestonePolicy: "{}" },
	]) {
		const f = fixture();
		const out = await planAutomaticFold({
			...f.options(),
			config: { ...config, ...override },
		});
		assert.equal(out.action.kind, "none");
		assert.equal(f.sent.length, 0);
	}
	const f = fixture();
	const out = await planAutomaticFold({
		...f.options(),
		entries: [],
		leafId: "missing",
	});
	assert.equal(out.action.kind, "none");
	assert.equal(f.sent.length, 0);
});

test("disclosure applies before requests and cannot hide an exposed unfinished suffix", async () => {
	const f = fixture();
	f.sm.appendMessage({
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: "SECRET_RESULT" }],
		isError: false,
		timestamp: 1,
	});
	const out = await planAutomaticFold({
		...f.options(),
		config: { ...config, tools: { read: "omit" } },
	});
	assert.equal(out.action.kind, "anchor");
	assert.ok(!JSON.stringify(f.sent).includes("SECRET_RESULT"));
	assert.ok(
		!out.warnings.some((warning) => warning.includes("disclosure")),
		"expected disclosure omissions are not persisted as warnings",
	);
});

test("anchor names are bounded, readable, deterministic, collision-safe and never overwrite labels", async () => {
	const f = fixture();
	const collision = f.sm.appendCustomEntry("metadata", {});
	f.sm.appendLabelChange(collision, "anchor:adapter-verified");
	const out = await planAutomaticFold({
		...f.options(),
		config: { ...config, mode: "anchor-only" },
	});
	assert.equal(out.action.kind, "none");
	f.sm.branch(f.boundary);
	const named = await planAutomaticFold({
		...f.options(),
		config: { ...config, mode: "anchor-only" },
	});
	assert.deepEqual(named.action, {
		kind: "anchor",
		entryId: f.boundary,
		suggestedName: "adapter-verified-2",
	});
	f.sm.appendLabelChange(f.boundary, "manual-label");
	assert.equal(
		(
			await planAutomaticFold({
				...f.options(),
				config: { ...config, mode: "anchor-only" },
			})
		).action.kind,
		"none",
	);
	const g = fixture();
	const unreadable = g.sm.appendMessage(assistant("!!!"));
	g.select(unreadable);
	const fallback = await planAutomaticFold({
		...g.options(),
		config: { ...config, mode: "anchor-only" },
	});
	assert.equal(fallback.action.kind, "anchor");
	if (fallback.action.kind === "anchor") {
		assert.match(fallback.action.suggestedName, /^milestone-[a-z0-9-]+$/);
		assert.ok(fallback.action.suggestedName.length <= 40);
	}
});
