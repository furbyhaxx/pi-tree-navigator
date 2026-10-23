/**
 * Tests for the structured classifier-policy editor.
 *
 * Node test runner. The registry only lists models; any other call throws.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { RECOMMENDED_POLICY } from "./intent-policy.ts";
import {
  RECOMMENDED_MILESTONE_POLICY,
  resolveMilestonePolicy,
} from "./milestone-policy.ts";
import {
  editPolicy,
  type PolicyKind,
  policyWarning,
  summarizePolicy,
} from "./policy-settings.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const VERIFIER = `${RECOMMENDED_POLICY.provider}/${RECOMMENDED_POLICY.classifier}`;

type Screen = {
  handleInput(data: string): void;
  render(width: number): string[];
};
type Script = (screen: Screen) => void;

const until =
  (label: string, key = ENTER): Script =>
  (screen) => {
    screen.handleInput(HOME);
    for (let step = 0; step < 24; step++) {
      const selected = screen.render(120).find((line) => line.includes(" → "));
      if (selected?.includes(label)) break;
      screen.handleInput(DOWN);
    }
    screen.handleInput(key);
  };

interface Setup {
  inputs?: (string | undefined)[];
  editors?: (string | undefined)[];
  models?: { provider: string; id: string; name: string }[];
}

function harness(setup: Setup = {}) {
  const calls: string[] = [];
  const notifications: { message: string; type?: string }[] = [];
  const inputs = [...(setup.inputs ?? [])];
  const editors = [...(setup.editors ?? [])];
  const asked: [string, string | undefined][] = [];
  const scripts: Script[] = [];
  const seen: string[][] = [];
  const registry = new Proxy(
    {
      getAvailable() {
        calls.push("getAvailable");
        return setup.models ?? [];
      },
      async getAvailableOfType(type: string) {
        calls.push(`getAvailableOfType:${type}`);
        return type === "classifier" ? (setup.models ?? []) : [];
      },
    },
    {
      get(target, key) {
        if (typeof key === "string" && !(key in target)) {
          throw new Error(`unexpected registry call: ${key}`);
        }
        return Reflect.get(target, key);
      },
    },
  );
  const ctx = {
    modelRegistry: registry,
    ui: {
      notify: (message: string, type?: string) =>
        void notifications.push({ message, type }),
      async input(title: string, placeholder?: string) {
        asked.push([title, placeholder]);
        return inputs.shift();
      },
      async editor(title: string, prefill?: string) {
        asked.push([title, prefill]);
        return editors.shift();
      },
      custom(factory: (...args: unknown[]) => Screen): Promise<unknown> {
        const script = scripts.shift();
        assert.ok(script, "unexpected extra screen");
        return new Promise((resolve) => {
          const tui = {
            terminal: { rows: 40, columns: 120 },
            requestRender() {},
          };
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
          };
          const screen = factory(tui, theme, undefined, resolve);
          seen.push(screen.render(120));
          script({
            handleInput: (data) => screen.handleInput(data),
            render: (width) => screen.render(width),
          });
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    calls,
    notifications,
    asked,
    seen,
    pending: () => scripts.length,
    run(kind: PolicyKind, current: unknown, ...screens: Script[]) {
      scripts.push(...screens);
      return editPolicy(ctx, kind, current);
    },
  };
}

const text = (lines: readonly string[]): string => lines.join("\n");

describe("policy summaries", () => {
  it("describes policies in words, not canonical JSON", () => {
    assert.equal(summarizePolicy("intent", null), "off");
    assert.equal(summarizePolicy("intent", "recommended"), "recommended");
    assert.equal(summarizePolicy("intent", "acme/judge"), "acme/judge");
    assert.equal(
      summarizePolicy("intent", {
        preset: "recommended",
        supersession: { escalation: { model: null } },
      }),
      "recommended · escalation off",
    );
    const milestone = {
      preset: "recommended",
      minConfidence: 0.85,
      classifier: { model: "acme/judge" },
    };
    assert.equal(
      summarizePolicy("milestone", milestone),
      "recommended · gate 0.85 · classifier acme/judge",
    );
    assert.equal(
      summarizePolicy("milestone", JSON.stringify(milestone)),
      "recommended · gate 0.85 · classifier acme/judge",
    );
    assert.equal(
      summarizePolicy("milestone", {
        classifier: { model: "acme/judge" },
        confirmer: { model: null },
      }),
      "custom · classifier acme/judge · confirmer off",
    );
    assert.match(
      policyWarning("milestone", {
        classifier: { model: "acme/judge" },
        confirmer: { model: null },
      }) ?? "",
      /Single-model mode/,
    );
    assert.equal(policyWarning("milestone", "recommended"), undefined);
    for (const summary of [
      summarizePolicy("intent", milestone),
      summarizePolicy("milestone", JSON.stringify(milestone)),
    ]) {
      assert.equal(summary.includes("{"), false);
    }
  });
});

describe("policy editor", () => {
  it("shows verification rows and the recommended verifier", async () => {
    const h = harness();
    const result = await h.run("intent", "recommended", (screen) => {
      const body = text(screen.render(120));
      assert.match(body, /verification model/);
      assert.match(body, /verification prompt/);
      assert.match(body, new RegExp(VERIFIER.replace("/", "\\/")));
      screen.handleInput(ESC);
    });
    assert.equal(result, undefined);
    assert.deepEqual(h.calls, []);
  });

  it("disables escalation without turning the other preset stages off", async () => {
    const h = harness();
    const result = await h.run(
      "intent",
      "recommended",
      until("escalation model"),
      (screen) => {
        screen.handleInput(HOME);
        screen.handleInput(ENTER);
      },
      (screen) => screen.handleInput("a"),
    );
    assert.deepEqual(result, {
      preset: "recommended",
      supersession: { escalation: { model: null } },
    });
    assert.equal(JSON.stringify(result).includes("verification"), false);
    assert.ok(h.calls.every((call) => call.startsWith("getAvailable")));
    assert.equal(h.pending(), 0);
  });

  it("refuses an unknown policy field without changing the current object", async () => {
    const current = {
      preset: "recommended",
      future: { keep: true },
      supersession: {
        escalation: { model: "acme/old" },
        verification: { model: "acme/verify", instructions: "Check." },
      },
    };
    const before = structuredClone(current);
    const h = harness({
      models: [{ provider: "acme", id: "judge", name: "Acme Judge" }],
    });
    const result = await h.run(
      "intent",
      current,
      until("kind model"),
      until("Acme Judge"),
      (screen) => screen.handleInput("a"),
      (screen) => screen.handleInput(ESC),
    );
    assert.deepEqual(current, before);
    assert.equal(result, undefined);
    assert.match(JSON.stringify(h.notifications), /future is not a field/);
  });

  it("returns null for off and discards a cancelled draft", async () => {
    const current = { preset: "recommended", minConfidence: 0.8 };
    const before = structuredClone(current);
    const h = harness({ inputs: ["0.2"] });
    const cancelled = await h.run("intent", current, until("gate"), (screen) =>
      screen.handleInput(ESC),
    );
    assert.equal(cancelled, undefined);
    assert.deepEqual(current, before);

    const off = await h.run(
      "milestone",
      "recommended",
      (screen) => screen.handleInput(RIGHT),
      (screen) => screen.handleInput("a"),
    );
    assert.equal(off, null);
    assert.deepEqual(h.calls, []);
  });

  it("refuses an invalid confidence and an overlong prompt", async () => {
    const h = harness({
      inputs: ["0", "1.5"],
      editors: ["x".repeat(1001), "  "],
    });
    const confidence = await h.run(
      "intent",
      "recommended",
      until("gate"),
      (screen) => screen.handleInput("a"),
    );
    assert.equal(confidence, "recommended");
    assert.match(
      h.notifications[0]?.message ?? "",
      /minConfidence must be a number above 0 up to 1/,
    );

    const prompt = await h.run(
      "milestone",
      "recommended",
      until("status prompt"),
      (screen) => screen.handleInput("a"),
    );
    assert.equal(prompt, "recommended");
    assert.match(
      h.notifications.at(-1)?.message ?? "",
      /status\.instructions must be a text of 1-1000 characters/,
    );
    assert.equal(h.pending(), 0);
  });

  it("keeps the milestone confirmer when only the gate and classifier change", async () => {
    const h = harness({
      inputs: ["0.85"],
      models: [{ provider: "acme", id: "judge", name: "Acme Judge" }],
    });
    const result = await h.run(
      "milestone",
      "recommended",
      until("gate"),
      until("classifier model"),
      until("Acme Judge"),
      (screen) => screen.handleInput("a"),
    );
    assert.deepEqual(result, {
      preset: "recommended",
      minConfidence: 0.85,
      classifier: { model: "acme/judge" },
    });
    const policy = resolveMilestonePolicy(JSON.stringify(result));
    assert.equal(
      policy?.confirmer,
      `${RECOMMENDED_MILESTONE_POLICY.provider}/${RECOMMENDED_MILESTONE_POLICY.confirmer}`,
    );
    assert.equal(policy?.classifier, "acme/judge");
  });

  it("warns when milestone confirmation is off", async () => {
    const h = harness();
    const result = await h.run(
      "milestone",
      { classifier: { model: "acme/judge" }, confirmer: { model: null } },
      (screen) => {
        assert.match(text(screen.render(120)), /⚠ single model/);
        screen.handleInput(HOME);
        for (let step = 0; step < 8; step++) {
          const selected = screen
            .render(120)
            .find((line) => line.includes(" → "));
          if (selected?.includes("confirmer model")) break;
          screen.handleInput(DOWN);
        }
        const body = text(screen.render(120));
        assert.match(body, /off · single model/);
        assert.match(body, /Single-model mode/);
        screen.handleInput(ESC);
      },
    );
    assert.equal(result, undefined);
  });

  it("stores a verification prompt without dropping the preset", async () => {
    const h = harness({ editors: ["Confirm the retirement."] });
    const result = await h.run(
      "intent",
      "recommended",
      until("verification prompt"),
      (screen) => screen.handleInput("a"),
    );
    assert.deepEqual(result, {
      preset: "recommended",
      supersession: {
        verification: { instructions: "Confirm the retirement." },
      },
    });
  });
});
