import { afterEach, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Ledger } from "../../src/continuity/continuity-ledger-model.ts";
import { applyOps, createLedger } from "../../src/continuity/continuity-ledger-reducer.ts";
import { CLONE_USAGE } from "../../src/retrospective/retrospective-command.ts";
import {
	type AnchorCommandDeps,
	type AnchorRow,
	registerAnchorCommand,
} from "../../src/ui/anchor-command.ts";

function required<T>(value: T | undefined): T {
	assert.ok(value !== undefined, "expected a value");
	return value;
}

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";

const ANCHORS: AnchorRow[] = [
	{
		name: "start",
		percent: 4.1,
		tokens: 15_200,
		savableTokens: 99_300,
		afterPreview: "Analyze our pi-tree-navigator",
		auto: true,
	},
	{
		name: "context-gathered",
		percent: 22.7,
		tokens: 84_400,
		savableTokens: 30_100,
	},
];

async function sessionFile() {
	const directory = await mkdtemp(join(tmpdir(), "anchor-command-"));
	directories.push(directory);
	const timestamp = "2026-01-01T00:00:00.000Z";
	const path = join(directory, "session.jsonl");
	const entries = [
		{ type: "session", version: 3, id: "original", cwd: directory, timestamp },
		{
			type: "session_info",
			id: "name",
			parentId: null,
			timestamp,
			name: "Original",
		},
		{
			type: "message",
			id: "one",
			parentId: "name",
			timestamp,
			message: { role: "user", content: "Question", timestamp: 1 },
		},
	];
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { directory, path };
}

type Registered = Parameters<ExtensionAPI["registerCommand"]>[1];
interface Screen {
	handleInput(data: string): void;
}
type Script = (screen: Screen, lines: string[]) => void;

interface Options {
	hasUI?: boolean;
	width?: number;
	screens?: Script[];
	inputs?: (string | undefined)[];
	cwd?: string;
	sessionFile?: string;
	anchors?: AnchorRow[];
	ledger?: Ledger;
	setAnchorResult?: { ok: true } | { ok: false; reason: string };
}

function setup(options: Options = {}) {
	const commands: { name: string; options: Registered }[] = [];
	const calls = {
		folds: [] as string[],
		plans: [] as (string | undefined)[],
		headlessFolds: [] as string[],
		anchors: [] as string[],
		trees: 0,
		listed: 0,
	};
	const deps: AnchorCommandDeps = {
		settings: {
			locations: () => ({
				agentDir: "/__anchor_test_missing__",
				projectPath: "/__anchor_test_missing__/project.json",
				projectTrusted: false,
			}),
			readFile: async () => {
				throw Object.assign(new Error("not found"), { code: "ENOENT" });
			},
		},
		suggestLabel: (_ctx, anchor) => `${anchor.name}-done`,
		minSavingsTokens: 4000,
		minFocusLength: 20,
		listAnchors() {
			calls.listed++;
			return options.anchors ?? ANCHORS;
		},
		setAnchor(_ctx, name) {
			calls.anchors.push(name);
			return options.setAnchorResult ?? { ok: true };
		},
		requestFold(_ctx, anchorName) {
			calls.folds.push(anchorName);
		},
		openFoldPlan(ctx, preselect) {
			calls.plans.push(preselect);
			return (ctx.ui.custom as (...args: unknown[]) => Promise<"back" | "done">)(
				(...args: unknown[]) => {
					const done = args[3] as (value: "back" | "done") => void;
					return {
						render: () => ["Anchor/Fold"],
						handleInput(data: string) {
							if (data === ESC || data === ENTER) done("back");
						},
					};
				},
			);
		},
		async foldWithoutUi(ctx, args) {
			calls.headlessFolds.push(args);
			ctx.ui.notify(`headless fold: ${args}`, "info");
		},
		contextBadge: () => "ctx 38.4% of 372k",
		readLedger: () => options.ledger,
		applyUserOps: () => ({ applied: [], rejected: [] }),
	};
	const pi = {
		registerCommand(name: string, commandOptions: Registered) {
			commands.push({ name, options: commandOptions });
		},
	} as unknown as ExtensionAPI;
	registerAnchorCommand(pi, deps);

	const width = options.width ?? 80;
	const screens = [...(options.screens ?? [])];
	const rendered: string[][] = [];
	const notifications: { message: string; type: string | undefined }[] = [];
	const editors: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const ctx = {
		cwd: options.cwd ?? tmpdir(),
		hasUI: options.hasUI ?? true,
		isIdle: () => true,
		sessionManager: Object.assign(SessionManager.inMemory(options.cwd ?? tmpdir()), {
			getSessionFile: () => options.sessionFile,
		}),
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async editor(title: string) {
				editors.push(title);
				return undefined;
			},
			async confirm() {
				return false;
			},
			async input() {
				return (options.inputs ?? []).shift();
			},
			custom(
				factory: (
					tui: unknown,
					theme: unknown,
					keyboard: unknown,
					done: (result: unknown) => void,
				) => Screen & { render(width: number): string[] },
			) {
				const script = screens.shift();
				assert.ok(script, "unexpected extra screen");
				return new Promise((resolve) => {
					const tui = {
						terminal: { rows: 40, columns: width },
						requestRender() {},
					};
					const screen = factory(tui, theme, undefined, resolve);
					const lines = screen.render(width);
					rendered.push(lines);
					script(screen, lines);
				});
			},
		},
	} as unknown as ExtensionCommandContext;

	const command = required(commands[0]).options;
	return {
		commands,
		command,
		ctx,
		calls,
		rendered,
		notifications,
		editors,
		run: (args: string) => command.handler(args, ctx),
		remainingScreens: () => screens.length,
	};
}

const press =
	(...keys: string[]): Script =>
	(screen) => {
		for (const key of keys) screen.handleInput(key);
	};

describe("/anchor registration and completion", () => {
	it("registers only the anchor command, with the argument shape first", () => {
		const { commands } = setup();
		assert.deepEqual(
			commands.map((command) => command.name),
			["anchor"],
		);
		assert.match(
			required(commands[0]).options.description ?? "",
			/^\[tree\|list\|current\|fold\|clone\|settings\] — /,
		);
	});

	it("completes subcommands fuzzily and keeps earlier tokens when chaining", async () => {
		const { command } = setup();
		const complete = async (text: string) =>
			(await command.getArgumentCompletions?.(text))?.map((item) => item.value) ?? null;

		assert.deepEqual(await complete(""), [
			"tree ",
			"list ",
			"current ",
			"fold ",
			"clone ",
			"settings ",
		]);
		assert.equal((await complete("cl"))?.[0], "clone ");
		assert.deepEqual(await complete("stg"), ["settings "]);
		assert.equal((await complete("ls"))?.[0], "list ");
		assert.equal(await complete("zzzz"), null);

		assert.deepEqual(await complete("clone "), [
			"clone inspect ",
			"clone propose ",
			"clone preview ",
			"clone create ",
		]);
		assert.equal((await complete("clone pre"))?.[0], "clone preview ");
		assert.deepEqual(await complete("restructure pro"), ["restructure propose "]);
		assert.equal(await complete("clone inspect "), null);
		assert.equal(await complete("list "), null);

		assert.deepEqual(await complete("clone propose x.jsonl --f"), [
			"clone propose x.jsonl --full-tool ",
		]);
		assert.deepEqual(await complete("clone propose --"), [
			"clone propose --llm ",
			"clone propose --model ",
			"clone propose --output ",
			"clone propose --omit-tool ",
			"clone propose --calls-only-tool ",
			"clone propose --full-tool ",
		]);
	});
});

describe("/anchor dispatch", () => {
	it("resolves aliases, singular and plural forms", async () => {
		const expectations: [string, RegExp][] = [
			["list", /Active anchors/],
			["ls", /Active anchors/],
			["anchors", /Active anchors/],
			["LISTS", /Active anchors/],
			["tree", /0 folds · 0 anchors/],
			["outline", /0 folds · 0 anchors/],
			["phases", /0 folds · 0 anchors/],
			["current", /No continuity items yet/],
			["briefing", /No continuity items yet/],
			["ledger", /No continuity items yet/],
			["state", /No continuity items yet/],
			["fold", /^headless fold: $/],
			["rewind", /^headless fold: $/],
			["settings", /Anchor settings/],
			["setting", /Anchor settings/],
			["config", /Anchor settings/],
			["set", /Anchor settings/],
			["clone", /^Usage: \/anchor clone \[/],
			["restructure", /^Usage: \/anchor clone \[/],
			["clones", /^Usage: \/anchor clone \[/],
		];
		for (const [token, expected] of expectations) {
			const test = setup({ hasUI: false });
			await test.run(token);
			assert.match(test.notifications.at(-1)?.message ?? "", expected, token);
			assert.notEqual(test.notifications.at(-1)?.type, "warning", token);
		}
	});

	it("suggests the closest subcommand within edit distance 2 and prints usage", async () => {
		for (const [typo, suggestion] of [
			["lst", "list"],
			["setings", "settings"],
			["clon", "clone"],
			["foldd", "fold"],
			["curent", "current"],
		]) {
			const test = setup({ hasUI: false });
			assert.ok(typo !== undefined);
			await test.run(typo);
			const last = test.notifications.at(-1);
			assert.equal(last?.type, "warning");
			assert.ok(
				last?.message.includes(`Did you mean '/anchor ${suggestion}'?`),
				`${typo}: ${last?.message}`,
			);
			assert.ok(last?.message.includes("Usage: /anchor"));
		}

		const far = setup({ hasUI: false });
		await far.run("zzzzzzzz");
		assert.ok(!required(far.notifications[0]).message.includes("Did you mean"));
		assert.ok(required(far.notifications[0]).message.includes("Usage: /anchor"));
	});

	it("prints usage without UI, naming clone and --full-tool", async () => {
		const test = setup({ hasUI: false });
		await test.run("");
		await test.run("   ");
		assert.equal(test.notifications.length, 2);
		for (const { message } of test.notifications) {
			assert.ok(message.startsWith("Usage: /anchor [tree|list"));
			assert.ok(message.includes(CLONE_USAGE));
			assert.ok(message.includes("--full-tool"));
		}
		assert.equal(test.rendered.length, 0);
	});

	it("runs /anchor clone inspect <path> with the former clone-command semantics", async () => {
		const files = await sessionFile();
		const headless = setup({ hasUI: false, cwd: files.directory });
		await headless.run('clone inspect "session.jsonl"');
		assert.match(required(headless.notifications[0]).message, /Inspected "Original"/);
		assert.match(
			required(headless.notifications[0]).message,
			/Rerun \/anchor clone inspect <session\.jsonl>/,
		);
		assert.equal(headless.editors.length, 0);

		const ui = setup({ cwd: files.directory, screens: [press(ESC)] });
		await ui.run("restructure inspect session.jsonl");
		assert.deepEqual(ui.editors, []);
		assert.equal(ui.rendered.length, 1);
		assert.match(required(ui.rendered[0]).join("\n"), /Session\s+Original/);
		assert.match(required(ui.notifications[0]).message, /1 user turns/);
	});

	it("refuses options after inspect/preview paths instead of reading them as the filename", async () => {
		const files = await sessionFile();
		for (const args of [
			"clone inspect session.jsonl --llm",
			"clone preview plan.json --model openai/gpt-6-luna",
		]) {
			const test = setup({ hasUI: false, cwd: files.directory });
			await test.run(args);
			const last = test.notifications.at(-1);
			assert.equal(last?.type, "warning", args);
			assert.match(last?.message ?? "", /takes no options \(got "--/, args);
			assert.doesNotMatch(last?.message ?? "", /ENOENT/, args);
		}

		const quoted = setup({ hasUI: false, cwd: files.directory });
		await quoted.run('clone inspect "session.jsonl"');
		assert.match(required(quoted.notifications[0]).message, /Inspected "Original"/);
	});
});

const ledgerWithRules = (): Ledger =>
	applyOps(
		createLedger(),
		[
			{ op: "add", kind: "rule", text: "Always answer in German" },
			{ op: "add", kind: "rule", text: "Never edit the lockfile" },
		],
		{ origin: "user" },
	).ledger;

describe("/anchor screens", () => {
	for (const width of [60, 130]) {
		it(`opens the hub at ${width} columns, shows every stub and closes on escape`, async () => {
			const test = setup({ width, screens: [press(ESC)] });
			await test.run("");
			const lines = required(test.rendered[0]);
			for (const line of lines)
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)}: ${line}`);
			const text = lines.join("\n");
			for (const label of [
				"Session tree & phases",
				"Active anchors",
				"Current briefing & cont",
				"Fold current work now…",
				"Retrospective clone & r",
				"Settings",
			]) {
				assert.ok(text.includes(label), label);
			}
			assert.ok(required(lines[0]).includes("ctx 38.4% of 372k"));
			assert.ok(required(lines[0]).startsWith("─ Anchor "));
			assert.ok(!text.includes("not available yet"));
			assert.ok(text.includes("Current briefing"));
			assert.equal(test.remainingScreens(), 0);
		});
	}

	it("opens current, fold and settings from the hub and returns on Escape", async () => {
		const test = setup({
			ledger: createLedger(),
			screens: [
				press(DOWN, DOWN, ENTER),
				press(ESC),
				press(DOWN, ENTER),
				press(ESC),
				press(DOWN, DOWN, ENTER),
				press(ESC),
				press(ESC),
			],
		});
		await test.run("");
		assert.deepEqual(test.notifications, []);
		assert.ok(required(required(test.rendered[1])[0]).includes("Anchor/Current"));
		assert.ok(required(required(test.rendered[3])[0]).includes("Anchor/Fold"));
		assert.ok(required(required(test.rendered[5])[0]).includes("Anchor/Settings"));
		assert.equal(test.rendered.length, 7);
	});

	it("opens the tree from the hub and returns on Escape", async () => {
		const test = setup({ screens: [press(ENTER), press(ESC), press(ESC)] });
		await test.run("");
		assert.ok(required(required(test.rendered[1])[0]).includes("Anchor/Tree"));
		assert.equal(test.remainingScreens(), 0);
		assert.equal(test.notifications.length, 0);
		const treeRow = required(test.rendered[0]).find((line) =>
			line.includes("Session tree & phases"),
		);
		assert.ok(!treeRow?.includes("not available yet"));
	});

	it("lists anchors with savings and opens the fold plan for the chosen anchor with r", async () => {
		const test = setup({ screens: [press(DOWN, "\x1br"), press(ESC), press(ESC)] });
		await test.run("list");
		const text = required(test.rendered[0]).join("\n");
		assert.ok(text.includes("◆ start (auto)"));
		assert.ok(text.includes("4.1% · 15.2k · −99.3k savable"));
		assert.ok(text.includes("22.7% · 84.4k · −30.1k savable"));
		assert.ok(text.includes("+ Set new anchor at current leaf…"));
		assert.ok(text.includes("↳ after: “Analyze our pi-tree-navigator”"));
		assert.ok(required(required(test.rendered[0])[0]).includes("2 anchors · ctx 38.4% of 372k"));
		assert.deepEqual(test.calls.folds, []);
		assert.deepEqual(test.calls.plans, ["context-gathered"]);
		assert.ok(required(required(test.rendered[1])[0]).includes("Anchor/Fold"));
		assert.equal(test.remainingScreens(), 0);
	});

	it("explains in the list, the full line and the headless list why a pre-compaction anchor cannot be folded", async () => {
		const note = "Before compaction: folding would restore compacted history.";
		const anchors: AnchorRow[] = [
			{
				name: "planned",
				percent: 48.1,
				tokens: 179_000,
				savableTokens: 0,
				beforeCompaction: true,
			},
			{ ...required(ANCHORS[1]), beforeCompaction: true },
		];
		const test = setup({
			width: 60,
			anchors,
			screens: [press(ENTER), press(ESC)],
		});
		await test.run("list");
		for (const line of required(test.rendered[0])) assert.ok(visibleWidth(line) <= 60, line);
		assert.ok(required(test.rendered[0]).join("\n").includes("Before compaction: folding"));
		assert.equal(
			required(test.notifications[0]).message,
			`Anchor 'planned': 48.1% of the window (179.0k tok). ${note}`,
		);
		const headless = setup({ hasUI: false, anchors });
		await headless.run("list");
		const lines = required(headless.notifications[0]).message.split("\n");
		assert.match(required(lines[1]), /planned .* −0 savable {2}\(before compaction\)$/);
		assert.ok(!required(lines[2]).includes("before compaction"));
	});

	it("ignores r on the new-anchor row", async () => {
		const test = setup({ screens: [press(DOWN, DOWN, "\x1br", ESC)] });
		await test.run("list");
		assert.deepEqual(test.calls.folds, []);
		assert.deepEqual(test.calls.plans, []);
		assert.equal(test.notifications.length, 0);
		assert.equal(test.rendered.length, 1);
	});

	it("shows the full anchor line on enter and stays in the list", async () => {
		const test = setup({ screens: [press(ENTER), press(ESC)] });
		await test.run("list");
		assert.equal(
			required(test.notifications[0]).message,
			"Anchor 'start' after “Analyze our pi-tree-navigator”: 4.1% of the window (15.2k tok); folding to it would free about 99.3k tok.",
		);
		assert.deepEqual(test.calls.folds, []);
	});

	it("validates new anchor names and refuses duplicates before touching the session", async () => {
		const test = setup({
			inputs: ["Bad Name", "start", "", "fresh-name"],
			screens: [press(DOWN, DOWN, ENTER), press(ENTER), press(ENTER), press(ENTER), press(ESC)],
		});
		await test.run("list");
		assert.deepEqual(
			test.notifications.map(({ type }) => type),
			["warning", "warning", "info"],
		);
		assert.match(required(test.notifications[0]).message, /^Invalid anchor name "Bad Name"/);
		assert.match(
			required(test.notifications[1]).message,
			/^An anchor named 'start' already exists/,
		);
		assert.match(
			required(test.notifications[2]).message,
			/^Anchor 'fresh-name' set at the current leaf/,
		);
		assert.deepEqual(test.calls.anchors, ["fresh-name"]);
	});

	it("reports a refused setAnchor", async () => {
		const test = setup({
			inputs: ["new-one"],
			setAnchorResult: { ok: false, reason: "No session entries yet." },
			screens: [press(DOWN, DOWN, ENTER), press(ESC)],
		});
		await test.run("list");
		assert.deepEqual(test.notifications, [{ message: "No session entries yet.", type: "warning" }]);
	});

	it("shows the live ledger line in the hub and opens the current screen from it", async () => {
		const test = setup({
			ledger: ledgerWithRules(),
			screens: [press(DOWN, DOWN, ENTER), press(ESC), press(ESC)],
		});
		await test.run("");
		const row = required(test.rendered[0]).find((line) => line.includes("Current briefing & cont"));
		assert.ok(row?.includes("2 rules · rev 1"), row ?? "");
		assert.ok(!row?.includes("not available yet"));
		assert.ok(required(required(test.rendered[1])[0]).startsWith("─ Anchor/Current "));
		assert.ok(required(required(test.rendered[1])[0]).includes("rev 1 · 2 rules"));
		assert.ok(required(test.rendered[1]).join("\n").includes("R1 Always answer in German"));
		assert.equal(test.rendered.length, 3);
		assert.equal(test.notifications.length, 0);
	});

	it("opens /anchor current and its aliases straight into the screen", async () => {
		for (const token of ["current", "briefing", "ledger", "state"]) {
			const test = setup({ ledger: ledgerWithRules(), screens: [press(ESC)] });
			await test.run(token);
			assert.equal(test.rendered.length, 1, token);
			assert.ok(required(required(test.rendered[0])[0]).includes("Current"), token);
		}
	});

	it("prints the briefing for /anchor current without a UI, or says the ledger is empty", async () => {
		const filled = setup({ hasUI: false, ledger: ledgerWithRules() });
		await filled.run("current");
		assert.equal(required(filled.notifications[0]).type, "info");
		assert.match(
			required(filled.notifications[0]).message,
			/^\[navigate_tree continuity ledger rev 1\]\n\nBinding rules:\nR1 Always answer in German/,
		);

		const empty = setup({ hasUI: false, ledger: createLedger() });
		await empty.run("ledger");
		assert.deepEqual(empty.notifications, [{ message: "No continuity items yet.", type: "info" }]);
	});

	it("offers inspect, propose, preview and create without arguments and runs the chosen flow", async () => {
		const files = await sessionFile();
		const test = setup({
			cwd: files.directory,
			sessionFile: files.path,
			screens: [press(ENTER), press(ESC), press(ESC)],
		});
		await test.run("clone");
		const text = required(test.rendered[0]).join("\n");
		for (const label of [
			"Inspect a session",
			"Propose a tree plan",
			"Preview a plan",
			"Create a clone from a plan",
		]) {
			assert.ok(text.includes(label), label);
		}
		assert.deepEqual(test.editors, []);
		assert.match(required(test.rendered[1]).join("\n"), /Session\s+Original/);
		assert.equal(test.rendered.length, 3);
	});

	it("prompts for a plan path from the clone menu like the old command", async () => {
		const test = setup({
			inputs: [undefined],
			screens: [press(DOWN, DOWN, ENTER), press(ESC)],
		});
		await test.run("clone");
		assert.match(
			test.notifications.at(-1)?.message ?? "",
			/No plan path provided\. Usage: \/anchor clone/,
		);
	});
});
