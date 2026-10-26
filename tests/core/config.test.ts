/**
 * Tests for the two-layer tree-navigator.json config loader.
 *
 * Node test runner. Run with: pnpm test
 *
 * The pi extension loader treats `./index.ts` as the entry point and ignores
 * sibling files — so this test file is not loaded as a separate extension.
 * The loader's `readFile` is injected, so these tests touch no real fs and
 * pin the layer/merge/warning matrix without a session.
 *
 * Fields with deliberately different failure semantics:
 *   - `rewindHintReserveTokens`: field-level invalid disables the hint for the
 *     session with NO cross-layer fallback.
 *   - `anchorStartAfterTurns`, `parentHandoffMode` and the `continuity` keys:
 *     invalid values warn and fall through to the other layer's valid value,
 *     else their defaults.
 *
 * The removed `rewindHintAtPercent` key (0.3.0) only warns: it never
 * enables, disables, or invalidates the hint.
 */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	CONSOLIDATION_DEFAULTS,
	CONTINUITY_CAPTURE_DEFAULT,
	type HintField,
	loadTreeNavigatorConfig,
	mergeTreeNavigatorConfig,
	type ParentHandoffModeField,
	type ParsedLayer,
	parseTreeNavigatorConfig,
	REWIND_HINT_MAX_RESERVE,
	REWIND_HINT_MIN_RESERVE,
	resolveRewindHintReserve,
	START_ANCHOR_DEFAULT_TURNS,
	START_ANCHOR_MAX_TURNS,
	START_ANCHOR_MIN_TURNS,
	type StartAnchorField,
	TREE_NAVIGATOR_CONFIG_FILENAME,
} from "../../src/core/config.ts";
import {
	clearRuntimeConfig,
	readRuntimeConfig,
	writeRuntimeConfig,
} from "../../src/core/runtime-config.ts";
import type { HandoffMode } from "../../src/fold/handoff.ts";

const AGENT_DIR = "/agent";
const GLOBAL_PATH = `/agent/${TREE_NAVIGATOR_CONFIG_FILENAME}`;
const PROJECT_PATH = `/project/.pi/${TREE_NAVIGATOR_CONFIG_FILENAME}`;

// Byte-exact warning copy. Interpolating the same constants the source
// interpolates keeps the pins honest if a range is ever re-tuned.
const WARN_COULD_NOT_READ_GLOBAL = `navigate_tree: could not read global config at ${GLOBAL_PATH} — that layer was ignored.`;
const WARN_COULD_NOT_READ_PROJECT = `navigate_tree: could not read project config at ${PROJECT_PATH} — that layer was ignored.`;
const WARN_INVALID_JSON_GLOBAL = `navigate_tree: invalid JSON in global config at ${GLOBAL_PATH} — that layer was ignored.`;
const WARN_INVALID_JSON_PROJECT = `navigate_tree: invalid JSON in project config at ${PROJECT_PATH} — that layer was ignored.`;
const WARN_NOT_OBJECT_GLOBAL = `navigate_tree: global config at ${GLOBAL_PATH} must be a JSON object — that layer was ignored.`;
const WARN_NOT_OBJECT_PROJECT = `navigate_tree: project config at ${PROJECT_PATH} must be a JSON object — that layer was ignored.`;
const WARN_INVALID_HINT_GLOBAL = `navigate_tree: invalid rewindHintReserveTokens in global config at ${GLOBAL_PATH} — expected integer ${REWIND_HINT_MIN_RESERVE}-${REWIND_HINT_MAX_RESERVE} or a disable sentinel (null, false, "off", "disabled"); rewind hint disabled for this session.`;
const warnLegacyPercent = (layerName: string, path: string) =>
	`navigate_tree: rewindHintAtPercent in ${layerName} config at ${path} was removed in 0.3.0 and is ignored — use rewindHintReserveTokens (tokens left in the window when the hint fires, e.g. 50000).`;
const WARN_INVALID_HINT_PROJECT = `navigate_tree: invalid rewindHintReserveTokens in project config at ${PROJECT_PATH} — expected integer ${REWIND_HINT_MIN_RESERVE}-${REWIND_HINT_MAX_RESERVE} or a disable sentinel (null, false, "off", "disabled"); rewind hint disabled for this session.`;
const WARN_INVALID_START_GLOBAL = `navigate_tree: invalid anchorStartAfterTurns in global config at ${GLOBAL_PATH} — expected integer ${START_ANCHOR_MIN_TURNS}-${START_ANCHOR_MAX_TURNS}; falling back to the other layer's valid value, else the default ${START_ANCHOR_DEFAULT_TURNS}.`;
const WARN_INVALID_START_PROJECT = `navigate_tree: invalid anchorStartAfterTurns in project config at ${PROJECT_PATH} — expected integer ${START_ANCHOR_MIN_TURNS}-${START_ANCHOR_MAX_TURNS}; falling back to the other layer's valid value, else the default ${START_ANCHOR_DEFAULT_TURNS}.`;
const WARN_INVALID_HANDOFF_GLOBAL = `navigate_tree: invalid parentHandoffMode in global config at ${GLOBAL_PATH} — expected "full", "synthesized" or "digest"; falling back to the other layer's valid value, else the default "digest".`;
const WARN_INVALID_HANDOFF_PROJECT = `navigate_tree: invalid parentHandoffMode in project config at ${PROJECT_PATH} — expected "full", "synthesized" or "digest"; falling back to the other layer's valid value, else the default "digest".`;

/** In-memory `readFile` double: returns `files[path]` or throws ENOENT. */
function readerFor(files: Record<string, string>): {
	readFile: (path: string) => Promise<string>;
	paths: string[];
} {
	const paths: string[] = [];
	return {
		paths,
		async readFile(path: string) {
			paths.push(path);
			if (path in files) return files[path];
			const err = new Error(
				`ENOENT: no such file or directory, open '${path}'`,
			) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		},
	};
}

/** A `readFile` that throws a fixed errno for every path. */
function throwingReader(code: string): (path: string) => Promise<string> {
	return async (path: string) => {
		const err = new Error(`${code}: cannot open '${path}'`) as NodeJS.ErrnoException;
		err.code = code;
		throw err;
	};
}

function configJson(rewindHintReserveTokens: unknown): string {
	return JSON.stringify({ rewindHintReserveTokens });
}

function configJsonStart(anchorStartAfterTurns: unknown): string {
	return JSON.stringify({ anchorStartAfterTurns });
}

/** Build a `ParsedLayer` with the fields the test cares about. */
function layer(partial: {
	hint?: HintField;
	startAnchor?: StartAnchorField;
	parentHandoffMode?: ParentHandoffModeField;
	modelHints?: Array<[string, HintField]>;
}): ParsedLayer {
	return {
		hint: partial.hint ?? { kind: "absent" },
		startAnchor: partial.startAnchor ?? { kind: "absent" },
		parentHandoffMode: partial.parentHandoffMode ?? { kind: "absent" },
		modelHints: new Map(partial.modelHints ?? []),
		modelOverridesProblems: {
			notObject: false,
			nonObjectEntries: [],
		},
	};
}

const DEFAULT_CONTINUITY = {
	capture: CONTINUITY_CAPTURE_DEFAULT,
	intentClassifier: null as string | null,
};

/** The loader's expected config object (start defaults unless overridden). */
function cfg(
	hint: number | null,
	start = START_ANCHOR_DEFAULT_TURNS,
	byModel: Array<[string, number | null]> = [],
	parentHandoffMode: HandoffMode = "digest",
	continuity = DEFAULT_CONTINUITY,
) {
	return {
		rewindHintReserveTokens: hint,
		rewindHintModelReserveTokens: new Map(byModel),
		anchorStartAfterTurns: start,
		parentHandoffMode,
		consolidation: { ...CONSOLIDATION_DEFAULTS },
		continuity,
	};
}

const DEEPSEEK = "opencode-go/deepseek-v4.1-flash";
const HAIKU = "claude-bridge/claude-haiku-5-5";

function warnInvalidModelHint(which: "global" | "project", path: string, key: string): string {
	return `navigate_tree: invalid modelOverrides[${JSON.stringify(key)}].rewindHintReserveTokens in ${which} config at ${path} — expected integer ${REWIND_HINT_MIN_RESERVE}-${REWIND_HINT_MAX_RESERVE} or a disable sentinel (null, false, "off", "disabled"); rewind hint disabled for that model.`;
}

/** Parse a root expected to be an object and return its parsed layer. */
function parsedLayer(raw: unknown): ParsedLayer {
	const parsed = parseTreeNavigatorConfig(raw);
	assert.equal(parsed.kind, "fields");
	if (parsed.kind !== "fields") throw new Error("unreachable");
	return parsed.layer;
}

describe("parseTreeNavigatorConfig", () => {
	describe("rewindHintReserveTokens: accepts integer reserves (number and string forms)", () => {
		const accepted: Array<[string, unknown, number]> = [
			["number", 50000, 50000],
			["numeric string", "50000", 50000],
			["trimmed numeric string", " 50000 ", 50000],
			["min edge number", REWIND_HINT_MIN_RESERVE, REWIND_HINT_MIN_RESERVE],
			["max edge number", REWIND_HINT_MAX_RESERVE, REWIND_HINT_MAX_RESERVE],
			["min edge string", `${REWIND_HINT_MIN_RESERVE}`, REWIND_HINT_MIN_RESERVE],
			["max edge string", `${REWIND_HINT_MAX_RESERVE}`, REWIND_HINT_MAX_RESERVE],
		];
		for (const [label, raw, want] of accepted) {
			it(label, () => {
				assert.deepEqual(parsedLayer({ rewindHintReserveTokens: raw }).hint, {
					kind: "ok",
					value: want,
				});
			});
		}
	});

	describe("rewindHintReserveTokens: treats explicit-disable sentinels as disabled", () => {
		const disabling: unknown[] = [
			null,
			false,
			"off",
			"OFF",
			" Off ",
			"disabled",
			"DISABLED",
			"Disabled",
		];
		for (const raw of disabling) {
			it(JSON.stringify(raw), () => {
				assert.deepEqual(parsedLayer({ rewindHintReserveTokens: raw }).hint, {
					kind: "disabled",
				});
			});
		}
	});

	describe("rewindHintReserveTokens: rejects unusable field values as invalid", () => {
		const invalid: Array<[string, unknown]> = [
			["one below min", REWIND_HINT_MIN_RESERVE - 1],
			["one above max", REWIND_HINT_MAX_RESERVE + 1],
			["zero", 0],
			["negative", -1],
			["decimal", 50000.5],
			["decimal string", "50000.5"],
			["non-numeric string", "ninety"],
			["empty string", ""],
			["whitespace string", "   "],
			["boolean true", true],
			["object", {}],
			["array", []],
			["NaN number", Number.NaN],
			["NaN string", "NaN"],
			["negative string", "-1"],
			["plus-signed string", "+50000"],
			["decimal-zero string", "1000.0"],
			["exponent string", "1e3"],
			["plus-signed min string", "+1000"],
			["string below min", "999"],
			["string above max", "1000001"],
		];
		for (const [label, raw] of invalid) {
			it(label, () => {
				assert.deepEqual(parsedLayer({ rewindHintReserveTokens: raw }).hint, {
					kind: "invalid",
				});
			});
		}
	});

	describe("anchorStartAfterTurns: accepts integer turn bounds (number and string forms)", () => {
		const accepted: Array<[string, unknown, number]> = [
			["default", 2, 2],
			["numeric string", "2", 2],
			["trimmed numeric string", " 2 ", 2],
			["min edge number", START_ANCHOR_MIN_TURNS, START_ANCHOR_MIN_TURNS],
			["max edge number", START_ANCHOR_MAX_TURNS, START_ANCHOR_MAX_TURNS],
			["min edge string", `${START_ANCHOR_MIN_TURNS}`, START_ANCHOR_MIN_TURNS],
			["max edge string", `${START_ANCHOR_MAX_TURNS}`, START_ANCHOR_MAX_TURNS],
			["leading zeroes", "02", 2],
		];
		for (const [label, raw, want] of accepted) {
			it(label, () => {
				assert.deepEqual(parsedLayer({ anchorStartAfterTurns: raw }).startAnchor, {
					kind: "ok",
					value: want,
				});
			});
		}
	});

	describe("anchorStartAfterTurns: rejects unusable field values as invalid", () => {
		const invalid: Array<[string, unknown]> = [
			["zero (no turn 0)", 0],
			["one above max", START_ANCHOR_MAX_TURNS + 1],
			["negative", -1],
			["decimal", 2.5],
			["decimal string", "2.5"],
			["non-numeric string", "two"],
			["empty string", ""],
			["whitespace string", "   "],
			["boolean true", true],
			["boolean false (no disable sentinel)", false],
			["null (no disable sentinel)", null],
			["off string (no disable sentinel)", "off"],
			["disabled string (no sentinel)", "disabled"],
			["object", {}],
			["array", []],
			["NaN number", Number.NaN],
			["NaN string", "NaN"],
			["negative string", "-1"],
			["plus-signed string", "+2"],
			["string above max", `${START_ANCHOR_MAX_TURNS + 1}`],
		];
		for (const [label, raw] of invalid) {
			it(label, () => {
				assert.deepEqual(parsedLayer({ anchorStartAfterTurns: raw }).startAnchor, {
					kind: "invalid",
				});
			});
		}
	});

	describe("parentHandoffMode: accepts exactly the three supported modes", () => {
		const accepted: Array<[HandoffMode, HandoffMode]> = [
			["full", "full"],
			["synthesized", "synthesized"],
			["digest", "digest"],
		];
		for (const [raw, want] of accepted) {
			it(raw, () => {
				assert.deepEqual(parsedLayer({ parentHandoffMode: raw }).parentHandoffMode, {
					kind: "ok",
					value: want,
				});
			});
		}
	});

	describe("parentHandoffMode: rejects values other than the exact supported modes", () => {
		const invalid: unknown[] = ["FULL", " Synthesized ", "", "other", 1, false, null, {}, []];
		for (const raw of invalid) {
			it(JSON.stringify(raw), () => {
				assert.deepEqual(parsedLayer({ parentHandoffMode: raw }).parentHandoffMode, {
					kind: "invalid",
				});
			});
		}
	});

	it("parses each field independently (invalid hint leaves start valid)", () => {
		const parsed = parsedLayer({
			rewindHintReserveTokens: true,
			anchorStartAfterTurns: 5,
		});
		assert.deepEqual(parsed.hint, { kind: "invalid" });
		assert.deepEqual(parsed.startAnchor, { kind: "ok", value: 5 });
	});

	it("parses each field independently (invalid start leaves hint valid)", () => {
		const parsed = parsedLayer({
			rewindHintReserveTokens: 50000,
			anchorStartAfterTurns: "two",
		});
		assert.deepEqual(parsed.hint, { kind: "ok", value: 50000 });
		assert.deepEqual(parsed.startAnchor, { kind: "invalid" });
	});

	it("returns absent for each missing key", () => {
		assert.deepEqual(parsedLayer({}), layer({}));
		assert.deepEqual(parsedLayer({ other: 1 }), layer({}));
		// A present hint key leaves start absent (absent ≠ invalid).
		assert.deepEqual(parsedLayer({ rewindHintReserveTokens: 50000 }).startAnchor, {
			kind: "absent",
		});
		assert.deepEqual(parsedLayer({ anchorStartAfterTurns: 4 }).hint, {
			kind: "absent",
		});
	});

	it("ignores the removed rewindHintAtPercent key (the loader warns)", () => {
		for (const raw of ["90", 90, null, "off", true]) {
			assert.deepEqual(parsedLayer({ rewindHintAtPercent: raw }), layer({}));
		}
	});

	it("returns unusable for a non-object root (file-level failure)", () => {
		for (const root of [null, [], 42, "x", true, undefined]) {
			assert.deepEqual(parseTreeNavigatorConfig(root), { kind: "unusable" });
		}
	});
});

describe("mergeTreeNavigatorConfig", () => {
	describe("hint field (issue #44 semantics preserved)", () => {
		const okGlobal: HintField = { kind: "ok", value: 50000 };
		const okProject: HintField = { kind: "ok", value: 30000 };
		const cases: Array<{
			name: string;
			global: HintField;
			project: HintField;
			want: HintField;
		}> = [
			{
				name: "absent + absent stays absent",
				global: { kind: "absent" },
				project: { kind: "absent" },
				want: { kind: "absent" },
			},
			{
				name: "project absent → global applies",
				global: okGlobal,
				project: { kind: "absent" },
				want: okGlobal,
			},
			{
				name: "global absent → project applies",
				global: { kind: "absent" },
				project: okProject,
				want: okProject,
			},
			{
				name: "project value wins over global value",
				global: okGlobal,
				project: okProject,
				want: okProject,
			},
			{
				name: "project disabled sentinel wins",
				global: okGlobal,
				project: { kind: "disabled" },
				want: { kind: "disabled" },
			},
			{
				name: "global disabled wins when project is absent",
				global: { kind: "disabled" },
				project: { kind: "absent" },
				want: { kind: "disabled" },
			},
			{
				name: "project invalid wins (no cross-layer fallback)",
				global: okGlobal,
				project: { kind: "invalid" },
				want: { kind: "invalid" },
			},
			{
				name: "global invalid is overridden by a valid project value",
				global: { kind: "invalid" },
				project: okProject,
				want: okProject,
			},
		];
		for (const c of cases) {
			it(c.name, () => {
				assert.deepEqual(
					mergeTreeNavigatorConfig(layer({ hint: c.global }), layer({ hint: c.project })).hint,
					c.want,
				);
			});
		}
	});

	describe("start-anchor field (issue #55: invalid falls through)", () => {
		const okGlobal: StartAnchorField = { kind: "ok", value: 5 };
		const okProject: StartAnchorField = { kind: "ok", value: 3 };
		const cases: Array<{
			name: string;
			global: StartAnchorField;
			project: StartAnchorField;
			want: StartAnchorField;
		}> = [
			{
				name: "absent + absent stays absent (resolves to default)",
				global: { kind: "absent" },
				project: { kind: "absent" },
				want: { kind: "absent" },
			},
			{
				name: "project absent → global applies",
				global: okGlobal,
				project: { kind: "absent" },
				want: okGlobal,
			},
			{
				name: "global absent → project applies",
				global: { kind: "absent" },
				project: okProject,
				want: okProject,
			},
			{
				name: "project value wins over global value",
				global: okGlobal,
				project: okProject,
				want: okProject,
			},
			{
				name: "project invalid + valid global → global applies",
				global: okGlobal,
				project: { kind: "invalid" },
				want: okGlobal,
			},
			{
				name: "project invalid + absent global → invalid (resolves to default)",
				global: { kind: "absent" },
				project: { kind: "invalid" },
				want: { kind: "invalid" },
			},
			{
				name: "project invalid + invalid global → invalid (resolves to default)",
				global: { kind: "invalid" },
				project: { kind: "invalid" },
				want: { kind: "invalid" },
			},
			{
				name: "project ok overrides an invalid global",
				global: { kind: "invalid" },
				project: okProject,
				want: okProject,
			},
			{
				name: "project absent + invalid global → invalid (resolves to default)",
				global: { kind: "invalid" },
				project: { kind: "absent" },
				want: { kind: "invalid" },
			},
		];
		for (const c of cases) {
			it(c.name, () => {
				assert.deepEqual(
					mergeTreeNavigatorConfig(
						layer({ startAnchor: c.global }),
						layer({ startAnchor: c.project }),
					).startAnchor,
					c.want,
				);
			});
		}
	});

	describe("parent-handoff mode field (invalid falls through)", () => {
		const okGlobal: ParentHandoffModeField = {
			kind: "ok",
			value: "full",
		};
		const okProject: ParentHandoffModeField = {
			kind: "ok",
			value: "synthesized",
		};
		const cases: Array<{
			name: string;
			global: ParentHandoffModeField;
			project: ParentHandoffModeField;
			want: ParentHandoffModeField;
		}> = [
			{
				name: "absent + absent stays absent",
				global: { kind: "absent" },
				project: { kind: "absent" },
				want: { kind: "absent" },
			},
			{
				name: "project absent → global applies",
				global: okGlobal,
				project: { kind: "absent" },
				want: okGlobal,
			},
			{
				name: "project mode wins over global mode",
				global: okGlobal,
				project: okProject,
				want: okProject,
			},
			{
				name: "project invalid + valid global → global applies",
				global: okGlobal,
				project: { kind: "invalid" },
				want: okGlobal,
			},
			{
				name: "project invalid + absent global → invalid (resolves to default)",
				global: { kind: "absent" },
				project: { kind: "invalid" },
				want: { kind: "invalid" },
			},
			{
				name: "global invalid + valid project → project applies",
				global: { kind: "invalid" },
				project: okProject,
				want: okProject,
			},
		];
		for (const c of cases) {
			it(c.name, () => {
				assert.deepEqual(
					mergeTreeNavigatorConfig(
						layer({ parentHandoffMode: c.global }),
						layer({ parentHandoffMode: c.project }),
					).parentHandoffMode,
					c.want,
				);
			});
		}
	});

	it("merges the two fields independently", () => {
		const merged = mergeTreeNavigatorConfig(
			layer({
				hint: { kind: "ok", value: 50000 },
				startAnchor: { kind: "ok", value: 5 },
			}),
			layer({ hint: { kind: "invalid" } }),
		);
		assert.deepEqual(merged.hint, { kind: "invalid" });
		assert.deepEqual(merged.startAnchor, { kind: "ok", value: 5 });
	});
});

describe("consolidation config", () => {
	const load = (global: unknown = {}, project: unknown = {}, runtime?: Record<string, unknown>) =>
		loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: readerFor({
				[GLOBAL_PATH]: JSON.stringify(global),
				[PROJECT_PATH]: JSON.stringify(project),
			}).readFile,
			runtime,
		});

	it("defaults when absent and merges partial layers per key", async () => {
		assert.deepEqual((await load()).config.consolidation, CONSOLIDATION_DEFAULTS);
		const out = await load(
			{ consolidation: { enabled: false } },
			{ consolidation: { keep_newest: 3 } },
		);
		assert.deepEqual(out.config.consolidation, {
			...CONSOLIDATION_DEFAULTS,
			enabled: false,
			keepNewest: 3,
		});
		assert.deepEqual(out.warnings, []);
	});

	it("accepts camelCase aliases and runtime overrides without dropping lower keys", async () => {
		const out = await load(
			{
				consolidation: {
					enabled: false,
					maxHandoffs: 6,
					maxWindowShare: 0.2,
					keepNewest: 3,
				},
			},
			{ consolidation: { max_handoffs: 5, maxHandoffs: 9 } },
			{ consolidation: { keepNewest: 4 } },
		);
		assert.deepEqual(out.config.consolidation, {
			enabled: false,
			maxHandoffs: 5,
			maxWindowShare: 0.2,
			keepNewest: 4,
		});
		assert.deepEqual(out.warnings, []);
	});

	it("warns per invalid field and falls back to valid lower values or defaults", async () => {
		const out = await load(
			{ consolidation: { max_window_share: 0.3 } },
			{
				consolidation: {
					enabled: "yes",
					max_handoffs: 0,
					max_window_share: 2,
					keep_newest: 21,
				},
			},
			{ consolidation: { max_window_share: 0 } },
		);
		assert.deepEqual(out.config.consolidation, {
			...CONSOLIDATION_DEFAULTS,
			maxWindowShare: 0.3,
		});
		assert.equal(out.warnings.length, 5);
		for (const key of ["enabled", "max_handoffs", "max_window_share", "keep_newest"])
			assert.ok(out.warnings.some((warning) => warning.includes(`invalid consolidation.${key}`)));
		assert.ok(out.warnings[4].includes("runtime config"));
	});

	for (const block of [null, [], false, 3, "on"]) {
		it(`ignores non-object block ${JSON.stringify(block)}`, async () => {
			const out = await load({ consolidation: { enabled: false } }, { consolidation: block });
			assert.equal(out.config.consolidation.enabled, false);
			assert.equal(out.warnings.length, 1);
			assert.match(out.warnings[0], /consolidation .*must be an object — ignored/);
		});
	}
});

describe("loadTreeNavigatorConfig", () => {
	it("reads both layers and lets a trusted project override global per field", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({
				rewindHintReserveTokens: "50000",
				anchorStartAfterTurns: 5,
				parentHandoffMode: "full",
			}),
			[PROJECT_PATH]: JSON.stringify({
				rewindHintReserveTokens: 30000,
				anchorStartAfterTurns: 3,
				parentHandoffMode: "synthesized",
			}),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(30000, 3, [], "synthesized"),
			warnings: [],
		});
		assert.deepEqual(reader.paths, [GLOBAL_PATH, PROJECT_PATH]);
	});

	it("never reads the project layer when the project is untrusted", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({
				rewindHintReserveTokens: "50000",
				anchorStartAfterTurns: 5,
				parentHandoffMode: "synthesized",
			}),
			[PROJECT_PATH]: JSON.stringify({
				rewindHintReserveTokens: 30000,
				anchorStartAfterTurns: 3,
				parentHandoffMode: "full",
			}),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(50000, 5, [], "synthesized"),
			warnings: [],
		});
		assert.deepEqual(reader.paths, [GLOBAL_PATH]);
	});

	it("defaults to full parent handoff mode when both files are missing", async () => {
		const reader = readerFor({});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		// The start anchor defaults to 2, the handoff mode to full, and the hint stays off.
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS),
			warnings: [],
		});
	});

	it("is silent when the file exists but neither field is present", async () => {
		const reader = readerFor({ [GLOBAL_PATH]: JSON.stringify({ other: 1 }) });
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS),
			warnings: [],
		});
	});

	it("warns on the removed rewindHintAtPercent key and leaves the hint off", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({ rewindHintAtPercent: "90" }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [warnLegacyPercent("global", GLOBAL_PATH)],
		});
	});

	it("warns on a legacy project key while the global reserve still applies", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({ rewindHintReserveTokens: 50000 }),
			[PROJECT_PATH]: JSON.stringify({ rewindHintAtPercent: 80 }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(50000),
			warnings: [warnLegacyPercent("project", PROJECT_PATH)],
		});
	});

	it("trims and accepts numeric-string values through the loader", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({
				rewindHintReserveTokens: " 50000 ",
				anchorStartAfterTurns: " 4 ",
			}),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, { config: cfg(50000, 4), warnings: [] });
	});

	it("warns on a non-ENOENT read error and ignores that layer (EACCES)", async () => {
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: throwingReader("EACCES"),
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [WARN_COULD_NOT_READ_GLOBAL, WARN_COULD_NOT_READ_PROJECT],
		});
	});

	it("warns on EISDIR and still applies the other layer", async () => {
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: readerFor({ [PROJECT_PATH]: configJson("63000") }).readFile,
		});
		// Global read hits the injected ENOENT (silent), project applies.
		assert.deepEqual(out, { config: cfg(63000), warnings: [] });

		const dirReader = throwingReader("EISDIR");
		const dirOut = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: dirReader,
		});
		assert.deepEqual(dirOut, {
			config: cfg(null),
			warnings: [WARN_COULD_NOT_READ_GLOBAL],
		});
	});

	it("warns on malformed, empty, and whitespace-only JSON", async () => {
		for (const raw of ["{ not json", "", "   \n  "]) {
			const reader = readerFor({ [GLOBAL_PATH]: raw });
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: false,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(null),
				warnings: [WARN_INVALID_JSON_GLOBAL],
			});
		}
	});

	it("warns when the root is not a JSON object", async () => {
		for (const raw of ["[]", "42", "null", '"x"']) {
			const reader = readerFor({ [GLOBAL_PATH]: raw });
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: false,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(null),
				warnings: [WARN_NOT_OBJECT_GLOBAL],
			});
		}
	});

	it("warns once on an invalid hint value and disables the hint (no fallback)", async () => {
		const reader = readerFor({ [GLOBAL_PATH]: configJson(true) });
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [WARN_INVALID_HINT_GLOBAL],
		});
	});

	it("an invalid project hint disables despite a valid global (no fallback)", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: configJson(50000),
			[PROJECT_PATH]: configJson({ nope: true }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [WARN_INVALID_HINT_PROJECT],
		});
	});

	it("a project hint disable sentinel overrides a valid global", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: configJson(50000),
			[PROJECT_PATH]: configJson(null),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, { config: cfg(null), warnings: [] });
	});

	it("an invalid project start value falls through to a valid global (issue #55)", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: configJsonStart(5),
			[PROJECT_PATH]: configJsonStart("abc"),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, 5),
			warnings: [WARN_INVALID_START_PROJECT],
		});
	});

	it("an invalid global start value falls through to a valid project (issue #55)", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: configJsonStart(51),
			[PROJECT_PATH]: configJsonStart("3"),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, 3),
			warnings: [WARN_INVALID_START_GLOBAL],
		});
	});

	it("an invalid start value with no valid layer warns and uses the default", async () => {
		const reader = readerFor({ [GLOBAL_PATH]: configJsonStart(true) });
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS),
			warnings: [WARN_INVALID_START_GLOBAL],
		});
	});

	it("an invalid trusted project handoff mode warns and falls back to global", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({ parentHandoffMode: "synthesized" }),
			[PROJECT_PATH]: JSON.stringify({ parentHandoffMode: "invalid" }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS, [], "synthesized"),
			warnings: [WARN_INVALID_HANDOFF_PROJECT],
		});
	});

	it("an invalid global handoff mode falls through to a valid trusted project", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({ parentHandoffMode: true }),
			[PROJECT_PATH]: JSON.stringify({ parentHandoffMode: "synthesized" }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS, [], "synthesized"),
			warnings: [WARN_INVALID_HANDOFF_GLOBAL],
		});
	});

	it("an invalid handoff mode with no valid layer warns and defaults to digest", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({ parentHandoffMode: "FULL" }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null, START_ANCHOR_DEFAULT_TURNS, [], "digest"),
			warnings: [WARN_INVALID_HANDOFF_GLOBAL],
		});
	});

	it("both fields invalid in one layer emit one scoped warning each", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({
				rewindHintReserveTokens: true,
				anchorStartAfterTurns: "lots",
			}),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [WARN_INVALID_HINT_GLOBAL, WARN_INVALID_START_GLOBAL],
		});
	});

	it("a file-level failure warns once and suppresses per-field warnings", async () => {
		const reader = readerFor({ [GLOBAL_PATH]: "{ not json" });
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [WARN_INVALID_JSON_GLOBAL],
		});
	});

	it("orders warnings global-then-project across fields", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: JSON.stringify({
				rewindHintReserveTokens: "nope",
				anchorStartAfterTurns: "nope",
			}),
			[PROJECT_PATH]: JSON.stringify({
				rewindHintReserveTokens: { bad: true },
				anchorStartAfterTurns: [],
			}),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out.warnings, [
			WARN_INVALID_HINT_GLOBAL,
			WARN_INVALID_START_GLOBAL,
			WARN_INVALID_HINT_PROJECT,
			WARN_INVALID_START_PROJECT,
		]);
		assert.equal(out.config.rewindHintReserveTokens, null);
		assert.equal(out.config.anchorStartAfterTurns, START_ANCHOR_DEFAULT_TURNS);
	});

	it("a malformed project file warns but a valid global still applies", async () => {
		for (const raw of ["{ not json", "[]"]) {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					rewindHintReserveTokens: 50000,
					anchorStartAfterTurns: 5,
				}),
				[PROJECT_PATH]: raw,
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: true,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(50000, 5),
				warnings: [raw === "[]" ? WARN_NOT_OBJECT_PROJECT : WARN_INVALID_JSON_PROJECT],
			});
		}
	});

	it("a malformed project file is silent when the project is untrusted", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: configJson(50000),
			[PROJECT_PATH]: "{ not json",
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: reader.readFile,
		});
		assert.deepEqual(out, { config: cfg(50000), warnings: [] });
		assert.deepEqual(reader.paths, [GLOBAL_PATH]);
	});

	it("emits the file-level warning then the surviving field warning (per layer)", async () => {
		const reader = readerFor({
			[GLOBAL_PATH]: "{ not json",
			[PROJECT_PATH]: configJson("nope"),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: true,
			readFile: reader.readFile,
		});
		assert.deepEqual(out.warnings, [WARN_INVALID_JSON_GLOBAL, WARN_INVALID_HINT_PROJECT]);
		assert.equal(out.config.rewindHintReserveTokens, null);
		assert.equal(out.config.anchorStartAfterTurns, START_ANCHOR_DEFAULT_TURNS);
	});

	it("uses the real default readFile when none is injected (ENOENT on a fresh temp dir)", async () => {
		// Hermetic-by-absence: point agentDir at a path that cannot exist and
		// assert the default fs reader surfaces ENOENT as a silent absent layer.
		const out = await loadTreeNavigatorConfig({
			agentDir: "/nonexistent-navigate-tree-test-agent-dir",
			projectPath: "/nonexistent-navigate-tree-test-project/.pi/tree-navigator.json",
			projectTrusted: false,
		});
		assert.deepEqual(out, {
			config: cfg(null),
			warnings: [],
		});
	});
});

describe("modelOverrides (#86)", () => {
	describe("parse", () => {
		it("parses per-model reserves with the base field's rules", () => {
			const parsed = parsedLayer({
				modelOverrides: {
					[DEEPSEEK]: { rewindHintReserveTokens: 50000 },
					[HAIKU]: { rewindHintReserveTokens: "off" },
					"x/bad": { rewindHintReserveTokens: 5 },
					"x/str": { rewindHintReserveTokens: " 30000 " },
					// No reserve key (e.g. pi's `reserveTokens`): not an override.
					"x/none": { reserveTokens: 1 },
				},
			});
			assert.deepEqual(
				parsed.modelHints,
				new Map<string, HintField>([
					[DEEPSEEK, { kind: "ok", value: 50000 }],
					[HAIKU, { kind: "disabled" }],
					["x/bad", { kind: "invalid" }],
					["x/str", { kind: "ok", value: 30000 }],
				]),
			);
			assert.deepEqual(parsed.modelOverridesProblems, {
				notObject: false,
				nonObjectEntries: [],
			});
		});

		it("records a non-object modelOverrides and non-object entries", () => {
			for (const raw of [null, 5, "x", [], true]) {
				const parsed = parsedLayer({ modelOverrides: raw });
				assert.equal(parsed.modelHints.size, 0);
				assert.equal(parsed.modelOverridesProblems.notObject, true);
			}
			const parsed = parsedLayer({
				modelOverrides: { a: 1, b: null, c: [], [DEEPSEEK]: {} },
			});
			assert.equal(parsed.modelHints.size, 0);
			assert.deepEqual(parsed.modelOverridesProblems, {
				notObject: false,
				nonObjectEntries: ["a", "b", "c"],
			});
		});

		it("leaves an absent modelOverrides problem-free", () => {
			const parsed = parsedLayer({ rewindHintReserveTokens: 40000 });
			assert.equal(parsed.modelHints.size, 0);
			assert.deepEqual(parsed.modelOverridesProblems, {
				notObject: false,
				nonObjectEntries: [],
			});
		});
	});

	describe("merge", () => {
		it("merges per key: a project entry wins, others pass through", () => {
			const merged = mergeTreeNavigatorConfig(
				layer({
					modelHints: [
						[DEEPSEEK, { kind: "ok", value: 50000 }],
						[HAIKU, { kind: "ok", value: 20000 }],
					],
				}),
				layer({ modelHints: [[HAIKU, { kind: "disabled" }]] }),
			);
			assert.deepEqual(
				merged.modelHints,
				new Map<string, HintField>([
					[DEEPSEEK, { kind: "ok", value: 50000 }],
					[HAIKU, { kind: "disabled" }],
				]),
			);
		});
	});

	describe("resolveRewindHintReserve", () => {
		const config = {
			rewindHintReserveTokens: 40000,
			rewindHintModelReserveTokens: new Map<string, number | null>([
				[DEEPSEEK, 50000],
				[HAIKU, null],
			]),
		};

		it("prefers a matching entry, including an off entry", () => {
			assert.equal(resolveRewindHintReserve(config, DEEPSEEK), 50000);
			assert.equal(resolveRewindHintReserve(config, HAIKU), null);
		});

		it("falls back to the base for an unmatched or unknown model", () => {
			assert.equal(resolveRewindHintReserve(config, "x/other"), 40000);
			assert.equal(resolveRewindHintReserve(config, undefined), 40000);
		});

		it("an entry enables a model while the base is off", () => {
			assert.equal(
				resolveRewindHintReserve({ ...config, rewindHintReserveTokens: null }, DEEPSEEK),
				50000,
			);
		});

		it("matches keys exactly", () => {
			assert.equal(resolveRewindHintReserve(config, DEEPSEEK.toUpperCase()), 40000);
		});
	});

	describe("loader", () => {
		it("loads the approved snippet", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					rewindHintReserveTokens: 40000,
					modelOverrides: {
						[DEEPSEEK]: { rewindHintReserveTokens: 50000 },
					},
				}),
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: false,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(40000, START_ANCHOR_DEFAULT_TURNS, [[DEEPSEEK, 50000]]),
				warnings: [],
			});
		});

		it("a global model entry beats a project base (pi precedent)", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					modelOverrides: { [DEEPSEEK]: { rewindHintReserveTokens: 50000 } },
				}),
				[PROJECT_PATH]: JSON.stringify({
					rewindHintReserveTokens: 30000,
					modelOverrides: { [HAIKU]: { rewindHintReserveTokens: false } },
				}),
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: true,
				readFile: reader.readFile,
			});
			assert.deepEqual(out.warnings, []);
			assert.equal(resolveRewindHintReserve(out.config, DEEPSEEK), 50000);
			assert.equal(resolveRewindHintReserve(out.config, HAIKU), null);
			assert.equal(resolveRewindHintReserve(out.config, "x/y"), 30000);
		});

		it("keeps key case as written (no normalization)", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					rewindHintReserveTokens: 40000,
					modelOverrides: {
						"OpenCode-Go/DeepSeek": { rewindHintReserveTokens: 50000 },
					},
				}),
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: false,
				readFile: reader.readFile,
			});
			assert.equal(resolveRewindHintReserve(out.config, "OpenCode-Go/DeepSeek"), 50000);
			assert.equal(resolveRewindHintReserve(out.config, "opencode-go/deepseek"), 40000);
		});

		it("ignores the untrusted project's entries", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({ rewindHintReserveTokens: 40000 }),
				[PROJECT_PATH]: JSON.stringify({
					modelOverrides: { [DEEPSEEK]: { rewindHintReserveTokens: 50000 } },
				}),
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: false,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, { config: cfg(40000), warnings: [] });
		});

		it("warns on shape problems and invalid entries; an invalid entry turns that model off", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					rewindHintReserveTokens: 40000,
					modelOverrides: {
						[DEEPSEEK]: { rewindHintReserveTokens: 999 },
						"x/num": 5,
					},
				}),
				[PROJECT_PATH]: JSON.stringify({ modelOverrides: [] }),
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: true,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(40000, START_ANCHOR_DEFAULT_TURNS, [[DEEPSEEK, null]]),
				warnings: [
					`navigate_tree: modelOverrides["x/num"] in global config at ${GLOBAL_PATH} must be an object — ignored.`,
					warnInvalidModelHint("global", GLOBAL_PATH, DEEPSEEK),
					`navigate_tree: modelOverrides in project config at ${PROJECT_PATH} must be an object keyed by "provider/modelId" — ignored.`,
				],
			});
		});

		it("a project file-level problem keeps the global entries", async () => {
			const reader = readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					modelOverrides: { [DEEPSEEK]: { rewindHintReserveTokens: 50000 } },
				}),
				[PROJECT_PATH]: "{not json",
			});
			const out = await loadTreeNavigatorConfig({
				agentDir: AGENT_DIR,
				projectPath: PROJECT_PATH,
				projectTrusted: true,
				readFile: reader.readFile,
			});
			assert.deepEqual(out, {
				config: cfg(null, START_ANCHOR_DEFAULT_TURNS, [[DEEPSEEK, 50000]]),
				warnings: [WARN_INVALID_JSON_PROJECT],
			});
		});
	});
});

describe("continuity config", () => {
	const CLASSIFIER = "typesafe/jev-latest";
	const OTHER_CLASSIFIER = "openrouter/typesafe/jev-1.13";
	const warnInvalidCapture = (which: "global" | "project", path: string) =>
		`navigate_tree: invalid continuity.capture in ${which} config at ${path} — expected true or false; falling back to the other layer's valid value, else the default true.`;
	const warnInvalidClassifier = (which: "global" | "project", path: string) =>
		`navigate_tree: invalid continuity.intentClassifier in ${which} config at ${path} — expected "recommended", "provider/id" of a classifier model, an object policy or a disable sentinel (null, false, "off", "disabled"); falling back to the other layer's valid value, else off (heuristics only).`;

	async function load(global: unknown, project?: unknown, projectTrusted = true) {
		const reader = readerFor({
			...(global === undefined ? {} : { [GLOBAL_PATH]: JSON.stringify(global) }),
			...(project === undefined ? {} : { [PROJECT_PATH]: JSON.stringify(project) }),
		});
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted,
			readFile: reader.readFile,
		});
		return { continuity: out.config.continuity, warnings: out.warnings };
	}

	it("defaults to capture on and heuristics only", async () => {
		assert.deepEqual(await load(undefined), {
			continuity: { capture: true, intentClassifier: null },
			warnings: [],
		});
	});

	it("reads both keys, camelCase and snake_case", async () => {
		assert.deepEqual(
			await load({
				continuity: { capture: false, intentClassifier: CLASSIFIER },
			}),
			{
				continuity: { capture: false, intentClassifier: CLASSIFIER },
				warnings: [],
			},
		);
		assert.deepEqual(
			await load({
				continuity: { intent_classifier: ` ${OTHER_CLASSIFIER} ` },
			}),
			{
				continuity: { capture: true, intentClassifier: OTHER_CLASSIFIER },
				warnings: [],
			},
		);
	});

	it("a trusted project overrides global per key; an untrusted one is not read", async () => {
		const global = {
			continuity: { capture: true, intentClassifier: CLASSIFIER },
		};
		const project = { continuity: { capture: false } };
		assert.deepEqual(await load(global, project), {
			continuity: { capture: false, intentClassifier: CLASSIFIER },
			warnings: [],
		});
		assert.deepEqual(await load(global, project, false), {
			continuity: { capture: true, intentClassifier: CLASSIFIER },
			warnings: [],
		});
	});

	for (const spelling of ["recommended", " Recommended ", "RECOMMENDED"]) {
		it(`${JSON.stringify(spelling)} selects the recommended policy, in either key spelling`, async () => {
			for (const key of ["intentClassifier", "intent_classifier"]) {
				assert.deepEqual(await load({ continuity: { [key]: spelling } }), {
					continuity: { capture: true, intentClassifier: "recommended" },
					warnings: [],
				});
			}
		});
	}

	it("the recommended policy layers like a model: project overrides global, off disables it", async () => {
		assert.deepEqual(
			await load(
				{ continuity: { intentClassifier: CLASSIFIER } },
				{ continuity: { intentClassifier: "recommended" } },
			),
			{
				continuity: { capture: true, intentClassifier: "recommended" },
				warnings: [],
			},
		);
		assert.deepEqual(
			await load(
				{ continuity: { intentClassifier: "recommended" } },
				{ continuity: { intentClassifier: "off" } },
			),
			{
				continuity: { capture: true, intentClassifier: null },
				warnings: [],
			},
		);
	});

	it("an object policy is validated and carried as canonical JSON text, in either key spelling", async () => {
		const policy = {
			supersession: { escalation: { model: null } },
			preset: "recommended",
			minConfidence: 0.8,
		};
		const canonical = JSON.stringify({
			preset: "recommended",
			minConfidence: 0.8,
			supersession: { escalation: { model: null } },
		});
		for (const key of ["intentClassifier", "intent_classifier"]) {
			assert.deepEqual(await load({ continuity: { [key]: policy } }), {
				continuity: { capture: true, intentClassifier: canonical },
				warnings: [],
			});
		}
	});

	it("a project object replaces the global value as a whole, never field by field", async () => {
		const out = await load(
			{
				continuity: {
					intentClassifier: { preset: "recommended", minConfidence: 0.9 },
				},
			},
			{ continuity: { intentClassifier: { kind: { model: "acme/judge" } } } },
		);
		assert.equal(
			out.continuity.intentClassifier,
			JSON.stringify({ kind: { model: "acme/judge" } }),
		);
	});

	it("an invalid object warns once per layer with each field problem, and falls back like any invalid value", async () => {
		const out = await load(
			{ continuity: { intentClassifier: CLASSIFIER } },
			{
				continuity: {
					intentClassifier: {
						minConfidence: 2,
						kind: { model: "nope" },
						surprise: true,
					},
				},
			},
		);
		assert.deepEqual(out, {
			continuity: { capture: true, intentClassifier: CLASSIFIER },
			warnings: [
				`navigate_tree: invalid continuity.intentClassifier in project config at ${PROJECT_PATH} — continuity.intentClassifier.surprise is not a field; continuity.intentClassifier.minConfidence must be a number above 0 up to 1; continuity.intentClassifier.kind.model must be "provider/id" or null; falling back to the other layer's valid value, else off (heuristics only).`,
			],
		});
		const alone = await load({
			continuity: { intentClassifier: { heuristics: false } },
		});
		assert.equal(alone.continuity.intentClassifier, null);
		assert.match(alone.warnings[0] ?? "", /has no source for the intent kind/);
	});

	for (const sentinel of [null, false, "off", " OFF ", "disabled"]) {
		it(`${JSON.stringify(sentinel)} disables a classifier set by the other layer`, async () => {
			const out = await load(
				{ continuity: { intentClassifier: CLASSIFIER } },
				{ continuity: { intentClassifier: sentinel } },
			);
			assert.deepEqual(out, {
				continuity: { capture: true, intentClassifier: null },
				warnings: [],
			});
		});
	}

	it("an invalid project value warns and falls back to global, per key", async () => {
		const out = await load(
			{ continuity: { capture: false, intentClassifier: CLASSIFIER } },
			{ continuity: { capture: "yes", intentClassifier: "no-slash" } },
		);
		assert.deepEqual(out, {
			continuity: { capture: false, intentClassifier: CLASSIFIER },
			warnings: [
				warnInvalidCapture("project", PROJECT_PATH),
				warnInvalidClassifier("project", PROJECT_PATH),
			],
		});
	});

	it("an invalid value with no valid layer warns and uses the default", async () => {
		const out = await load({
			continuity: { capture: 1, intentClassifier: true },
		});
		assert.deepEqual(out, {
			continuity: { capture: true, intentClassifier: null },
			warnings: [
				warnInvalidCapture("global", GLOBAL_PATH),
				warnInvalidClassifier("global", GLOBAL_PATH),
			],
		});
	});

	for (const bad of ["", "provider/", "/id", "has space/id", 5, []]) {
		it(`rejects intentClassifier ${JSON.stringify(bad)}`, async () => {
			const out = await load({ continuity: { intentClassifier: bad } });
			assert.equal(out.continuity.intentClassifier, null);
			assert.deepEqual(out.warnings, [warnInvalidClassifier("global", GLOBAL_PATH)]);
		});
	}

	it("a non-object continuity block warns and is ignored", async () => {
		const out = await load({ continuity: { capture: false } }, { continuity: "off" });
		assert.deepEqual(out, {
			continuity: { capture: false, intentClassifier: null },
			warnings: [
				`navigate_tree: continuity in project config at ${PROJECT_PATH} must be an object — ignored.`,
			],
		});
	});
});

describe("runtime layer", () => {
	const FILES = {
		[GLOBAL_PATH]: JSON.stringify({
			rewindHintReserveTokens: 50000,
			anchorStartAfterTurns: 5,
			parentHandoffMode: "synthesized",
			modelOverrides: {
				[DEEPSEEK]: { rewindHintReserveTokens: 40000 },
				[HAIKU]: { rewindHintReserveTokens: 20000 },
			},
			continuity: { capture: true, intentClassifier: "typesafe/jev-latest" },
			treeProposal: {
				model: "test/model:high",
				tools: { read: "omit", grep: "calls-only" },
			},
			auto_navigate: { enabled: true, tools: { read: "omit" } },
		}),
		[PROJECT_PATH]: JSON.stringify({
			anchorStartAfterTurns: 3,
			treeProposal: { tools: { bash: "calls-only" } },
		}),
	};

	function load(runtime?: Record<string, unknown>, projectTrusted = true) {
		return loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted,
			readFile: readerFor(FILES).readFile,
			...(runtime === undefined ? {} : { runtime }),
		});
	}

	it("overrides scalars, maps and tool policy per key without losing lower keys", async () => {
		const out = await load({
			anchorStartAfterTurns: 8,
			modelOverrides: { [DEEPSEEK]: { rewindHintReserveTokens: 60000 } },
			treeProposal: { tools: { read: "full", write: "omit" } },
			auto_navigate: { tools: { bash: "calls-only" }, check_every_turns: 2 },
		});
		assert.deepEqual(out.warnings, []);
		assert.equal(out.config.anchorStartAfterTurns, 8);
		assert.equal(out.config.parentHandoffMode, "synthesized");
		assert.equal(out.config.rewindHintReserveTokens, 50000);
		assert.equal(resolveRewindHintReserve(out.config, DEEPSEEK), 60000);
		assert.equal(resolveRewindHintReserve(out.config, HAIKU), 20000);
		assert.deepEqual(out.config.proposal, {
			model: "test/model:high",
			tools: {
				read: "full",
				grep: "calls-only",
				bash: "calls-only",
				write: "omit",
			},
		});
		assert.deepEqual(out.config.autoNavigate, {
			enabled: true,
			tools: { read: "omit", bash: "calls-only" },
			checkEveryTurns: 2,
		});
		assert.deepEqual(out.config.continuity, {
			capture: true,
			intentClassifier: "typesafe/jev-latest",
		});
	});

	it("can disable capture and a classifier set by the files", async () => {
		const out = await load({
			continuity: { capture: false, intentClassifier: "off" },
		});
		assert.deepEqual(out.warnings, []);
		assert.deepEqual(out.config.continuity, {
			capture: false,
			intentClassifier: null,
		});
	});

	it("applies even when the project is untrusted", async () => {
		const out = await load({ anchorStartAfterTurns: 8 }, false);
		assert.equal(out.config.anchorStartAfterTurns, 8);
		assert.deepEqual(out.config.proposal?.tools, {
			read: "omit",
			grep: "calls-only",
		});
	});

	it("an empty runtime root resolves like no runtime layer", async () => {
		assert.deepEqual(await load({}), await load());
	});

	it("clearing restores file resolution and sessions stay isolated", async () => {
		writeRuntimeConfig("layer-a", { continuity: { capture: false } });
		writeRuntimeConfig("layer-b", { anchorStartAfterTurns: 9 });
		const files = await load();
		const a = await load(readRuntimeConfig("layer-a"));
		const b = await load(readRuntimeConfig("layer-b"));
		assert.equal(a.config.continuity.capture, false);
		assert.equal(a.config.anchorStartAfterTurns, 3);
		assert.equal(b.config.continuity.capture, true);
		assert.equal(b.config.anchorStartAfterTurns, 9);
		clearRuntimeConfig("layer-a");
		assert.deepEqual(await load(readRuntimeConfig("layer-a")), files);
		assert.equal((await load(readRuntimeConfig("layer-b"))).config.anchorStartAfterTurns, 9);
		clearRuntimeConfig("layer-b");
	});

	it("invalid runtime values fail closed with runtime-scoped warnings", async () => {
		const out = await load({
			treeProposal: { tools: { read: "omti" } },
			auto_navigate: { check_every_turns: 0 },
			continuity: { capture: "yes" },
			rewindHintReserveTokens: 5,
		});
		assert.equal(out.config.proposal, undefined);
		assert.match(out.config.proposalError ?? "", /read/);
		assert.deepEqual(out.config.autoNavigate, { enabled: false });
		assert.equal(out.config.continuity.capture, true);
		assert.equal(out.config.rewindHintReserveTokens, null);
		assert.equal(out.warnings.length, 4);
		for (const warning of out.warnings) {
			assert.match(warning, /in runtime config /);
		}
	});

	it("a valid runtime proposal cannot clear an invalid file proposal", async () => {
		const out = await loadTreeNavigatorConfig({
			agentDir: AGENT_DIR,
			projectPath: PROJECT_PATH,
			projectTrusted: false,
			readFile: readerFor({
				[GLOBAL_PATH]: JSON.stringify({
					treeProposal: { tools: { read: "omti" } },
				}),
			}).readFile,
			runtime: { treeProposal: { tools: { read: "full" } } },
		});
		assert.equal(out.config.proposal, undefined);
		assert.match(out.config.proposalError ?? "", /read/);
	});

	it("a non-object runtime root is ignored with a warning", async () => {
		const out = await load("nope" as unknown as Record<string, unknown>);
		assert.deepEqual(out.config, (await load()).config);
		assert.deepEqual(out.warnings, [
			"navigate_tree: runtime config must be a JSON object — that layer was ignored.",
		]);
	});
});
