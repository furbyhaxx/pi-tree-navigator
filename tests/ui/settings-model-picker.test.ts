/**
 * Tests for the settings model picker: what it returns for each way of leaving
 * it, and that it only reads the registry.
 *
 * Node test runner. The registry is a strict fake that exposes only the two
 * listing calls; any other call (classify, stream, complete) throws.
 */

import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import type { Api, ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseClassifierModel } from "../../src/continuity/intent-policy.ts";
import { parseProposalModel } from "../../src/retrospective/proposal-options.ts";
import { pickSettingsModel } from "../../src/ui/settings-model-picker.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const HOME = "\x1b[H";

function chat(
	provider: string,
	id: string,
	name: string,
	extra: Partial<Model<Api>> = {},
): Model<Api> {
	return {
		provider,
		id,
		name,
		api: "openai-completions",
		baseUrl: "http://localhost",
		reasoning: true,
		input: ["text"],
		contextWindow: 32000,
		maxTokens: 4000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...extra,
	};
}

function classifier(provider: string, id: string, name: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		provider,
		id,
		name,
		api: "openai-classifier",
		baseUrl: "http://localhost",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
	} as unknown as ClassifierModel<ClassifierApi>;
}

// minimal is unsupported (null); xhigh is supported (mapped); max is unmapped, so unsupported.
const reasoner = chat("acme", "reasoner", "Acme Reasoner", {
	thinkingLevelMap: { minimal: null, xhigh: "extra" },
});
const plain = chat("acme", "plain", "Plain Chat", { reasoning: false });
const opus = chat("anthropic", "claude-opus-4-7", "Claude Opus 4.7");
const gpt = chat("openai", "gpt-5", "GPT-5");
const MODELS = [gpt, reasoner, opus, plain];
const CLASSIFIERS = [
	classifier("typesafe", "jev-latest", "Jev Latest"),
	classifier("acme", "tiny", "Tiny Judge"),
];

type Screen = {
	handleInput(data: string): void;
	render(width: number): string[];
};
type Script = (screen: Screen) => void;
const press =
	(...keys: string[]): Script =>
	(screen) => {
		for (const key of keys) screen.handleInput(key);
	};
const typed = (text: string): string[] => [...text];
const down = (n: number): string[] => Array<string>(n).fill(DOWN);

interface Setup {
	models?: Model<Api>[];
	classifiers?: ClassifierModel<ClassifierApi>[];
	inputs?: (string | undefined)[];
	columns?: number;
	listFails?: boolean;
}

function harness(setup: Setup = {}) {
	const calls: string[] = [];
	const notifications: { message: string; type?: string }[] = [];
	const inputs = [...(setup.inputs ?? [])];
	const asked: [string, string | undefined][] = [];
	const scripts: Script[] = [];
	const seen: string[][] = [];
	const columns = setup.columns ?? 80;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const session = chat("session", "active", "Active");
	const registry = new Proxy(
		{
			getAvailable() {
				calls.push("getAvailable");
				return setup.models ?? MODELS;
			},
			async getAvailableOfType(type: string) {
				calls.push(`getAvailableOfType:${type}`);
				if (setup.listFails) throw new Error("auth store locked");
				return setup.classifiers ?? CLASSIFIERS;
			},
		} as Record<string, unknown>,
		{
			get(target, key) {
				if (typeof key === "string" && !(key in target))
					throw new Error(`unexpected registry call: ${key}`);
				return Reflect.get(target, key);
			},
		},
	);
	const ctx = Object.freeze({
		model: session,
		thinkingLevel: "low",
		modelRegistry: registry,
		ui: {
			notify: (message: string, type?: string) => void notifications.push({ message, type }),
			async input(title: string, placeholder?: string) {
				asked.push([title, placeholder]);
				return inputs.shift();
			},
			custom(factory: (...args: unknown[]) => Screen): Promise<unknown> {
				const script = scripts.shift();
				assert.ok(script, "unexpected extra screen");
				return new Promise((resolve) => {
					const tui = { terminal: { rows: 60, columns }, requestRender() {} };
					const screen = factory(tui, theme, undefined, resolve);
					seen.push(screen.render(columns));
					script({
						handleInput: (data) => screen.handleInput(data),
						render: (width) => {
							const lines = screen.render(width);
							seen.push(lines);
							return lines;
						},
					});
				});
			},
		},
	}) as unknown as ExtensionCommandContext;
	return {
		ctx,
		session,
		calls,
		notifications,
		asked,
		seen,
		pending: () => scripts.length,
		run(kind: "model" | "classifier" | "stage", current: string | null, ...screens: Script[]) {
			scripts.push(...screens);
			return pickSettingsModel(ctx, { kind, current });
		},
	};
}

const text = (lines: readonly string[]): string => lines.join("\n");
const selectedLine = (lines: readonly string[]): string =>
	lines.find((line) => line.includes(" → ")) ?? "";

describe("settings model picker: results", () => {
	it("offers chat and decision models for a policy stage without a thinking step", async () => {
		const h = harness({ models: [plain], classifiers: [CLASSIFIERS[1]] });
		const result = await h.run("stage", null, (screen) => {
			const body = text(screen.render(80));
			assert.match(body, /Plain Chat/);
			assert.match(body, /Tiny Judge/);
			assert.doesNotMatch(body, /recommended|heuristics only/);
			for (const key of down(1)) screen.handleInput(key);
			screen.handleInput(ENTER);
		});
		assert.equal(result, "acme/plain");
		assert.equal(h.pending(), 0);
		assert.equal(h.ctx.model, h.session);
		assert.deepEqual(h.calls, ["getAvailableOfType:classifier", "getAvailable"]);
	});

	it("can disable a policy stage without changing other settings", async () => {
		const h = harness();
		assert.equal(await h.run("stage", null, press(ENTER)), null);
		assert.match(text(h.seen[0]), /disable this stage/);
	});
	it("returns a parser-valid provider/model:thinking and leaves the session model alone", async () => {
		const h = harness();
		// Rows: current, then models sorted by provider/name, then custom.
		const result = await h.run(
			"model",
			"current",
			press(...down(1), ENTER),
			press(...down(4), ENTER),
		);
		assert.equal(h.pending(), 0);
		assert.equal(result, "acme/reasoner:xhigh");
		assert.deepEqual(parseProposalModel(result as string), {
			provider: "acme",
			id: "reasoner",
			thinking: "xhigh",
		});
		assert.equal(h.ctx.model, h.session);
		assert.deepEqual(h.calls, ["getAvailable"]);
	});

	it("offers only the thinking levels the model supports", async () => {
		const h = harness();
		const result = await h.run("model", "current", press(...down(1), ENTER), (screen) => {
			const body = text(screen.render(80));
			for (const level of ["off", "low", "medium", "high", "xhigh"])
				assert.match(body, new RegExp(`\\b${level}\\b`));
			for (const level of ["minimal", "max"])
				assert.doesNotMatch(body, new RegExp(`\\b${level}\\b`));
			for (const level of ["minimal", "max"]) {
				for (const key of typed(level)) screen.handleInput(key);
				assert.match(text(screen.render(80)), /No matches/);
				screen.handleInput(ENTER);
				screen.handleInput(ESC);
			}
			screen.handleInput(ENTER);
		});
		assert.equal(h.pending(), 0);
		assert.match(result as string, /^acme\/reasoner:(off|low|medium|high|xhigh)$/);
	});

	it("saves a model without thinking levels as :off without asking", async () => {
		const h = harness();
		const result = await h.run("model", "current", press(...down(2), ENTER));
		assert.equal(result, "acme/plain:off");
		assert.deepEqual(parseProposalModel(result), {
			provider: "acme",
			id: "plain",
			thinking: "off",
		});
	});

	it("puts the configured model first, selects it and preselects its thinking level", async () => {
		const h = harness();
		const result = await h.run(
			"model",
			"openai/gpt-5:high",
			(screen) => {
				const lines = screen.render(80);
				const first = lines.findIndex((line) => line.includes("current"));
				const configured = lines.findIndex((line) => line.includes("GPT-5"));
				assert.equal(configured, first + 1);
				assert.match(selectedLine(lines), /GPT-5.*● selected/);
				screen.handleInput(ENTER);
			},
			(screen) => {
				const lines = screen.render(80);
				assert.match(selectedLine(lines), /high.*● selected/);
				screen.handleInput(ENTER);
			},
		);
		assert.equal(result, "openai/gpt-5:high");
	});

	it("carries the thinking level of the old model over, clamped to the new one", async () => {
		const h = harness();
		const result = await h.run(
			"model",
			"openai/gpt-5:minimal",
			press(HOME, ...down(2), ENTER),
			(screen) => {
				assert.match(selectedLine(screen.render(80)), /low/);
				screen.handleInput(ENTER);
			},
		);
		assert.equal(result, "acme/reasoner:low");
	});

	it("returns null for a classifier that is off, distinct from cancel and from current", async () => {
		const off = await harness().run("classifier", "typesafe/jev-latest", press(HOME, ENTER));
		assert.equal(off, null);

		const cancelled = await harness().run("classifier", null, press(ESC));
		assert.equal(cancelled, undefined);

		const follow = await harness().run("model", "acme/reasoner:low", press(HOME, ENTER));
		assert.equal(follow, "current");

		const cancelledModel = await harness().run("model", "current", press(ESC));
		assert.equal(cancelledModel, undefined);
	});

	it("offers the recommended policy after off, only for a classifier, and starts on it when configured", async () => {
		const pick = await harness().run("classifier", null, press(HOME, DOWN, ENTER));
		assert.equal(pick, "recommended");

		const configured = await harness().run("classifier", "recommended", (screen) => {
			const body = text(screen.render(80));
			assert.match(body, /recommended/);
			assert.match(body, /microsoft-decision-1/);
			screen.handleInput(ENTER);
		});
		assert.equal(configured, "recommended");

		await harness().run("model", "current", (screen) => {
			assert.doesNotMatch(text(screen.render(80)), /recommended/);
			screen.handleInput(ESC);
		});
	});

	it("shows a configured object policy as one selected row that cannot be replaced by accident", async () => {
		const h = harness();
		const policy = JSON.stringify({
			preset: "recommended",
			minConfidence: 0.8,
		});
		const result = await h.run(
			"classifier",
			policy,
			(screen) => {
				const body = text(screen.render(100));
				assert.match(body, /object policy/);
				assert.doesNotMatch(body, /minConfidence/);
				screen.handleInput(ENTER);
			},
			press(ESC),
		);
		assert.equal(result, undefined);
		assert.match(h.notifications[0]?.message ?? "", /object policy; edit it in the settings file/);
	});

	it("returns a classifier as provider/id from the classifier list, without a thinking step", async () => {
		const h = harness();
		const result = await h.run("classifier", null, (screen) => {
			const body = text(screen.render(80));
			assert.match(body, /Anchor\/Settings\/Classifier/);
			assert.match(body, /Jev Latest/);
			assert.doesNotMatch(body, /GPT-5/);
			screen.handleInput(DOWN);
			screen.handleInput(DOWN);
			screen.handleInput(DOWN);
			screen.handleInput(ENTER);
		});
		assert.equal(result, "typesafe/jev-latest");
		assert.deepEqual(parseClassifierModel(result as string), {
			provider: "typesafe",
			id: "jev-latest",
		});
		assert.deepEqual(h.calls, ["getAvailableOfType:classifier"]);
	});

	it("Escape at every level returns undefined and calls nothing", async () => {
		const h = harness();
		const result = await h.run(
			"model",
			"current",
			press(...down(1), ENTER),
			press(ESC),
			press(ESC),
		);
		assert.equal(h.pending(), 0);
		assert.equal(result, undefined);
		assert.deepEqual(h.asked, []);
		assert.deepEqual(h.notifications, []);
		assert.deepEqual(h.calls, ["getAvailable"]);
	});
});

describe("settings model picker: custom string", () => {
	const customRow = (n: number) => press(HOME, ...down(n), ENTER);

	it("accepts a provider that is not available, once it parses", async () => {
		const h = harness({ models: [opus], inputs: ["  offline/model:high  "] });
		const result = await h.run("model", "current", customRow(2));
		assert.equal(result, "offline/model:high");
		assert.deepEqual(h.asked, [["Custom model", "current or provider/id[:thinking]"]]);
		assert.deepEqual(h.calls, ["getAvailable"]);
	});

	it("asks again after an invalid string and returns to the list when the input is cancelled", async () => {
		const h = harness({
			models: [opus],
			inputs: ["no model", "p/m:turbo", "p/m\x1b[31m", undefined],
		});
		const result = await h.run("model", "current", customRow(2), press(ESC));
		assert.equal(result, undefined);
		assert.equal(h.notifications.length, 3);
		assert.ok(h.notifications.every((note) => note.type === "warning"));
		assert.match(h.notifications[1].message, /Invalid proposal thinking level: turbo/);
		assert.ok(!h.notifications[2].message.includes(ESC));
	});

	it("validates a classifier as provider/id and does not take off or a thinking suffix as special", async () => {
		const h = harness({ classifiers: [], inputs: ["off", "lab/judge-1"] });
		const result = await h.run("classifier", null, customRow(2));
		assert.equal(result, "lab/judge-1");
		assert.equal(h.notifications.length, 1);
		assert.deepEqual(h.asked[0], ["Custom classifier", "provider/id"]);
	});

	it("still offers off and custom when the classifier list cannot be read", async () => {
		const h = harness({ listFails: true, inputs: ["lab/judge-1"] });
		const result = await h.run("classifier", null, (screen) => {
			const body = text(screen.render(80));
			assert.match(body, /off/);
			assert.match(body, /custom/);
			assert.doesNotMatch(body, /Jev Latest/);
			screen.handleInput(DOWN);
			screen.handleInput(DOWN);
			screen.handleInput(ENTER);
		});
		assert.equal(result, "lab/judge-1");
		assert.match(h.notifications[0].message, /auth store locked/);
	});
});

describe("settings model picker: rendering", () => {
	it("fuzzy-searches names, ids and providers", async () => {
		const h = harness();
		const search =
			(query: string): Script =>
			(screen) => {
				for (const key of typed(query)) screen.handleInput(key);
				const body = text(screen.render(80));
				screen.handleInput(ESC);
				screen.handleInput(ESC);
				found.push(body);
			};
		const found: string[] = [];
		for (const query of ["opus", "claude-opus-4-7", "openai", "gpt5"]) {
			await h.run("model", "current", search(query));
		}
		assert.match(found[0], /Claude Opus 4\.7/);
		assert.doesNotMatch(found[0], /GPT-5/);
		assert.match(found[1], /Claude Opus 4\.7/);
		assert.doesNotMatch(found[1], /Acme Reasoner/);
		assert.match(found[2], /GPT-5/);
		assert.doesNotMatch(found[2], /Claude Opus/);
		assert.match(found[3], /GPT-5/);
	});

	it("keeps every line within the width and strips escape sequences from names", async () => {
		const unsafeId = chat("evil\x1b[31m", "id\x1b]0;pwn\x07", "Evil");
		const spaced = chat("sp ace", "m", "Spaced");
		const unsafeName = chat("safe", "ok", `Bad\x1b[2Jname${"x".repeat(80)}`);
		for (const columns of [60, 130]) {
			const h = harness({
				models: [unsafeId, spaced, unsafeName, opus],
				columns,
			});
			await h.run("model", "anthropic/claude-opus-4-7:high", (screen) => {
				const lines = screen.render(columns);
				assert.ok(lines.every((line) => visibleWidth(line) <= columns));
				for (const hostile of ["\x1b[2J", "\x1b[31m", "\x1b]0;", "\x07"])
					assert.ok(!text(lines).includes(hostile));
				assert.match(lines[0], /Anchor\/Settings\/Model/);
				assert.doesNotMatch(text(lines), /Spaced|Evil|evil/);
				assert.match(text(lines), /Claude Opus 4\.7/);
				assert.match(text(lines), /Badnamex/);
				screen.handleInput(ESC);
			});
			assert.ok(h.seen.every((lines) => lines.every((line) => visibleWidth(line) <= columns)));
		}
	});

	it("shows the thinking step under a Thinking breadcrumb and names the model", async () => {
		const h = harness({ columns: 60 });
		await h.run(
			"model",
			"current",
			press(...down(1), ENTER),
			(screen) => {
				const lines = screen.render(60);
				assert.match(lines[0], /Anchor\/Settings\/Model\/Thinking/);
				assert.match(lines[1], /acme\/reasoner/);
				assert.ok(lines.every((line) => visibleWidth(line) <= 60));
				screen.handleInput(ESC);
			},
			press(ESC),
		);
	});

	it("lists a configured model that is not available right after current, and keeps it on Enter", async () => {
		const h = harness({ columns: 60 });
		const result = await h.run("model", "offline/model:high", (screen) => {
			const lines = screen.render(60);
			assert.match(lines[0], /Anchor\/Settings\/Model/);
			const rows = lines.filter((line) => /current|offline/.test(line));
			assert.match(rows[0], /current/);
			assert.match(rows[1], /offline\/model:high/);
			assert.match(selectedLine(lines), /offline\/model:high/);
			screen.handleInput(ENTER);
		});
		assert.equal(result, "offline/model:high");
	});
});
