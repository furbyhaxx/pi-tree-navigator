/**
 * Tests for `/anchor tree`: outline rows and the navigation flow.
 *
 * Node test runner. Rows are built from a real in-memory `SessionManager`
 * holding an anchor, a completed fold and later turns, like the live extension
 * writes them; the screen runs on the real `FrameList` at 60 columns.
 */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	type ExtensionCommandContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BRANCH_LABEL_PREFIX, LABEL_PREFIX } from "../../src/core/helpers.ts";
import { makeHandoff, materializeHandoff } from "../../src/fold/handoff.ts";
import {
	openTreeScreen,
	TREE_BUSY_NOTICE,
	type TreeAnchor,
	type TreeScreenDeps,
	treeItems,
	treeRow,
	treeSummary,
} from "../../src/ui/tree-screen.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";
const WIDTH = 60;
const LONG =
	"Please also make the error recovery resilient against truncated input, unterminated strings and unicode surrogates in every token";

const user = (text: string) =>
	({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	}) as never;
const assistant = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 1200,
			output: 300,
			cacheRead: 5000,
			cacheWrite: 500,
			cost: { total: 0.01 },
		},
		timestamp: Date.now(),
	}) as never;

/** u1, a1 (anchor impl-start), a completed fold of impl-done, u3, a3 (the leaf). */
function seed() {
	const sm = SessionManager.inMemory("/tmp");
	const u1 = sm.appendMessage(user("Set up the parser project"));
	const a1 = sm.appendMessage(assistant("Project created"));
	sm.appendLabelChange(a1, `${LABEL_PREFIX}impl-start`);
	sm.appendMessage(user("Implement the tokenizer"));
	sm.appendMessage(assistant("Tokenizer written"));
	const archived = sm.appendMessage(assistant("## Goal\nA tokenizer"));
	sm.appendLabelChange(archived, `${BRANCH_LABEL_PREFIX}impl-done`);
	const handoff = makeHandoff({
		name: "impl-done",
		title: "Tokenizer implemented",
		goal: "Write the tokenizer",
		outcome: "Tokenizer passes all tests",
		report: "## Goal\nA tokenizer",
		mode: "full",
		children: [],
		sourceEntries: sm.getEntries().slice(2),
	});
	const fold = sm.branchWithSummary(
		a1,
		materializeHandoff(handoff, []),
		{ treeNavigator: handoff },
		true,
	);
	sm.appendLabelChange(fold, `${LABEL_PREFIX}impl-done`);
	const u3 = sm.appendMessage(user(LONG));
	const a3 = sm.appendMessage(assistant("Working on error recovery"));
	return { sm, u1, a1, archived, fold, u3, a3 };
}

type Script = (screen: {
	handleInput(data: string): void;
	render(width: number): string[];
}) => void;
const press =
	(...keys: string[]): Script =>
	(screen) => {
		for (const key of keys) screen.handleInput(key);
	};

function harness(
	sm: SessionManager,
	options: {
		confirms?: boolean[];
		anchors?: TreeAnchor[];
		/** Move the real session like the host's `navigateTree`. */
		native?: boolean;
	} = {},
) {
	const state = { idle: true, cancelNavigation: false };
	const navigated: string[] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
	const confirms: [string, string][] = [];
	const answers = [...(options.confirms ?? [])];
	const rendered: string[][] = [];
	const scripts: Script[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const ctx = {
		hasUI: true,
		isIdle: () => state.idle,
		sessionManager: sm,
		async navigateTree(id: string) {
			navigated.push(id);
			if (options.native && !state.cancelNavigation && id !== sm.getLeafId()) {
				const entry = sm.getEntry(id) as SessionEntry;
				const before =
					entry.type === "custom_message" ||
					(entry.type === "message" && entry.message.role === "user");
				if (!before) sm.branch(id);
				else if (entry.parentId === null) sm.resetLeaf();
				else sm.branch(entry.parentId);
			}
			return { cancelled: state.cancelNavigation };
		},
		ui: {
			notify: (message: string, type?: string) => void notifications.push({ message, type }),
			async confirm(title: string, message: string) {
				confirms.push([title, message]);
				return answers.shift() ?? false;
			},
			custom(factory: (...args: unknown[]) => Parameters<Script>[0]): Promise<unknown> {
				const script = scripts.shift();
				assert.ok(script, "unexpected extra screen");
				return new Promise((resolve) => {
					const tui = {
						terminal: { rows: 40, columns: WIDTH },
						requestRender() {},
					};
					const screen = factory(tui, theme, undefined, resolve);
					const lines = screen.render(WIDTH);
					rendered.push(lines);
					script(screen);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const deps: TreeScreenDeps = {
		contextBadge: () => "ctx 12.3% of 200k",
		listAnchors: () => options.anchors ?? [{ name: "impl-start", percent: 4.2 }],
	};
	return {
		ctx,
		state,
		navigated,
		notifications,
		confirms,
		rendered,
		run: (...screens: Script[]) => {
			scripts.push(...screens);
			return openTreeScreen(ctx, deps);
		},
	};
}

const textOf = (lines: readonly string[]): string => lines.join("\n");
const fits = (lines: readonly string[]): void => {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= WIDTH, `line is ${visibleWidth(line)} columns: ${line}`);
	}
};

describe("tree outline rows", () => {
	it("lists the active branch chronologically with the archived row and the current position last", () => {
		const { sm, a1, archived, fold, u1, a3 } = seed();
		const items = treeItems(sm, [{ name: "impl-start", percent: 4.2 }]);
		assert.deepEqual(
			items.map(({ kind, targetId }) => [kind, targetId]),
			[
				["user", u1],
				["anchor", a1],
				["handoff", fold],
				["archived", archived],
				["user", required(items[4]).targetId],
				["leaf", a3],
			],
		);
		const rows = items.map(treeRow);
		assert.equal(required(rows[1]).label, "◆ impl-start");
		assert.equal(required(rows[1]).value, "4.2%");
		assert.match(required(rows[1]).detail ?? "", /^at: assistant: Project created$/);
		assert.equal(required(rows[2]).label, "▣ Tokenizer implemented");
		assert.equal(required(rows[2]).value, "folded · 14.0k tok · 3 msg");
		assert.equal(required(rows[2]).detail, "outcome: Tokenizer passes all tests");
		assert.deepEqual(rows[3], {
			label: "  ↳",
			labelHint: "archived: impl-done",
		});
		assert.equal(required(rows[5]).label, "● [current]");
		assert.equal(required(rows[5]).labelHint, "assistant: Working on error recovery");
		assert.equal(items.filter(({ current }) => current).length, 1);
		assert.equal(items.at(-1)?.current, true);
		assert.equal(treeSummary(items), "1 fold · 1 anchor");
	});

	it("marks an anchored leaf on its own row, looking past label entries", () => {
		const { sm } = seed();
		sm.appendLabelChange(sm.getLeafId() as string, `${LABEL_PREFIX}wip`);
		const items = treeItems(sm);
		assert.equal(items.at(-1)?.kind, "anchor");
		assert.equal(treeRow(items.at(-1) as never).label, "◆ [current] wip");
		assert.equal(items.filter(({ kind }) => kind === "leaf").length, 0);
		assert.equal(items.filter(({ current }) => current).length, 1);
	});

	it("indents handoffs nested in a fold one level per depth, capped, and lists their archived work", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Start"));
		const root = sm.appendMessage(assistant("Ready"));
		let children: string[] = [];
		const ids: string[] = [];
		for (const name of ["a", "b", "c", "d", "e"]) {
			const work = sm.appendMessage(assistant(`work ${name}`));
			sm.appendLabelChange(work, `${BRANCH_LABEL_PREFIX}${name}`);
			const handoff = makeHandoff({
				name,
				title: `Phase ${name}`,
				report: "body",
				mode: "full",
				children,
				sourceEntries: [],
			});
			const id = sm.branchWithSummary(root, "x", { treeNavigator: handoff });
			ids.push(id);
			children = [id];
		}
		const items = treeItems(sm);
		const top = items.filter(({ kind }) => kind === "handoff");
		assert.deepEqual(
			top.map(({ depth }) => depth),
			[0, 1, 2, 3, 4],
		);
		assert.equal(required(top[0]).targetId, required(ids[4]));
		assert.equal(required(top[4]).targetId, required(ids[0]));
		assert.equal(treeRow(required(top[1])).label, "  ▣ Phase d");
		assert.equal(treeRow(required(top[3])).label, "      ▣ Phase b");
		assert.equal(treeRow(required(top[4])).label, "      ▣ Phase a");
		const archivedUnderTop = required(items[items.indexOf(required(top[0])) + 1]);
		assert.equal(archivedUnderTop.kind, "archived");
		assert.equal(archivedUnderTop.text, "archived: e");
		assert.equal(treeSummary(items), "1 fold · 0 anchors");
	});

	it("shows a native branch summary by its heading, without folded accounting", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Question"));
		sm.branchWithSummary(
			null,
			"The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n## Goal\nTry the other parser\n\n## Progress\nnone",
		);
		const [fold] = treeItems(sm);
		assert.ok(fold);
		assert.equal(fold.kind, "handoff");
		assert.equal(fold.text, "Try the other parser");
		assert.equal(fold.value, "folded");
		assert.equal(treeItems(SessionManager.inMemory("/tmp")).length, 0);
	});
});

describe("tree screen", () => {
	it("filters on a plain action letter without navigating or cycling the outline", async () => {
		const { sm } = seed();
		const h = harness(sm);
		await h.run((screen) => {
			screen.handleInput("g");
			assert.match(screen.render(130).join("\n"), /❯ g/);
			screen.handleInput(ESC);
			screen.handleInput(ESC);
		});
		assert.deepEqual(h.navigated, []);
		assert.deepEqual(h.confirms, []);
		assert.equal(h.rendered.length, 1);
	});
	it("renders the outline in order within 60 columns, with the fold badge and context", async () => {
		const { sm } = seed();
		const h = harness(sm);
		assert.equal(await h.run(press(ESC)), "back");
		const text = textOf(required(h.rendered[0]));
		const order = [
			"Set up the parser project",
			"◆ impl-start",
			"▣ Tokenizer implemented",
			"↳ archived: impl-done",
			"› Please also make",
			"● [current] assistant: Working",
		];
		const at = order.map((part) => text.indexOf(part));
		assert.ok(
			at.every((index) => index >= 0),
			text,
		);
		assert.deepEqual(
			at,
			[...at].sort((a, b) => a - b),
		);
		assert.match(required(required(h.rendered[0])[0]), /1 fold · 1 anchor · ctx 12\.3% ─$/);
		assert.match(text, /→ ● \[current\]/);
		for (const lines of h.rendered) fits(lines);
	});

	it("keeps every line within 60 columns on each row, filter and the details view", async () => {
		const { sm } = seed();
		const h = harness(sm);
		const sweep =
			(leave: string): Script =>
			(screen) => {
				for (let i = 0; i < 8; i++) {
					fits(screen.render(WIDTH));
					screen.handleInput(UP);
				}
				screen.handleInput(leave);
			};
		await h.run(sweep("\x1bf"), sweep("\x1bf"), sweep(ESC));
		assert.equal(h.rendered.length, 3);
		for (const lines of h.rendered) fits(lines);
	});

	it("goes to a row with g after a confirmation that says nothing is deleted", async () => {
		const { sm, a1, archived, fold, u3 } = seed();
		const h = harness(sm, { confirms: [true] });
		const exit = await h.run(press(UP, UP, "\x1bg"));
		assert.equal(exit, "done");
		assert.deepEqual(h.navigated, [archived]);
		const [title, message] = required(h.confirms[0]);
		assert.match(title, /archived work of 'impl-done'/);
		assert.match(message, /leaf moves there/);
		assert.match(message, /Nothing is deleted/);
		assert.deepEqual(
			h.notifications.map(({ type }) => type),
			["info"],
		);

		const second = harness(sm, { confirms: [true, true, true] });
		await second.run(press(UP, UP, UP, "\x1bg"));
		await second.run(press(UP, UP, UP, UP, "\x1bg"));
		await second.run(press(UP, "\x1bg"));
		assert.deepEqual(second.navigated, [fold, a1, u3]);
		assert.match(required(required(second.confirms[0])[0]), /fold “Tokenizer implemented”/);
		assert.match(required(required(second.confirms[1])[0]), /anchor 'impl-start'/);
		assert.match(required(required(second.confirms[2])[1]), /just before this message/);
	});

	it("navigates nothing when the confirmation is declined", async () => {
		const { sm } = seed();
		const h = harness(sm, { confirms: [false] });
		const exit = await h.run(press(UP, UP, UP, "\x1bg"), press(ESC));
		assert.equal(exit, "back");
		assert.equal(h.confirms.length, 1);
		assert.deepEqual(h.navigated, []);
		assert.deepEqual(h.notifications, []);
	});

	it("refuses to navigate while the agent is working, before asking anything", async () => {
		const { sm } = seed();
		const h = harness(sm, { confirms: [true] });
		h.state.idle = false;
		await h.run(press(UP, UP, UP, "\x1bg"), press(ESC));
		assert.deepEqual(h.navigated, []);
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.notifications, [{ message: TREE_BUSY_NOTICE, type: "warning" }]);
	});

	it("does not move when the agent starts working during the confirmation", async () => {
		const { sm } = seed();
		const h = harness(sm, { confirms: [true] });
		const confirm = h.ctx.ui.confirm.bind(h.ctx.ui);
		h.ctx.ui.confirm = async (title, message) => {
			h.state.idle = false;
			return confirm(title, message);
		};
		await h.run(press(UP, UP, UP, "\x1bg"), press(ESC));
		assert.deepEqual(h.navigated, []);
		assert.equal(required(h.notifications[0]).message, TREE_BUSY_NOTICE);
	});

	it("reports a cancelled or failed move and stays on the screen", async () => {
		const { sm } = seed();
		const h = harness(sm, { confirms: [true, true] });
		h.state.cancelNavigation = true;
		await h.run(press(UP, UP, UP, "\x1bg"), press(ESC));
		assert.match(required(h.notifications[0]).message, /cancelled.*stays where it is/);
		h.ctx.navigateTree = async () => {
			throw new Error("Entry gone not found");
		};
		await h.run(press(UP, UP, UP, "\x1bg"), press(ESC));
		assert.match(
			required(h.notifications[1]).message,
			/Could not move there: Entry gone not found/,
		);
	});

	it("answers g on the current row with a notice instead of moving", async () => {
		const { sm } = seed();
		const h = harness(sm, { confirms: [true] });
		await h.run(press("\x1bg"), press(ESC));
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.navigated, []);
		assert.match(required(h.notifications[0]).message, /already here/);
	});

	it("shows the goal, outcome and stats of a fold with Enter", async () => {
		const { sm } = seed();
		const h = harness(sm);
		await h.run(press(UP, UP, UP, ENTER), press(ESC));
		const [fold] = h.notifications;
		assert.ok(fold);
		assert.match(
			fold.message,
			/^Tokenizer implemented \(folded\)\nGoal: Write the tokenizer\nOutcome: Tokenizer passes all tests\n3 messages/,
		);
		assert.match(fold.message, /archived as 'impl-done': press g on its row/);
	});

	it("shows a user message in full on Enter", async () => {
		const { sm } = seed();
		const h = harness(sm);
		await h.run(press(UP, ENTER), press(ESC));
		assert.equal(required(h.notifications[0]).message, `Your message:\n${LONG}`);
	});

	it("cycles the filter with f and searches every row", async () => {
		const { sm } = seed();
		const h = harness(sm);
		let searched: string[] = [];
		await h.run(press("\x1bf"), press("\x1bf"), press("\x1bf"), (screen) => {
			screen.handleInput("/");
			for (const key of "recov") screen.handleInput(key);
			searched = screen.render(WIDTH);
			screen.handleInput(ESC);
			screen.handleInput(ESC);
		});
		const [all, anchors, users, again] = h.rendered;
		assert.ok(all);
		assert.ok(anchors);
		assert.ok(users);
		assert.ok(again);
		assert.match(textOf(all), /showing all rows/);
		assert.match(textOf(anchors), /showing handoffs and anchors/);
		assert.ok(!textOf(anchors).includes("Set up the parser"));
		assert.match(textOf(anchors), /▣ Tokenizer implemented/);
		assert.match(textOf(users), /showing user turns/);
		assert.ok(!textOf(users).includes("▣"));
		assert.match(textOf(users), /Set up the parser project/);
		assert.match(textOf(users), /● \[current\]/);
		assert.match(textOf(again), /showing all rows/);
		assert.match(textOf(searched), /Please also make/);
		assert.ok(!textOf(searched).includes("◆ impl-start"));
		fits(searched);
	});
});

describe("tree destinations and the current marker", () => {
	/** Fails the test when the host is asked to move before the dialog is answered. */
	const guardConfirm = (h: ReturnType<typeof harness>): void => {
		const confirm = h.ctx.ui.confirm.bind(h.ctx.ui);
		h.ctx.ui.confirm = async (title, message) => {
			assert.deepEqual(h.navigated, [], "navigated before the confirmation");
			return confirm(title, message);
		};
	};

	it("goes before an anchored user message, says so, and drops the anchor from the branch", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		const a1 = sm.appendMessage(assistant("Project created"));
		const u2 = sm.appendMessage(user("Refactor the lexer"));
		sm.appendLabelChange(u2, `${LABEL_PREFIX}lex`);
		const items = treeItems(sm);
		assert.deepEqual(
			items.map(({ kind, targetId, destination, current }) => [
				kind,
				targetId === u2,
				destination,
				current,
			]),
			[
				["user", false, "before", false],
				["user", true, "before", false],
				["anchor", true, "before", true],
			],
		);
		assert.equal(required(items[2]).anchor, "lex");
		assert.equal(items.filter(({ kind }) => kind === "leaf").length, 0);

		const h = harness(sm, { confirms: [true], native: true });
		guardConfirm(h);
		assert.equal(await h.run(press("\x1bg")), "done");
		assert.deepEqual(h.navigated, [u2]);
		const [title, message] = required(h.confirms[0]);
		assert.match(title, /Go to just before the message at anchor 'lex'/);
		assert.match(message, /just before this message/);
		assert.match(message, /text goes back into the editor/);
		assert.match(message, /anchor 'lex'.*no longer be on the active branch/);
		assert.match(message, /Nothing is deleted/);
		assert.equal(sm.getLeafId(), a1);
		assert.equal(treeItems(sm).filter(({ kind }) => kind === "anchor").length, 0);
		assert.match(required(h.notifications[0]).message, /^Moved to just before the message/);
	});

	it("goes before an anchored custom message the same way", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Start"));
		const a1 = sm.appendMessage(assistant("Ready"));
		const note = sm.appendCustomMessageEntry("note", "Remember the key", true);
		sm.appendLabelChange(note, `${LABEL_PREFIX}note`);
		const [, anchor] = treeItems(sm);
		assert.ok(anchor);
		assert.deepEqual(
			[anchor.kind, anchor.targetId, anchor.destination, anchor.current],
			["anchor", note, "before", true],
		);

		const h = harness(sm, { confirms: [true], native: true });
		guardConfirm(h);
		assert.equal(await h.run(press("\x1bg")), "done");
		assert.deepEqual(h.navigated, [note]);
		assert.match(required(required(h.confirms[0])[1]), /just before this message/);
		assert.match(required(required(h.confirms[0])[1]), /anchor 'note'.*no longer/);
		assert.equal(sm.getLeafId(), a1);
	});

	it("marks a custom message leaf as current and leaves it alone, since the host does nothing at the leaf", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Start"));
		const a1 = sm.appendMessage(assistant("Ready"));
		const note = sm.appendCustomMessageEntry("note", "Remember the key", true);
		const items = treeItems(sm);
		assert.deepEqual(
			items.map(({ kind, destination, current }) => [kind, destination, current]),
			[
				["user", "before", false],
				["leaf", "before", true],
			],
		);
		const h = harness(sm, { native: true });
		assert.equal(await h.run(press("\x1bg"), press(ESC)), "back");
		assert.equal(
			required(h.notifications[0]).message,
			"This message is the last entry of the session, so there is nothing to move back from yet. Select another row and press g to go there.",
		);
		assert.deepEqual(h.navigated, []);
		assert.equal(sm.getLeafId(), note);
		assert.notEqual(note, a1);
	});

	it("allows returning to the last assistant when runtime metadata follows it", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		const answer = sm.appendMessage(assistant("Project created"));
		sm.appendThinkingLevelChange("high");
		const h = harness(sm, { confirms: [true], native: true });
		await h.run(press("\x1bg"));
		assert.deepEqual(h.navigated, [answer]);
		assert.equal(sm.getLeafId(), answer);
	});

	it("allows going before the current user message when only metadata follows it", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		const a1 = sm.appendMessage(assistant("Project created"));
		const u2 = sm.appendMessage(user("Refactor the lexer"));
		sm.appendThinkingLevelChange("high");
		const items = treeItems(sm);
		assert.deepEqual(
			items.map(({ targetId, current }) => [targetId === u2, current]),
			[
				[false, false],
				[true, true],
			],
		);
		const h = harness(sm, { confirms: [true], native: true });
		guardConfirm(h);
		assert.equal(await h.run(press("\x1bg")), "done");
		assert.deepEqual(h.navigated, [u2]);
		assert.match(required(required(h.confirms[0])[1]), /just before this message/);
		assert.ok(!required(required(h.confirms[0])[1]).includes("The anchor"));
		assert.equal(sm.getLeafId(), a1);
	});

	it("says there is nothing to move back from when the user message is the leaf itself", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		sm.appendMessage(assistant("Project created"));
		const u2 = sm.appendMessage(user("Refactor the lexer"));
		const h = harness(sm, { confirms: [true], native: true });
		await h.run(press("\x1bg"), press(ESC));
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.navigated, []);
		assert.match(required(h.notifications[0]).message, /last entry of the session/);
		assert.equal(sm.getLeafId(), u2);
	});

	it("marks a compaction leaf as the current position, not the entry before it", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		const a1 = sm.appendMessage(assistant("Project created"));
		sm.appendLabelChange(a1, `${LABEL_PREFIX}setup`);
		const compaction = sm.appendCompaction("Parser set up", a1, 4200);
		const items = treeItems(sm);
		assert.deepEqual(
			items.map(({ kind, targetId, current }) => [kind, targetId, current]),
			[
				["user", required(items[0]).targetId, false],
				["anchor", a1, false],
				["leaf", compaction, true],
			],
		);
		assert.equal(treeRow(required(items[2])).label, "● [current]");
		assert.equal(treeRow(required(items[2])).labelHint, "compaction");

		const h = harness(sm, { confirms: [true], native: true });
		await h.run(press("\x1bg"), press(ESC));
		assert.deepEqual(h.confirms, []);
		assert.deepEqual(h.navigated, []);
		assert.match(required(h.notifications[0]).message, /already here/);
		assert.equal(sm.getLeafId(), compaction);
	});

	it("navigates nothing when going before an anchored message is declined", async () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage(user("Set up the parser project"));
		sm.appendMessage(assistant("Project created"));
		const u2 = sm.appendMessage(user("Refactor the lexer"));
		sm.appendLabelChange(u2, `${LABEL_PREFIX}lex`);
		const leaf = sm.getLeafId();
		const h = harness(sm, { confirms: [false], native: true });
		assert.equal(await h.run(press("\x1bg"), press(ESC)), "back");
		assert.equal(h.confirms.length, 1);
		assert.deepEqual(h.navigated, []);
		assert.equal(sm.getLeafId(), leaf);
	});
});
