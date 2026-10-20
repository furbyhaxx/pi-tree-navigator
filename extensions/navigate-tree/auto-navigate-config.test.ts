import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchesModelPattern,
  parseAutoNavigatePartial,
} from "./auto-navigate-config.ts";
import {
  loadTreeNavigatorConfig,
  resolveAutoNavigateConfig,
  resolveRewindHintReserve,
} from "./config.ts";

describe("wildcard modelOverrides and snake_case auto_navigate", () => {
  it("matches *gemini-4-argon* and bare gemini-4-argon across providers", () => {
    for (const pattern of ["*gemini-4-argon*", "gemini-4-argon"]) {
      assert.equal(
        matchesModelPattern(pattern, "openrouter/google/gemini-4-argon"),
        true,
      );
      assert.equal(matchesModelPattern(pattern, "google/gemini-4-argon"), true);
      assert.equal(
        matchesModelPattern(pattern, "opencode/gemini-4-argon"),
        true,
      );
      assert.equal(
        matchesModelPattern(pattern, "claude/claude-opus-5-5"),
        false,
      );
    }
    assert.equal(
      matchesModelPattern(
        "*deepseek*",
        "synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017",
      ),
      true,
    );
    assert.equal(
      matchesModelPattern(
        "*deepseek*",
        "nvidia/deepseek-ai/deepseek-v4.1-flash",
      ),
      true,
    );
  });

  it("parses snake_case auto_navigate keys and rejects unknown keys", () => {
    const parsed = parseAutoNavigatePartial({
      enabled: true,
      mode: "anchor-and-rewind",
      controller_model: "openai/gpt-6-luna:low",
      check_every_turns: 4,
      min_tokens_since_anchor: 20000,
      rewind_at_tokens: 90000,
      tools: { bash: "calls-only", read: "omit" },
    });
    assert.deepEqual(parsed, {
      enabled: true,
      mode: "anchor-and-rewind",
      controllerModel: "openai/gpt-6-luna:low",
      checkEveryTurns: 4,
      minTokensSinceAnchor: 20000,
      rewindAtTokens: 90000,
      tools: { bash: "calls-only", read: "omit" },
    });
    assert.throws(() => parseAutoNavigatePartial({ camelCaseKey: true }));
    assert.throws(() => parseAutoNavigatePartial({ check_every_turns: 0 }));
  });

  it("resolves wildcard reserve and auto_navigate with exact > specific > broad precedence", async () => {
    const raw = JSON.stringify({
      rewind_hint_reserve_tokens: 40000,
      auto_navigate: {
        enabled: false,
        controller_model: "openai/gpt-6-luna:low",
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
      resolveRewindHintReserve(
        loaded.config,
        "openrouter/google/gemini-4-argon",
      ),
      150000,
    );
    assert.equal(
      resolveRewindHintReserve(loaded.config, "google/gemini-4-argon"),
      90000,
    );
    const openrouterAuto = resolveAutoNavigateConfig(
      loaded.config,
      "openrouter/google/gemini-4-argon",
    );
    assert.deepEqual(openrouterAuto, {
      enabled: true,
      mode: "anchor-and-rewind",
      controllerModel: "openai/gpt-6-luna:low",
      checkEveryTurns: 4,
      minTokensSinceAnchor: 25000,
      rewindAtTokens: 90000,
      tools: { read: "omit", bash: "calls-only" },
    });
    const googleAuto = resolveAutoNavigateConfig(
      loaded.config,
      "google/gemini-4-argon",
    );
    assert.equal(googleAuto.enabled, true);
    assert.equal(googleAuto.checkEveryTurns, 4);
    assert.equal(googleAuto.rewindAtTokens, 140000);
    const opusAuto = resolveAutoNavigateConfig(
      loaded.config,
      "claude/claude-opus-5-5",
    );
    assert.equal(opusAuto.enabled, false);
  });
});
