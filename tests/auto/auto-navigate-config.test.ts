import { describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import {
	matchesModelPattern,
	materializeAutoNavigateConfig,
	parseAutoNavigatePartial,
} from "../../src/auto/auto-navigate-config.ts";
import {
	parseMilestonePolicyObject,
	RECOMMENDED_MILESTONE_CLASSIFIER,
	resolveMilestonePolicy,
} from "../../src/auto/milestone-policy.ts";
import {
	loadTreeNavigatorConfig,
	resolveAutoNavigateConfig,
	resolveRewindHintReserve,
} from "../../src/core/config.ts";

describe("wildcard modelOverrides and snake_case auto_navigate", () => {
	it("matches *gemini-4-argon* and bare gemini-4-argon across providers", () => {
		for (const pattern of ["*gemini-4-argon*", "gemini-4-argon"]) {
			assert.equal(matchesModelPattern(pattern, "openrouter/google/gemini-4-argon"), true);
			assert.equal(matchesModelPattern(pattern, "google/gemini-4-argon"), true);
			assert.equal(matchesModelPattern(pattern, "opencode/gemini-4-argon"), true);
			assert.equal(matchesModelPattern(pattern, "claude/claude-opus-5-5"), false);
		}
		assert.equal(
			matchesModelPattern("*deepseek*", "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"),
			true,
		);
		assert.equal(matchesModelPattern("*deepseek*", "nvidia/deepseek-ai/deepseek-v4.1-flash"), true);
	});

	it("parses snake_case auto_navigate keys and rejects unknown keys", () => {
		const parsed = parseAutoNavigatePartial({
			enabled: true,
			mode: "anchor-and-rewind",
			pressure: "fold",
			keep_recent_share: 0.3,
			milestone: "recommended",
			check_every_turns: 4,
			min_tokens_since_anchor: 20000,
			rewind_at_tokens: 90000,
			tools: { bash: "calls-only", read: "omit" },
		});
		assert.deepEqual(parsed, {
			enabled: true,
			mode: "anchor-and-rewind",
			pressure: "fold",
			keepRecentShare: 0.3,
			milestonePolicy: "recommended",
			checkEveryTurns: 4,
			minTokensSinceAnchor: 20000,
			rewindAtTokens: 90000,
			tools: { bash: "calls-only", read: "omit" },
		});
		assert.equal(parseAutoNavigatePartial({ keep_recent_share: 0.05 }).keepRecentShare, 0.05);
		assert.equal(parseAutoNavigatePartial({ keep_recent_share: 0.45 }).keepRecentShare, 0.45);
		assert.throws(() => parseAutoNavigatePartial({ camelCaseKey: true }));
		assert.throws(() => parseAutoNavigatePartial({ check_every_turns: 0 }));
		// Removed in favour of `milestone`: ignored here, reported once by the loader.
		assert.deepEqual(parseAutoNavigatePartial({ controller_model: "test/old" }), {});
	});

	it("defaults auto-navigation off with the recommended milestone policy", () => {
		const config = materializeAutoNavigateConfig(undefined);
		assert.equal(config.enabled, false);
		assert.equal(config.pressure, "compact");
		assert.equal(config.keepRecentShare, 0.25);
		assert.equal(config.milestonePolicy, RECOMMENDED_MILESTONE_CLASSIFIER);
	});

	it("merges pressure settings per model override", async () => {
		const loaded = await loadTreeNavigatorConfig({
			agentDir: "/agent",
			projectPath: "/project/.pi/tree-navigator.json",
			projectTrusted: false,
			readFile: async () =>
				JSON.stringify({
					auto_navigate: { pressure: "fold", keep_recent_share: 0.3 },
					model_overrides: {
						"*opus*": {
							auto_navigate: { keep_recent_share: 0.2 },
						},
					},
				}),
		});
		assert.deepEqual(loaded.warnings, []);
		const resolved = resolveAutoNavigateConfig(loaded.config, "anthropic/claude-opus-5-5");
		assert.equal(resolved.pressure, "fold");
		assert.equal(resolved.keepRecentShare, 0.2);
	});

	it("warns on invalid pressure fields without applying their values", async () => {
		for (const [autoNavigate, field] of [
			[{ pressure: "squash", keep_recent_share: 0.3 }, "auto_navigate.pressure"],
			[{ pressure: "fold", keep_recent_share: 0.5 }, "auto_navigate.keep_recent_share"],
		] as const) {
			const loaded = await loadTreeNavigatorConfig({
				agentDir: "/agent",
				projectPath: "/project/.pi/tree-navigator.json",
				projectTrusted: false,
				readFile: async () => JSON.stringify({ auto_navigate: autoNavigate }),
			});
			assert.equal(loaded.warnings.length, 1);
			assert.ok(loaded.warnings[0]?.includes(field));
			const resolved = resolveAutoNavigateConfig(loaded.config, undefined);
			assert.equal(resolved.pressure, "compact");
			assert.equal(resolved.keepRecentShare, 0.25);
		}
	});

	it("canonicalizes and resolves milestone object settings", async () => {
		const policy = {
			boundary: { instructions: "boundary from config" },
			confirmer: { model: " acme/confirm " },
			classifier: { model: "acme/classify" },
			status: { instructions: "  status from config  " },
			minConfidence: 0.82,
			preset: "recommended",
		};
		const canonical = JSON.stringify({
			preset: "recommended",
			minConfidence: 0.82,
			classifier: { model: "acme/classify" },
			confirmer: { model: "acme/confirm" },
			status: { instructions: "status from config" },
			boundary: { instructions: "boundary from config" },
		});
		const parsed = parseMilestonePolicyObject(policy);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.ok ? parsed.canonical : undefined, canonical);
		assert.equal(parseAutoNavigatePartial({ milestone: policy }).milestonePolicy, canonical);
		assert.throws(
			() =>
				parseAutoNavigatePartial({
					milestone: { classifier: { model: "acme/classify", stageKey: true } },
				}),
			/autoNavigate\.milestone\.classifier\.stageKey is not a field/,
		);
		assert.throws(
			() => parseAutoNavigatePartial({ milestone: false }),
			/auto_navigate\.milestone must be null/,
		);

		const loaded = await loadTreeNavigatorConfig({
			agentDir: "/agent",
			projectPath: "/project/.pi/tree-navigator.json",
			projectTrusted: false,
			readFile: async () => JSON.stringify({ auto_navigate: { milestone: policy } }),
		});
		assert.deepEqual(loaded.warnings, []);
		assert.equal(loaded.config.autoNavigate?.milestonePolicy, canonical);
		assert.deepEqual(resolveMilestonePolicy(canonical), {
			minConfidence: 0.82,
			classifier: "acme/classify",
			confirmer: "acme/confirm",
			instructions: {
				status: "status from config",
				boundary: "boundary from config",
			},
		});
	});

	it("lets wildcard null disable only the milestone policy", async () => {
		const loaded = await loadTreeNavigatorConfig({
			agentDir: "/agent",
			projectPath: "/project/.pi/tree-navigator.json",
			projectTrusted: false,
			readFile: async () =>
				JSON.stringify({
					auto_navigate: {
						enabled: true,
						milestone: RECOMMENDED_MILESTONE_CLASSIFIER,
						check_every_turns: 4,
						min_tokens_since_anchor: 25000,
						rewind_at_tokens: 120000,
						tools: { read: "omit" },
					},
					model_overrides: {
						"*gemini-4-argon*": {
							auto_navigate: {
								milestone: null,
								tools: { bash: "calls-only" },
							},
						},
					},
				}),
		});
		assert.deepEqual(loaded.warnings, []);
		const matching = resolveAutoNavigateConfig(loaded.config, "openrouter/google/gemini-4-argon");
		assert.deepEqual(matching, {
			enabled: true,
			mode: "anchor-and-rewind",
			pressure: "compact",
			keepRecentShare: 0.25,
			checkEveryTurns: 4,
			minTokensSinceAnchor: 25000,
			rewindAtTokens: 120000,
			milestonePolicy: null,
			tools: { read: "omit", bash: "calls-only" },
		});
		const other = resolveAutoNavigateConfig(loaded.config, "claude/claude-opus-5-5");
		assert.equal(other.enabled, true);
		assert.equal(other.milestonePolicy, RECOMMENDED_MILESTONE_CLASSIFIER);
		assert.equal(other.checkEveryTurns, 4);
		assert.equal(other.minTokensSinceAnchor, 25000);
		assert.equal(other.rewindAtTokens, 120000);
	});

	it("resolves wildcard reserve and auto_navigate with exact > specific > broad precedence", async () => {
		const raw = JSON.stringify({
			rewind_hint_reserve_tokens: 40000,
			auto_navigate: {
				enabled: false,
				milestone: "recommended",
				check_every_turns: 6,
				min_tokens_since_anchor: 25000,
				rewind_at_tokens: 120000,
				tools: { read: "omit" },
			},
			model_overrides: {
				"*gemini-4-argon*": {
					rewind_hint_reserve_tokens: 150000,
					auto_navigate: {
						enabled: true,
						check_every_turns: 4,
						rewind_at_tokens: 90000,
						tools: { bash: "calls-only" },
					},
				},
				"google/gemini-4-argon": {
					rewind_hint_reserve_tokens: 90000,
					auto_navigate: {
						rewind_at_tokens: 140000,
					},
				},
			},
		});
		const loaded = await loadTreeNavigatorConfig({
			agentDir: "/agent",
			projectPath: "/project/.pi/tree-navigator.json",
			projectTrusted: false,
			readFile: async () => raw,
		});
		assert.deepEqual(loaded.warnings, []);
		assert.equal(
			resolveRewindHintReserve(loaded.config, "openrouter/google/gemini-4-argon"),
			150000,
		);
		assert.equal(resolveRewindHintReserve(loaded.config, "google/gemini-4-argon"), 90000);
		const openrouterAuto = resolveAutoNavigateConfig(
			loaded.config,
			"openrouter/google/gemini-4-argon",
		);
		assert.deepEqual(openrouterAuto, {
			enabled: true,
			mode: "anchor-and-rewind",
			pressure: "compact",
			keepRecentShare: 0.25,
			checkEveryTurns: 4,
			minTokensSinceAnchor: 25000,
			rewindAtTokens: 90000,
			milestonePolicy: RECOMMENDED_MILESTONE_CLASSIFIER,
			tools: { read: "omit", bash: "calls-only" },
		});
		const googleAuto = resolveAutoNavigateConfig(loaded.config, "google/gemini-4-argon");
		assert.equal(googleAuto.enabled, true);
		assert.equal(googleAuto.checkEveryTurns, 4);
		assert.equal(googleAuto.rewindAtTokens, 140000);
		const opusAuto = resolveAutoNavigateConfig(loaded.config, "claude/claude-opus-5-5");
		assert.equal(opusAuto.enabled, false);
	});
});
