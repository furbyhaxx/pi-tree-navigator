/**
 * Tests for `/anchor settings`: staged editing, saving and refusals.
 *
 * Node test runner. Every flow runs against real files in a temp dir, and a
 * write is judged by the bytes on disk.
 */

import { afterAll, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	RECOMMENDED_MILESTONE_POLICY,
	resolveMilestonePolicy,
} from "../../src/auto/milestone-policy.ts";
import { RECOMMENDED_POLICY, resolveIntentPolicy } from "../../src/continuity/intent-policy.ts";
import { loadTreeNavigatorConfig } from "../../src/core/config.ts";
import {
	clearRuntimeConfig,
	readRuntimeConfig,
	writeRuntimeConfig,
} from "../../src/core/runtime-config.ts";
import {
	createSettingsScreenDeps,
	describeSettings,
	openSettingsScreen,
	type SettingsScreenDeps,
} from "../../src/ui/settings-screen.ts";

const ENTER = "\r";
const ESC = "\x1b";
const BACKSPACE = "\x7f";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const FILENAME = "tree-navigator.json";

// Row positions in the screen, top to bottom.
const ROW = {
	hint: 0,
	startAnchor: 1,
	parentMode: 2,
	capture: 3,
	classifier: 4,
	proposalModel: 5,
	proposalTools: 6,
	autoEnabled: 7,
	autoMode: 8,
	milestone: 9,
	checkEvery: 10,
	minTokens: 11,
	rewindAt: 12,
	pressure: 13,
	keepRecentShare: 14,
	autoTools: 15,
	consolidationEnabled: 16,
	consolidationMax: 17,
	consolidationShare: 18,
	consolidationKeep: 19,
	overrides: 20,
} as const;

type Script = (
	screen: { handleInput(data: string): void; render(width: number): string[] },
	lines: string[],
) => void;
const press =
	(...keys: string[]): Script =>
	(screen) => {
		for (const key of keys) screen.handleInput(key);
	};
const down = (n: number): string[] => Array<string>(n).fill(DOWN);
/** Jump to a row from the top, then press the keys there. */
const at = (row: number, ...keys: string[]): Script => press(HOME, ...down(row), ...keys);
const edit = (row: number): Script => at(row, ENTER);

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) {
		clearRuntimeConfig(root);
		rmSync(root, { recursive: true, force: true });
	}
});

interface Setup {
	global?: string;
	project?: string;
	runtime?: Record<string, unknown>;
	trusted?: boolean;
	columns?: number;
	idle?: boolean;
	inputs?: (string | undefined)[];
	selects?: (string | undefined)[];
	saveScopes?: ("global" | "project" | "runtime" | "cancel")[];
	confirms?: boolean[];
	confirmEffects?: ((paths: { globalPath: string; projectPath: string }) => void)[];
	/** How the next model picker leaves: off selects the first row. */
	modelPicks?: ("off" | "custom" | "cancel")[];
	/** Throw if the registry is used for anything but listing models. */
	guardRegistry?: boolean;
	writeFails?: boolean;
	/** Use the screen's own atomic writer instead of the recording one. */
	realWriter?: boolean;
}

function harness(setup: Setup = {}) {
	const root = mkdtempSync(join(tmpdir(), "settings-screen-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	const globalPath = join(agentDir, FILENAME);
	const projectPath = join(cwd, ".pi", FILENAME);
	for (const [path, text] of [
		[globalPath, setup.global],
		[projectPath, setup.project],
	] as const) {
		if (text === undefined) continue;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}

	const sessionId = root;
	if (setup.runtime) writeRuntimeConfig(sessionId, setup.runtime);
	const state = { idle: setup.idle ?? true, reloads: 0, applies: 0 };
	const writes: string[] = [];
	const notifications: { message: string; type?: string }[] = [];
	const dialogs = {
		confirm: [] as [string, string][],
		input: [] as [string, string | undefined][],
		select: [] as [string, string[]][],
	};
	const inputs = [...(setup.inputs ?? [])];
	const selects = [...(setup.selects ?? [])];
	const confirms = [...(setup.confirms ?? [])];
	const confirmEffects = [...(setup.confirmEffects ?? [])];
	const saveScopes = [...(setup.saveScopes ?? [])];
	const modelPicks = [...(setup.modelPicks ?? [])];
	const registryCalls: string[] = [];
	const rendered: string[][] = [];
	const saveScopeFrames: string[][] = [];
	const scripts: Script[] = [];
	let cancelPicker = false;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const columns = setup.columns ?? 80;
	const ctx = {
		hasUI: true,
		cwd,
		isIdle: () => state.idle,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: new Proxy(
			{
				getAvailable() {
					registryCalls.push("getAvailable");
					return [];
				},
				async getAvailableOfType(type: string) {
					registryCalls.push(`getAvailableOfType:${type}`);
					return [];
				},
			},
			{
				get(target, key) {
					if (setup.guardRegistry && typeof key === "string" && !(key in target)) {
						registryCalls.push(key);
						throw new Error(`unexpected registry call: ${key}`);
					}
					return Reflect.get(target, key);
				},
			},
		),
		async reload() {
			state.reloads++;
		},
		ui: {
			notify: (message: string, type?: string) => void notifications.push({ message, type }),
			async confirm(title: string, message: string) {
				dialogs.confirm.push([title, message]);
				confirmEffects.shift()?.({ globalPath, projectPath });
				return confirms.shift() ?? false;
			},
			async input(title: string, placeholder?: string) {
				dialogs.input.push([title, placeholder]);
				const value = inputs.shift();
				if ((title === "Custom model" || title === "Custom classifier") && value === undefined) {
					cancelPicker = true;
				}
				return value;
			},
			async select(title: string, options: string[]) {
				dialogs.select.push([title, options]);
				return selects.shift();
			},
			custom(
				factory: (...args: unknown[]) => {
					handleInput(data: string): void;
					render(width: number): string[];
				},
			) {
				return new Promise((resolve) => {
					const tui = { terminal: { rows: 80, columns }, requestRender() {} };
					const screen = factory(tui, theme, undefined, resolve);
					const lines = screen.render(columns);
					const header = lines[0] ?? "";
					if (header.includes("Anchor/Settings/Save")) {
						saveScopeFrames.push(lines);
						const scope = saveScopes.shift();
						if (scope === "cancel") screen.handleInput(ESC);
						else if (scope) {
							screen.handleInput(scope === "global" ? "u" : scope === "project" ? "p" : "r");
						} else screen.handleInput(ENTER);
						return;
					}
					if (
						header.includes("Anchor/Settings/Classifier") ||
						header.includes("Anchor/Settings/Model")
					) {
						const pick = modelPicks.shift();
						if (pick === "cancel" || cancelPicker) {
							cancelPicker = false;
							screen.handleInput(ESC);
						} else if (pick === "off") {
							screen.handleInput(HOME);
							screen.handleInput(ENTER);
						} else if (pick === "custom") {
							screen.handleInput(HOME);
							for (let step = 0; step < 12; step++) {
								const selected = screen
									.render(columns)
									.find((candidate) => candidate.includes(" → "));
								if (selected?.includes("custom")) break;
								screen.handleInput(DOWN);
							}
							screen.handleInput(ENTER);
						} else {
							screen.handleInput(HOME);
							screen.handleInput(DOWN);
							// The classifier list also offers the recommended policy before custom.
							if (header.includes("Classifier")) screen.handleInput(DOWN);
							screen.handleInput(ENTER);
						}
						return;
					}
					const script = scripts.shift();
					assert.ok(script, "unexpected extra screen");
					rendered.push(lines);
					script(screen, lines);
				});
			},
		},
	} as unknown as ExtensionCommandContext;
	const deps: SettingsScreenDeps = {
		locations: () => ({
			agentDir,
			projectPath,
			projectTrusted: setup.trusted ?? false,
		}),
		async onSaved() {
			state.applies++;
		},
		...(!setup.realWriter && {
			async writeFile(path: string, text: string) {
				writes.push(path);
				if (setup.writeFails) throw new Error("disk is full");
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, text);
			},
		}),
	};
	const read = (path: string) => readFileSync(path, "utf8");
	return {
		ctx,
		deps,
		state,
		sessionId,
		writes,
		notifications,
		dialogs,
		rendered,
		saveScopeFrames,
		registryCalls,
		globalPath,
		projectPath,
		readGlobal: () => read(globalPath),
		readProject: () => read(projectPath),
		readRuntime: () => readRuntimeConfig(sessionId),
		run: (...screens: Script[]) => {
			scripts.push(...screens);
			return openSettingsScreen(ctx, deps);
		},
	};
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const text = (lines: readonly string[]): string => lines.join("\n");
/** The one rendered line that holds this label. */
const line = (lines: readonly string[], label: string): string =>
	lines.find((candidate) => candidate.includes(label)) ?? "";

describe("settings screen: saving", () => {
	it("lists consolidation settings and saves a staged flag while preserving unknown keys", async () => {
		const h = harness({
			global: json({ custom: 7, consolidation: { unknown: "keep" } }),
			confirms: [true],
		});
		const described = await describeSettings(h.ctx, h.deps);
		for (const key of ["enabled", "max_handoffs", "max_window_share", "keep_newest"])
			assert.ok(described.includes(`consolidation.${key}`));
		await h.run(edit(ROW.consolidationEnabled), press("s"), press(ESC));
		assert.equal(
			h.readGlobal(),
			json({ custom: 7, consolidation: { unknown: "keep", enabled: false } }),
		);
	});

	it("edits consolidation counts and fractional share with validation", async () => {
		const h = harness({ inputs: ["6", "0.25", "3"], confirms: [true] });
		await h.run(
			edit(ROW.consolidationMax),
			edit(ROW.consolidationShare),
			edit(ROW.consolidationKeep),
			press("s"),
			press(ESC),
		);
		assert.equal(
			h.readGlobal(),
			json({
				consolidation: {
					max_handoffs: 6,
					max_window_share: 0.25,
					keep_newest: 3,
				},
			}),
		);
	});

	it("writes exactly the two staged keys, keeping unknown keys and snake_case spelling", async () => {
		const original = {
			rewind_hint_reserve_tokens: 50000,
			custom_note: { keep: [1, 2] },
			model_overrides: { "openai/x": { rewind_hint_reserve_tokens: 70000 } },
		};
		const h = harness({
			global: json(original),
			inputs: ["80k", "5"],
			confirms: [true, false],
		});
		const exit = await h.run(edit(ROW.hint), edit(ROW.startAnchor), press("s"), press(ESC));
		assert.equal(exit, "back");
		assert.equal(
			h.readGlobal(),
			json({
				rewind_hint_reserve_tokens: 80000,
				custom_note: { keep: [1, 2] },
				model_overrides: original.model_overrides,
				anchor_start_after_turns: 5,
			}),
		);

		const staged = text(h.rendered[2]);
		assert.match(staged, /rewindHintReserveTokens\s+50k → 80k/);
		assert.match(staged, /anchorStartAfterTurns\s+2 → 5/);
		assert.match(staged, /2 staged · target: global/);

		const [title, message] = h.dialogs.confirm[0];
		assert.equal(title, "Save 2 changes to the global config?");
		assert.ok(message.includes(h.globalPath));
		assert.match(message, /rewindHintReserveTokens: 50k → 80k/);
		assert.match(message, /anchorStartAfterTurns: unset → 5/);

		const saved = text(h.rendered[3]);
		assert.match(saved, /rewindHintReserveTokens\s+80k · global/);
		assert.match(saved, /anchorStartAfterTurns\s+5 · global/);
		assert.ok(!saved.includes("staged"));
		assert.ok(
			h.notifications.some(
				({ message: m, type }) =>
					type === "info" && /Applied to this session\./.test(m) && m.includes(h.globalPath),
			),
		);
		assert.equal(h.dialogs.confirm.length, 1);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.state.applies, 1);
	});

	it("creates a missing project file and directory, and leaves the global file alone", async () => {
		const h = harness({
			trusted: true,
			inputs: ["100k"],
			confirms: [true, false],
		});
		await h.run(press("t"), edit(ROW.hint), press("s"), press(ESC));
		assert.equal(h.readProject(), json({ rewindHintReserveTokens: 100000 }));
		assert.ok(!existsSync(h.globalPath));
		assert.ok(h.dialogs.confirm[0][1].includes(h.projectPath));
		assert.match(text(h.rendered[1]), /target: project/);
		assert.match(text(h.rendered[3]), /rewindHintReserveTokens\s+100k · project/);
	});

	it("saves a runtime override without writing files and takes precedence over project values", async () => {
		const global = json({ anchorStartAfterTurns: 3 });
		const project = json({ anchorStartAfterTurns: 4 });
		const h = harness({
			global,
			project,
			trusted: true,
			inputs: ["7"],
			saveScopes: ["runtime"],
			confirms: [true],
		});
		await h.run(edit(ROW.startAnchor), press("s"), press(ESC));

		assert.equal(h.readGlobal(), global);
		assert.equal(h.readProject(), project);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.readRuntime(), { anchorStartAfterTurns: 7 });
		assert.match(line(h.rendered[2], "anchorStartAfterTurns"), /7 · runtime/);
		const { config } = await loadTreeNavigatorConfig({
			agentDir: dirname(h.globalPath),
			projectPath: h.projectPath,
			projectTrusted: true,
			runtime: h.readRuntime(),
		});
		assert.equal(config.anchorStartAfterTurns, 7);
		assert.equal(h.state.applies, 1);
	});

	it("leaves staged changes untouched when the save-scope chooser is cancelled", async () => {
		const original = json({ rewindHintReserveTokens: 50000 });
		const h = harness({
			global: original,
			inputs: ["80k"],
			saveScopes: ["cancel"],
			confirms: [true],
		});
		await h.run(edit(ROW.hint), press("s"), press(ESC));

		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.equal(h.state.applies, 0);
		assert.equal(h.saveScopeFrames.length, 1);
		assert.deepEqual(
			h.dialogs.confirm.map(([title]) => title),
			["Discard staged changes?"],
		);
	});

	it("keeps the file unchanged when a parent container changes during confirmation", async () => {
		const original = json({
			auto_navigate: { enabled: true, check_every_turns: 6 },
			keep: 1,
		});
		const replaced = json({ auto_navigate: "external replacement", keep: 1 });
		const h = harness({
			global: original,
			inputs: ["8"],
			confirms: [true, true],
			confirmEffects: [({ globalPath }) => writeFileSync(globalPath, replaced)],
		});
		await h.run(edit(ROW.checkEvery), press("s"), press(ESC));

		assert.equal(h.readGlobal(), replaced);
		assert.deepEqual(h.writes, []);
		assert.equal(h.state.applies, 0);
		assert.ok(
			h.notifications.some(
				({ message, type }) =>
					type === "warning" && /auto_navigate.*no longer an object/.test(message),
			),
		);
	});

	it("accepts forgiving numbers and writes the off sentinel as null", async () => {
		const h = harness({
			global: json({ rewindHintReserveTokens: 50000, other: true }),
			inputs: ["OFF", "1 500"],
			confirms: [true, false],
		});
		await h.run(edit(ROW.hint), edit(ROW.minTokens), press("s"), press(ESC));
		assert.equal(
			h.readGlobal(),
			json({
				rewindHintReserveTokens: null,
				other: true,
				auto_navigate: { min_tokens_since_anchor: 1500 },
			}),
		);
	});

	it("converts the auto_navigate boolean shorthand when a sibling key is edited", async () => {
		const h = harness({
			global: json({ auto_navigate: true }),
			confirms: [true, false],
		});
		await h.run(edit(ROW.autoMode), press("s"), press(ESC));
		assert.deepEqual(JSON.parse(h.readGlobal()), {
			auto_navigate: { enabled: true, mode: "anchor-only" },
		});
	});

	it("toggles a global flag from its target value when a project value shadows it", async () => {
		const h = harness({
			global: json({ continuity: { capture: true } }),
			project: json({ continuity: { capture: false } }),
			trusted: true,
			confirms: [true],
		});
		await h.run(at(ROW.capture, ENTER), press("s"), press(ESC));

		assert.deepEqual(JSON.parse(h.readGlobal()), {
			continuity: { capture: false },
		});
		assert.deepEqual(JSON.parse(h.readProject()), {
			continuity: { capture: false },
		});
	});

	it("toggles a flag and cycles a choice without opening an input", async () => {
		const h = harness({ global: json({}), confirms: [true, false] });
		await h.run(edit(ROW.parentMode), edit(ROW.capture), press("s"), press(ESC));
		assert.deepEqual(h.dialogs.input, []);
		assert.deepEqual(JSON.parse(h.readGlobal()), {
			parentHandoffMode: "full",
			continuity: { capture: false },
		});
	});

	it("resets by removing every spelling of the key and prunes a container it empties", async () => {
		const h = harness({
			global: json({
				anchorStartAfterTurns: 4,
				anchor_start_after_turns: 6,
				continuity: { capture: false },
				keep: 1,
			}),
			confirms: [true, false],
		});
		await h.run(at(ROW.startAnchor, "d"), at(ROW.capture, BACKSPACE), press("s"), press(ESC));
		assert.equal(h.readGlobal(), json({ keep: 1 }));
		assert.match(h.dialogs.confirm[0][1], /anchorStartAfterTurns: 6 → removed/);
		assert.match(text(h.rendered[2]), /continuity\.capture\s+false → true/);
	});

	it("warns when a higher layer still overrides what was saved", async () => {
		const h = harness({
			global: json({}),
			project: json({ rewindHintReserveTokens: 90000 }),
			trusted: true,
			inputs: ["80k"],
			confirms: [true, false],
		});
		await h.run(edit(ROW.hint), press("s"), press(ESC));
		assert.match(text(h.rendered[1]), /rewindHintReserveTokens\s+90k · project/);
		assert.ok(
			h.notifications.some(
				({ message, type }) =>
					type === "warning" && message === "Still overridden: rewindHintReserveTokens (project).",
			),
		);
	});

	it("applies saved settings immediately without offering a reload", async () => {
		const h = harness({ global: json({}), inputs: ["3"], confirms: [true] });
		const exit = await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
		assert.equal(exit, "back");
		assert.equal(h.state.applies, 1);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.dialogs.confirm.length, 1);
		assert.ok(h.notifications.some(({ message }) => message.includes("Applied to this session.")));
		assert.ok(h.dialogs.confirm.every(([title]) => !title.includes("Reload")));
	});

	it("applies immediately while the agent is working without offering a reload", async () => {
		const h = harness({
			global: json({}),
			inputs: ["3"],
			confirms: [true],
			idle: false,
		});
		await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
		assert.equal(h.dialogs.confirm.length, 1);
		assert.equal(h.state.reloads, 0);
		assert.equal(h.state.applies, 1);
		assert.ok(h.notifications.some(({ message }) => message.includes("Applied to this session.")));
	});

	it("warns when a runtime value shadows a lower-scope save", async () => {
		const h = harness({
			global: json({}),
			runtime: { rewindHintReserveTokens: 90000 },
			inputs: ["80k"],
			confirms: [true],
		});
		await h.run(edit(ROW.hint), press("s"), press(ESC));

		assert.equal(h.readGlobal(), json({ rewindHintReserveTokens: 80000 }));
		assert.deepEqual(h.readRuntime(), { rewindHintReserveTokens: 90000 });
		assert.match(line(h.rendered[2], "rewindHintReserveTokens"), /90k · runtime/);
		assert.ok(
			h.notifications.some(
				({ message, type }) =>
					type === "warning" && message === "Still overridden: rewindHintReserveTokens (runtime).",
			),
		);
	});

	it("resets a runtime value to reveal the trusted project value", async () => {
		const global = json({ anchorStartAfterTurns: 3 });
		const project = json({ anchorStartAfterTurns: 5 });
		const h = harness({
			global,
			project,
			runtime: { anchorStartAfterTurns: 8 },
			trusted: true,
			confirms: [true],
		});
		await h.run(press("t"), press("t"), at(ROW.startAnchor, "d"), press("s"), press(ESC));

		assert.deepEqual(h.readRuntime(), {});
		assert.equal(h.readGlobal(), global);
		assert.equal(h.readProject(), project);
		assert.match(line(h.rendered[4], "anchorStartAfterTurns"), /5 · project/);
		assert.deepEqual(h.writes, []);
	});

	it("keeps the staged edits and the file when the write fails", async () => {
		const original = json({ keep: 1 });
		const h = harness({
			global: original,
			inputs: ["3"],
			confirms: [true, true],
			writeFails: true,
		});
		await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
		assert.equal(h.readGlobal(), original);
		assert.ok(
			h.notifications.some(
				({ message, type }) =>
					type === "error" && message.includes(h.globalPath) && message.includes("disk is full"),
			),
		);
		assert.match(text(h.rendered[2]), /1 staged/);
		assert.equal(h.dialogs.confirm.at(-1)?.[0], "Discard staged changes?");
	});

	it("steps numeric settings in both directions without crossing their bounds", async () => {
		const h = harness({
			global: json({
				rewindHintReserveTokens: 1000,
				anchorStartAfterTurns: 50,
				auto_navigate: { check_every_turns: 1 },
			}),
			confirms: [true],
		});
		await h.run(
			at(ROW.hint, RIGHT),
			at(ROW.hint, LEFT),
			at(ROW.hint, LEFT),
			at(ROW.startAnchor, RIGHT),
			at(ROW.startAnchor, LEFT),
			at(ROW.checkEvery, LEFT),
			at(ROW.checkEvery, RIGHT),
			press("s"),
			press(ESC),
		);

		assert.match(line(h.rendered[1], "rewindHintReserveTokens"), /1k → 2k/);
		assert.match(line(h.rendered[3], "rewindHintReserveTokens"), /1k → off/);
		assert.deepEqual(JSON.parse(h.readGlobal()), {
			rewindHintReserveTokens: null,
			anchorStartAfterTurns: 49,
			auto_navigate: { check_every_turns: 2 },
		});
		assert.deepEqual(
			h.notifications
				.filter(
					({ message, type }) => type === "warning" && message.startsWith("Limit reached for "),
				)
				.map(({ message }) => message),
			[
				"Limit reached for anchorStartAfterTurns. Use 1-50 turns.",
				"Limit reached for auto_navigate.check_every_turns. Use 1-100 turns.",
			],
		);
	});

	it("edits automatic pressure and its kept-recent share", async () => {
		const h = harness({
			global: json({
				auto_navigate: { pressure: "compact", keep_recent_share: 0.25 },
			}),
			inputs: ["0.3"],
			confirms: [true],
		});
		await h.run(at(ROW.pressure, RIGHT), edit(ROW.keepRecentShare), press("s"), press(ESC));

		assert.deepEqual(JSON.parse(h.readGlobal()), {
			auto_navigate: { pressure: "fold", keep_recent_share: 0.3 },
		});
	});

	it("uses left and right to set flags and cycle choices", async () => {
		const h = harness({
			global: json({
				parentHandoffMode: "full",
				continuity: { capture: true },
				auto_navigate: { enabled: false },
			}),
			confirms: [true],
		});
		await h.run(
			at(ROW.parentMode, RIGHT),
			at(ROW.capture, LEFT),
			at(ROW.autoEnabled, RIGHT),
			press("s"),
			press(ESC),
		);

		assert.deepEqual(JSON.parse(h.readGlobal()), {
			parentHandoffMode: "synthesized",
			continuity: { capture: false },
			auto_navigate: { enabled: true },
		});
	});

	it("writes atomically through a symlink and leaves no temp file behind", async () => {
		const h = harness({
			inputs: ["4"],
			confirms: [true, false],
			realWriter: true,
		});
		const target = join(dirname(h.globalPath), "dotfiles", FILENAME);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, json({ keep: 1 }));
		symlinkSync(target, h.globalPath);
		await h.run(edit(ROW.startAnchor), press("s"), press(ESC));
		assert.ok(lstatSync(h.globalPath).isSymbolicLink());
		assert.equal(readFileSync(target, "utf8"), json({ keep: 1, anchorStartAfterTurns: 4 }));
		assert.deepEqual(
			readdirSync(dirname(target)).filter((file) => file.endsWith(".tmp")),
			[],
		);
	});
});

describe("settings screen: refusals", () => {
	it("refuses invalid ranges and custom model selectors", async () => {
		const h = harness({
			inputs: ["5m", "0", "foo", undefined, "101"],
		});
		await h.run(
			edit(ROW.hint),
			edit(ROW.startAnchor),
			edit(ROW.proposalModel),
			edit(ROW.checkEvery),
			press(ESC),
		);
		const warnings = h.notifications
			.filter(({ type }) => type === "warning")
			.map(({ message }) => message);
		assert.equal(warnings.length, 4);
		assert.match(
			warnings[0],
			/"5m" is not valid for rewindHintReserveTokens\. Use 1,000-1,000,000 tokens/,
		);
		assert.match(warnings[1], /"0".*anchorStartAfterTurns\. Use 1-50 turns/);
		assert.match(
			warnings[2],
			/"foo" is not valid: Proposal model must be current or provider\/model\[:thinking\]/,
		);
		assert.match(
			warnings[3],
			/"101" is not valid for auto_navigate\.check_every_turns\. Use 1-100 turns/,
		);
		assert.ok(!text(h.rendered.at(-1) ?? []).includes("staged"));
		assert.ok(!existsSync(h.globalPath));
	});

	it("shows a valid staged model when a sibling proposal field is invalid", async () => {
		const h = harness({
			global: json({ treeProposal: { model: "current", tools: "invalid" } }),
			inputs: ["offline/model:high"],
			confirms: [true],
		});
		await h.run(edit(ROW.proposalModel), press(ESC));

		assert.match(line(h.rendered[1], "treeProposal.model"), /invalid → offline\/model:high/);
		assert.match(text(h.rendered[1]), /1 staged/);
	});

	it("shows the current value and the valid range in the input prompt", async () => {
		const h = harness({
			global: json({ rewindHintReserveTokens: 50000 }),
			inputs: [undefined],
		});
		await h.run(edit(ROW.hint), press(ESC));
		assert.deepEqual(h.dialogs.input, [
			[
				"rewindHintReserveTokens (global scope)",
				"now 50k · 1,000-1,000,000 tokens (e.g. 50k), or off",
			],
		]);
	});

	it("writes nothing when the user cancels with staged edits", async () => {
		const original = json({ rewindHintReserveTokens: 50000 });
		const h = harness({
			global: original,
			inputs: ["80k"],
			confirms: [false, true],
		});
		const exit = await h.run(edit(ROW.hint), press(ESC), press(ESC));
		assert.equal(exit, "back");
		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.dialogs.confirm, [
			["Discard staged changes?", "1 staged change has not been saved."],
			["Discard staged changes?", "1 staged change has not been saved."],
		]);
		assert.match(text(h.rendered[2]), /50k → 80k/);
	});

	it("writes nothing when the save confirmation is declined", async () => {
		const original = json({ rewindHintReserveTokens: 50000 });
		const h = harness({
			global: original,
			inputs: ["80k"],
			confirms: [false, true],
		});
		await h.run(edit(ROW.hint), press("s"), press(ESC));
		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.match(text(h.rendered[2]), /1 staged/);
	});

	it("closes without a question when nothing is staged", async () => {
		const h = harness({ global: json({}) });
		assert.equal(await h.run(press(ESC)), "back");
		assert.deepEqual(h.dialogs.confirm, []);
	});

	it("never overwrites a file that does not parse, and says which file and why", async () => {
		const broken = '{ "rewindHintReserveTokens": 5000, ';
		const h = harness({
			global: broken,
			project: json({ anchorStartAfterTurns: 3 }),
			trusted: true,
			inputs: ["70k"],
			saveScopes: ["global"],
			confirms: [true],
		});
		await h.run(edit(ROW.hint), press("t"), edit(ROW.hint), press("t"), press("s"), press(ESC));
		assert.equal(readFileSync(h.globalPath, "utf8"), broken);
		assert.deepEqual(h.writes, []);
		const warnings = h.notifications
			.filter(({ type }) => type === "warning")
			.map(({ message }) => message);
		assert.equal(warnings.length, 3);
		for (const message of warnings) {
			assert.ok(message.includes(h.globalPath));
			assert.match(message, /is not valid JSON/);
		}
		assert.match(text(h.rendered[0]), /target: global · file invalid/);
		assert.deepEqual(
			h.dialogs.confirm.map(([title]) => title),
			["Discard staged changes?"],
		);
	});

	it("refuses a config whose root is not an object", async () => {
		const h = harness({ global: "[1, 2]", inputs: ["3"] });
		await h.run(edit(ROW.startAnchor), press(ESC));
		assert.equal(readFileSync(h.globalPath, "utf8"), "[1, 2]");
		assert.match(h.notifications[0].message, /must be a JSON object/);
		assert.deepEqual(h.dialogs.input, []);
	});

	it("cycles global, project and runtime targets", async () => {
		const h = harness({
			global: json({}),
			project: json({}),
			runtime: { anchorStartAfterTurns: 3 },
			trusted: true,
		});
		const targets: string[] = [];
		const atTarget =
			(key?: string): Script =>
			(screen) => {
				targets.push(text(screen.render(80)));
				if (key) screen.handleInput(key);
			};
		await h.run(atTarget("t"), atTarget("t"), atTarget("t"), atTarget(ESC));
		assert.match(targets[0], /target: global/);
		assert.match(targets[1], /target: project/);
		assert.match(targets[2], /target: runtime/);
		assert.match(targets[3], /target: global/);
	});

	it("does not read or edit the project file when the project is not trusted", async () => {
		const project = json({ rewindHintReserveTokens: 1000 });
		const h = harness({ global: json({}), project, trusted: false });
		let afterT: string[] = [];
		await h.run(press("t"), (screen) => {
			afterT = screen.render(80);
			screen.handleInput(ESC);
		});
		assert.equal(readFileSync(h.projectPath, "utf8"), project);
		const first = text(h.rendered[0]);
		assert.match(first, /target: global/);
		assert.match(first, /rewindHintReserveTokens\s+off · default/);
		assert.match(first, /parentHandoffMode\s+digest · default/);
		assert.match(first, /global unset · project untrusted/);
		assert.ok(!first.includes("to project"));
		assert.match(text(afterT), /target: runtime/);
	});
});

describe("settings screen: rows", () => {
	it("shows each effective value with the layer it comes from", async () => {
		const h = harness({
			global: json({
				rewindHintReserveTokens: 50000,
				continuity: { capture: false },
				model_overrides: { "a/b": {}, "c/d": {} },
			}),
			project: json({
				anchorStartAfterTurns: 99,
				parent_handoff_mode: "synthesized",
				treeProposal: { model: "openai/gpt-6:low" },
				auto_navigate: { enabled: true, check_every_turns: 4 },
				modelOverrides: { "a/b": {}, "e/f": {} },
			}),
			trusted: true,
		});
		await h.run(press(ESC));
		const screen = h.rendered[0];
		assert.match(line(screen, "rewindHintReserveTokens"), /50k · global/);
		assert.match(line(screen, "anchorStartAfterTurns"), /2 · default/);
		assert.match(line(screen, "parentHandoffMode"), /synthesized · project/);
		assert.match(line(screen, "continuity.capture"), /false · global/);
		assert.match(line(screen, "continuity.intentClassifier"), /off · default/);
		assert.match(line(screen, "treeProposal.model"), /openai\/gpt-6:low · project/);
		assert.match(line(screen, "auto_navigate.enabled"), /true · project/);
		assert.match(line(screen, "auto_navigate.mode"), /anchor-and-rewind · default/);
		assert.match(line(screen, "auto_navigate.pressure"), /compact · default/);
		assert.match(line(screen, "auto_navigate.keep_recent_share"), /0\.25 · default/);
		assert.match(line(screen, "auto_navigate.milestone"), /recommended · default/);
		assert.match(line(screen, "check_every_turns"), /4 · project/);
		assert.match(line(screen, "rewind_at_tokens"), /120k · default/);
		assert.match(line(screen, "model_overrides"), /3 entries/);
	});

	it("explains an ignored invalid value instead of hiding it", async () => {
		const h = harness({
			global: json({
				anchorStartAfterTurns: 7,
				rewindHintReserveTokens: 50000,
			}),
			project: json({
				anchorStartAfterTurns: 99,
				rewindHintReserveTokens: "lots",
			}),
			trusted: true,
		});
		await h.run(press(ESC));
		const first = h.rendered[0];
		assert.match(line(first, "anchorStartAfterTurns"), /7 · global/);
		assert.match(line(first, "rewindHintReserveTokens"), /off · project/);
		assert.match(line(first, "↳"), /project: invalid value, treated as off/);
	});

	it("stays inside 60 columns and never cuts a description", async () => {
		const h = harness({ global: json({}), columns: 60 });
		const frames: string[][] = [];
		await h.run((screen) => {
			for (let row = 0; row <= ROW.overrides; row++) {
				frames.push(screen.render(60));
				screen.handleInput(DOWN);
			}
			screen.handleInput(ESC);
		});
		assert.equal(frames.length, ROW.overrides + 1);
		for (const frame of frames) {
			for (const rendered of frame) assert.ok(visibleWidth(rendered) <= 60);
			assert.ok(!frame.at(-3)?.endsWith("…"), `cut: ${frame.at(-3)}`);
			assert.ok(frame.at(-4)?.trim(), "description is on two rows at most");
		}
		assert.match(frames[0][0], /Anchor\/Settings/);
		assert.match(frames[0][0], /target: global/);
		assert.match(frames[0][1], /file: /);
	});

	it("describes effective nested map and runtime settings", async () => {
		const h = harness({
			global: json({ treeProposal: { tools: { bash: "calls-only" } } }),
			runtime: {
				rewindHintReserveTokens: 60000,
				auto_navigate: { tools: { grep: "omit" } },
				model_overrides: {
					"openai/gpt-5": { rewind_hint_reserve_tokens: 90000 },
				},
			},
		});
		const description = await describeSettings(h.ctx, h.deps);

		assert.match(description, /rewindHintReserveTokens: 60k \(runtime\)/);
		assert.match(description, /treeProposal\.tools\["bash"\]: calls-only \(global\)/);
		assert.match(description, /auto_navigate\.tools\["grep"\]: omit \(runtime\)/);
		assert.match(
			description,
			/model_overrides\["openai\/gpt-5"\]\.rewindHintReserveTokens: 90k \(runtime\)/,
		);
		assert.match(description, /Runtime: session memory/);
	});

	it("builds the live deps from pi's agent dir and the session's cwd and trust", () => {
		const deps = createSettingsScreenDeps();
		const where = deps.locations({
			cwd: "/work/app",
			isProjectTrusted: () => true,
		} as unknown as ExtensionCommandContext);
		assert.ok(where.agentDir.length > 0);
		assert.equal(where.projectPath, join("/work/app", CONFIG_DIR_NAME, FILENAME));
		assert.equal(where.projectTrusted, true);
	});
});

describe("settings screen: keyed maps", () => {
	const MAPS = {
		rewind_hint_reserve_tokens: 50000,
		tree_proposal: { model: "current", tools: { bash: "calls-only" } },
		model_overrides: {
			"openai/gpt-6": {
				rewind_hint_reserve_tokens: 70000,
				vendor_note: { keep: ["x"] },
			},
			"*gemini*": {
				rewind_hint_reserve_tokens: 120000,
				auto_navigate: { enabled: true },
			},
		},
	};
	// One tool policy edit, then one model pattern edit, ending on the top screen.
	const editBoth: Script[] = [
		edit(ROW.proposalTools),
		edit(0),
		press(ESC),
		edit(ROW.overrides),
		edit(1),
		edit(0),
		press(ESC),
		press(ESC),
	];

	it("leaves the original bytes alone when staged map edits are cancelled", async () => {
		const original = json(MAPS);
		const h = harness({
			global: original,
			selects: ["omit"],
			inputs: ["150k"],
			confirms: [true],
		});
		assert.equal(await h.run(...editBoth, press(ESC)), "back");
		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.dialogs.confirm, [
			["Discard staged changes?", "2 staged changes have not been saved."],
		]);
		const top = h.rendered.at(-1) ?? [];
		assert.match(line(top, "treeProposal.tools"), /1 tool · global · 1 staged/);
		assert.match(line(top, "model_overrides"), /2 entries · global · 1 staged/);
		assert.match(text(top), /2 staged · target: global/);
	});

	it("saves both edits, keeping another model's unknown data and snake_case, and the loader resolves them", async () => {
		const h = harness({
			global: json(MAPS),
			selects: ["omit"],
			inputs: ["150k"],
			confirms: [true, false],
		});
		await h.run(...editBoth, press("s"), press(ESC));

		const expected = structuredClone(MAPS);
		expected.tree_proposal.tools.bash = "omit";
		expected.model_overrides["*gemini*"].rewind_hint_reserve_tokens = 150000;
		assert.equal(h.readGlobal(), json(expected));

		const [, message] = h.dialogs.confirm[0];
		assert.match(message, /treeProposal\.tools\["bash"\]: calls-only → omit/);
		assert.match(message, /model_overrides\["\*gemini\*"\]\.rewindHintReserveTokens: 120k → 150k/);

		const { config } = await loadTreeNavigatorConfig({
			agentDir: dirname(h.globalPath),
			projectPath: h.projectPath,
			projectTrusted: false,
		});
		assert.equal(config.proposal?.tools.bash, "omit");
		assert.equal(config.rewindHintModelReserveTokens.get("*gemini*"), 150000);
		assert.equal(config.rewindHintModelReserveTokens.get("openai/gpt-6"), 70000);
	});

	it("shows inherited tool modes apart from the target file and stages add, change, remove and unstage", async () => {
		const h = harness({
			global: json({
				tree_proposal: { tools: { bash: "omit" } },
				auto_navigate: { tools: { read: "calls-only" } },
			}),
			columns: 120,
			selects: ["full", "omit"],
			inputs: ["grep"],
			confirms: [true, false],
		});
		let detail: string[] = [];
		await h.run(
			edit(ROW.autoTools),
			(screen) => {
				screen.handleInput(DOWN);
				detail = screen.render(120);
				screen.handleInput(ENTER);
			},
			at(0, "d"),
			at(0, "u"),
			press("a"),
			at(0, "d"),
			press(ESC),
			press("s"),
			press(ESC),
		);
		const [, listed, changed, removed, restored, , staged, top] = h.rendered;
		assert.match(line(listed, "read"), /read\s+calls-only · global$/);
		assert.match(line(listed, "bash"), /bash\s+omit · global \(inherited\)$/);
		assert.match(
			line(detail, "↳"),
			/global unset · project untrusted · runtime unset · inherits treeProposal\.tools\["bash"\]/,
		);
		assert.match(line(changed, "bash"), /bash\s+omit → full/);
		assert.match(line(removed, "read"), /read\s+calls-only → full/);
		assert.match(line(restored, "read"), /read\s+calls-only · global$/);
		assert.match(line(staged, "grep"), /grep\s+full → omit/);
		assert.match(line(top, "auto_navigate.tools"), /1 → 2 tools · global · 3 staged/);
		assert.deepEqual(h.dialogs.select[0], [
			'auto_navigate.tools["bash"] (global file)',
			["full", "calls-only", "omit"],
		]);
		assert.deepEqual(JSON.parse(h.readGlobal()), {
			tree_proposal: { tools: { bash: "omit" } },
			auto_navigate: { tools: { bash: "full", grep: "omit" } },
		});
	});

	it("confirms removing a non-empty model entry and stages an explicit delete", async () => {
		const h = harness({
			global: json(MAPS),
			confirms: [false, true, true, false],
		});
		await h.run(
			edit(ROW.overrides),
			at(0, "d"),
			at(0, "d"),
			edit(0),
			press(ESC),
			press("s"),
			press(ESC),
		);
		assert.ok(
			h.notifications.some(({ message }) =>
				message.includes('model_overrides["openai/gpt-6"] is staged for removal'),
			),
		);
		const [title, message] = h.dialogs.confirm[0];
		assert.equal(title, 'Remove model_overrides["openai/gpt-6"]?');
		assert.match(message, /70000/);
		assert.ok(!text(h.rendered[2]).includes("removed"));
		assert.match(line(h.rendered[3], "openai/gpt-6"), /removed · staged/);
		const expected = structuredClone(MAPS) as Partial<typeof MAPS>;
		Reflect.deleteProperty(expected.model_overrides ?? {}, "openai/gpt-6");
		assert.equal(h.readGlobal(), json(expected));
	});

	it("edits nested model settings through the root rules and keeps the camelCase spelling", async () => {
		const h = harness({
			global: json({
				keep: 1,
				modelOverrides: { "a/b": { autoNavigate: { check_every_turns: 4 } } },
			}),
			inputs: ["5m", "8"],
			confirms: [true, false],
		});
		await h.run(
			edit(ROW.overrides),
			edit(0),
			edit(0),
			edit(2),
			edit(4),
			press(ESC),
			press(ESC),
			press("s"),
			press(ESC),
		);
		const entry = h.rendered[2];
		assert.match(line(entry, "check_every_turns"), /4 · global$/);
		assert.match(line(entry, "auto_navigate.mode"), /anchor-and-rewind · default$/);
		const warning = h.notifications.find(({ type }) => type === "warning");
		assert.match(
			warning?.message ?? "",
			/"5m" is not valid for .*rewindHintReserveTokens\. Use 1,000-1,000,000 tokens/,
		);
		assert.equal(
			h.readGlobal(),
			json({
				keep: 1,
				modelOverrides: {
					"a/b": {
						autoNavigate: { check_every_turns: 8, mode: "anchor-only" },
					},
				},
			}),
		);
	});

	it("adds a model pattern with a reserve and a tool policy, and the loader applies them", async () => {
		const h = harness({
			global: json({}),
			inputs: ["bad name", "openrouter/*", "90k", "bash"],
			selects: ["omit"],
			confirms: [true, false],
		});
		await h.run(
			edit(ROW.overrides),
			press("a"),
			press("a"),
			edit(0),
			edit(9),
			press("a"),
			press(ESC),
			press(ESC),
			press(ESC),
			press("s"),
			press(ESC),
		);
		assert.match(
			h.notifications.find(({ type }) => type === "warning")?.message ?? "",
			/"bad name" is not a model pattern/,
		);
		assert.deepEqual(JSON.parse(h.readGlobal()), {
			modelOverrides: {
				"openrouter/*": {
					rewindHintReserveTokens: 90000,
					auto_navigate: { tools: { bash: "omit" } },
				},
			},
		});
		const { config } = await loadTreeNavigatorConfig({
			agentDir: dirname(h.globalPath),
			projectPath: h.projectPath,
			projectTrusted: false,
		});
		assert.equal(config.rewindHintModelReserveTokens.get("openrouter/*"), 90000);
		assert.equal(config.autoNavigateByModel?.get("openrouter/*")?.tools?.bash, "omit");
	});

	it("resets and unstages a whole map from the top screen", async () => {
		const h = harness({
			global: json({ tree_proposal: { tools: { bash: "omit" } } }),
			confirms: [true],
		});
		await h.run(at(ROW.proposalTools, "d"), at(ROW.proposalTools, "u"), press(ESC));
		assert.match(line(h.rendered[1], "treeProposal.tools"), /1 → none · default · 1 staged/);
		assert.match(line(h.rendered[2], "treeProposal.tools"), /1 tool · global$/);
		assert.equal(h.dialogs.confirm.length, 1);
	});

	it("shows a map that is not an object as invalid and refuses to replace it silently", async () => {
		const original = json({ tree_proposal: { tools: "oops" } });
		const h = harness({
			global: original,
			inputs: ["bash"],
			selects: ["omit"],
			confirms: [true, true],
		});
		let top: string[] = [];
		await h.run(
			(screen) => {
				press(HOME, ...down(ROW.proposalTools))(screen, []);
				top = screen.render(80);
				screen.handleInput(ENTER);
			},
			press("a"),
			press(ESC),
			press("d"),
			press(ESC),
		);
		assert.match(line(top, "↳"), /global: treeProposal\.tools must map exact tool names/);
		assert.match(
			h.notifications.find(({ type }) => type === "warning")?.message ?? "",
			/tree_proposal\.tools in the global file is not an object/,
		);
		assert.match(line(h.rendered[4], "treeProposal.tools"), /1 staged/);
		assert.equal(h.readGlobal(), original);
	});

	it("lists an invalid tool mode as invalid and replaces it only when the user picks a mode", async () => {
		const h = harness({
			global: json({ tree_proposal: { tools: { bash: "banana" } } }),
			selects: ["omit"],
			confirms: [true],
		});
		await h.run(edit(ROW.proposalTools), edit(0), press(ESC), press(ESC));
		assert.match(line(h.rendered[1], "bash"), /bash\s+invalid/);
		assert.match(line(h.rendered[1], "↳"), /Invalid treeProposal\.tools\["bash"\]/);
		assert.match(line(h.rendered[2], "bash"), /bash\s+invalid → omit/);
	});
});

/** Move to the row whose selected line contains `label`, then press `key`. */
const until =
	(label: string, key = ENTER): Script =>
	(screen) => {
		screen.handleInput(HOME);
		for (let step = 0; step < 24; step++) {
			const selected = screen.render(120).find((candidate) => candidate.includes(" → "));
			if (selected?.includes(label)) break;
			screen.handleInput(DOWN);
		}
		screen.handleInput(key);
	};

describe("settings screen: classifier policies", () => {
	it("disables intent escalation in the editor and saves runtime only", async () => {
		const original = json({
			continuity: { intentClassifier: "recommended" },
		});
		const h = harness({
			global: original,
			modelPicks: ["off"],
			saveScopes: ["runtime"],
			confirms: [true],
			guardRegistry: true,
			columns: 120,
		});
		await h.run(
			edit(ROW.classifier),
			until("escalation model"),
			press("a"),
			(screen, lines) => {
				assert.doesNotMatch(line(lines, "continuity.intentClassifier"), /\{/);
				assert.match(line(lines, "continuity.intentClassifier"), /escalation off/);
				screen.handleInput("s");
			},
			press(ESC),
		);

		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.readRuntime(), {
			continuity: {
				intentClassifier: {
					preset: "recommended",
					supersession: { escalation: { model: null } },
				},
			},
		});
		assert.ok(h.registryCalls.length > 0);
		assert.ok(h.registryCalls.every((call) => call.startsWith("getAvailable")));
		const { config } = await loadTreeNavigatorConfig({
			agentDir: dirname(h.globalPath),
			projectPath: h.projectPath,
			projectTrusted: false,
			runtime: h.readRuntime(),
		});
		const policy = resolveIntentPolicy(config.continuity.intentClassifier ?? "");
		assert.equal(policy?.escalation.model, null);
		assert.equal(policy?.kind.model, RECOMMENDED_POLICY.classifier);
		assert.equal(policy?.supersession.model, policy?.kind.model);
		const [, message] = h.dialogs.confirm[0] ?? [];
		assert.doesNotMatch(message ?? "", /\{/);
		assert.match(message ?? "", /escalation off/);
	});

	it("changes the escalation model from the editor and saves runtime only", async () => {
		const original = json({
			continuity: { intentClassifier: "recommended" },
		});
		const h = harness({
			global: original,
			inputs: ["acme/judge"],
			modelPicks: ["custom"],
			saveScopes: ["runtime"],
			confirms: [true],
			guardRegistry: true,
			columns: 120,
		});
		await h.run(
			edit(ROW.classifier),
			until("escalation model"),
			press("a"),
			press("s"),
			press(ESC),
		);

		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.readRuntime(), {
			continuity: {
				intentClassifier: {
					preset: "recommended",
					supersession: { escalation: { model: "acme/judge" } },
				},
			},
		});
		assert.ok(h.registryCalls.every((call) => call.startsWith("getAvailable")));
		const { config } = await loadTreeNavigatorConfig({
			agentDir: dirname(h.globalPath),
			projectPath: h.projectPath,
			projectTrusted: false,
			runtime: h.readRuntime(),
		});
		const policy = resolveIntentPolicy(config.continuity.intentClassifier ?? "");
		assert.equal(policy?.escalation.model, "acme/judge");
		assert.equal(policy?.kind.model, RECOMMENDED_POLICY.classifier);
		assert.equal(JSON.stringify(h.readRuntime()).includes("verification"), false);
	});

	it("discards a policy draft when the editor is cancelled", async () => {
		const original = json({
			continuity: { intentClassifier: "recommended" },
		});
		const h = harness({ global: original, inputs: ["0.4"], columns: 120 });
		await h.run(edit(ROW.classifier), until("gate"), press(ESC), press(ESC));
		assert.equal(h.readGlobal(), original);
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.readRuntime(), {});
		assert.deepEqual(h.dialogs.confirm, []);
		assert.ok(!text(h.rendered.at(-1) ?? []).includes("staged"));
	});

	it("refuses an invalid milestone confidence without staging", async () => {
		const h = harness({ inputs: ["0"], columns: 120 });
		await h.run(edit(ROW.milestone), until("gate"), press(ESC), press(ESC));
		assert.match(
			h.notifications.find(({ type }) => type === "warning")?.message ?? "",
			/minConfidence must be a number above 0 up to 1/,
		);
		assert.ok(!existsSync(h.globalPath));
		assert.deepEqual(h.writes, []);
		assert.deepEqual(h.dialogs.confirm, []);
	});

	it("keeps unspecified milestone stages under a wildcard override", async () => {
		const h = harness({
			global: json({
				model_overrides: {
					"openrouter/*": { auto_navigate: { enabled: true } },
				},
			}),
			inputs: ["0.85", "acme/judge"],
			modelPicks: ["custom"],
			confirms: [true],
			columns: 120,
			guardRegistry: true,
		});
		await h.run(
			edit(ROW.overrides),
			edit(0),
			until("auto_navigate.milestone"),
			until("gate"),
			until("classifier model"),
			press("a"),
			press(ESC),
			press(ESC),
			press("s"),
			press(ESC),
		);

		const saved = JSON.parse(h.readGlobal()) as {
			model_overrides: {
				"openrouter/*": {
					auto_navigate: { enabled: boolean; milestone: unknown };
				};
			};
		};
		const milestone = saved.model_overrides["openrouter/*"].auto_navigate.milestone;
		assert.deepEqual(milestone, {
			preset: "recommended",
			minConfidence: 0.85,
			classifier: { model: "acme/judge" },
		});
		const policy = resolveMilestonePolicy(JSON.stringify(milestone));
		assert.equal(policy?.minConfidence, 0.85);
		assert.equal(policy?.classifier, "acme/judge");
		assert.equal(policy?.confirmer, RECOMMENDED_MILESTONE_POLICY.confirmer);
		assert.equal(policy?.instructions.status, undefined);
		assert.ok(h.registryCalls.every((call) => call.startsWith("getAvailable")));
	});
});
