/** Config layer precedence and per-model merge cases. */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { ParsedLayer } from "../../src/core/config.ts";
import type {
	HintField,
	ParentHandoffModeField,
	StartAnchorField,
} from "../../src/core/config-fields.ts";
import { mergeTreeNavigatorConfig } from "../../src/core/config-merge.ts";

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

const DEEPSEEK = "opencode-go/deepseek-v4.1-flash";
const HAIKU = "claude-bridge/claude-haiku-5-5";

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

describe("modelOverrides (#86)", () => {
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
});
