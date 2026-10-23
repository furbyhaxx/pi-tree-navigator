/**
 * Tests for the intent classifier policy: strict validation of the object form
 * and how it merges over the preset. Node test runner. Run with: pnpm test
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseIntentPolicyObject,
  RECOMMENDED_POLICY,
  resolveIntentPolicy,
} from "./intent-policy.ts";

const MICROSOFT = `${RECOMMENDED_POLICY.provider}/${RECOMMENDED_POLICY.classifier}`;
const LUNA = `${RECOMMENDED_POLICY.provider}/${RECOMMENDED_POLICY.escalation}`;

const problems = (value: unknown): readonly string[] => {
  const out = parseIntentPolicyObject(value);
  assert.equal(out.ok, false);
  return out.ok ? [] : out.problems;
};

describe("parseIntentPolicyObject", () => {
  it("accepts every documented field and returns canonical JSON text", () => {
    const out = parseIntentPolicyObject({
      supersession: {
        escalation: { instructions: " Second. ", model: ` ${LUNA} ` },
        verification: { model: " acme/check ", instructions: " Check. " },
        model: null,
        instructions: "First.",
      },
      minConfidence: 0.8,
      kind: { model: "acme/judge", instructions: "Kind." },
      heuristics: false,
      preset: "recommended",
    });
    assert.ok(out.ok);
    assert.equal(
      out.canonical,
      JSON.stringify({
        preset: "recommended",
        heuristics: false,
        minConfidence: 0.8,
        kind: { model: "acme/judge", instructions: "Kind." },
        supersession: {
          model: null,
          instructions: "First.",
          escalation: { model: LUNA, instructions: "Second." },
          verification: { model: "acme/check", instructions: "Check." },
        },
      }),
    );
  });

  it("accepts an empty object and a preset alone", () => {
    assert.ok(parseIntentPolicyObject({}).ok);
    assert.ok(parseIntentPolicyObject({ preset: "recommended" }).ok);
  });

  it("names every problem by its field path", () => {
    assert.deepEqual(
      problems({
        preset: "best",
        heuristics: "yes",
        minConfidence: 0,
        extra: 1,
        kind: { model: "no-slash", instructions: "  ", other: true },
        supersession: {
          model: 5,
          escalation: { model: "a/b", instructions: "x".repeat(1001) },
        },
      }),
      [
        "continuity.intentClassifier.extra is not a field",
        'continuity.intentClassifier.preset must be "recommended"',
        "continuity.intentClassifier.heuristics must be true or false",
        "continuity.intentClassifier.minConfidence must be a number above 0 up to 1",
        "continuity.intentClassifier.kind.other is not a field",
        'continuity.intentClassifier.kind.model must be "provider/id" or null',
        "continuity.intentClassifier.kind.instructions must be a text of 1-1000 characters",
        'continuity.intentClassifier.supersession.model must be "provider/id" or null',
        "continuity.intentClassifier.supersession.escalation.instructions must be a text of 1-1000 characters",
      ],
    );
  });

  it("rejects wrong shapes and a confidence outside (0, 1]", () => {
    assert.deepEqual(problems([]), [
      "continuity.intentClassifier must be an object",
    ]);
    assert.deepEqual(problems({ kind: "microsoft", supersession: [] }), [
      "continuity.intentClassifier.kind must be an object",
      "continuity.intentClassifier.supersession must be an object",
    ]);
    for (const bad of [0, -0.1, 1.01, "0.5", null, Number.NaN]) {
      assert.equal(problems({ minConfidence: bad }).length, 1);
    }
    assert.ok(parseIntentPolicyObject({ minConfidence: 1 }).ok);
  });

  it("names a bad verification stage by its field path", () => {
    assert.deepEqual(
      problems({
        supersession: { verification: { model: "no-slash", extra: true } },
      }),
      [
        "continuity.intentClassifier.supersession.verification.extra is not a field",
        'continuity.intentClassifier.supersession.verification.model must be "provider/id" or null',
      ],
    );
  });

  it("rejects a policy with no source for the intent kind", () => {
    const expected = [
      "continuity.intentClassifier has no source for the intent kind: set kind.model or leave heuristics on",
    ];
    assert.deepEqual(problems({ heuristics: false }), expected);
    assert.deepEqual(
      problems({
        preset: "recommended",
        heuristics: false,
        kind: { model: null },
      }),
      expected,
    );
    assert.ok(
      parseIntentPolicyObject({ preset: "recommended", heuristics: false }).ok,
    );
  });
});

describe("resolveIntentPolicy", () => {
  it("resolves the preset: microsoft for both questions, luna to escalate, heuristics on", () => {
    assert.deepEqual(resolveIntentPolicy("recommended"), {
      heuristics: true,
      kind: { model: MICROSOFT },
      supersession: { model: MICROSOFT },
      escalation: { model: LUNA },
      verification: { model: MICROSOFT },
    });
  });

  const object = (setting: object) =>
    resolveIntentPolicy(JSON.stringify(setting));

  it("applies object fields over the preset, and over nothing without one", () => {
    assert.deepEqual(
      object({
        preset: "recommended",
        minConfidence: 0.6,
        kind: { instructions: "Kind." },
        supersession: { model: null, escalation: { model: "acme/judge" } },
      }),
      {
        heuristics: true,
        minConfidence: 0.6,
        kind: { model: MICROSOFT, instructions: "Kind." },
        supersession: { model: null },
        escalation: { model: "acme/judge" },
        verification: { model: MICROSOFT },
      },
    );
    assert.deepEqual(
      object({
        preset: "recommended",
        supersession: {
          verification: { model: null, instructions: "Check." },
        },
      })?.verification,
      { model: null, instructions: "Check." },
    );
    assert.equal(
      object({
        preset: "recommended",
        supersession: { verification: { model: "openrouter/acme/judge" } },
      })?.verification.model,
      "openrouter/acme/judge",
    );
    assert.deepEqual(object({ kind: { model: "acme/judge" } }), {
      heuristics: true,
      kind: { model: "acme/judge" },
      supersession: { model: null },
      escalation: { model: null },
      verification: { model: null },
    });
  });

  it("a provider/id is one model for both questions with no escalation", () => {
    assert.deepEqual(resolveIntentPolicy("typesafe/jev-1.14"), {
      heuristics: true,
      kind: { model: "typesafe/jev-1.14" },
      supersession: { model: "typesafe/jev-1.14" },
      escalation: { model: null },
      verification: { model: null },
    });
  });

  it("resolves nothing for malformed text", () => {
    for (const text of ["", "no-slash", "{", '{"kind":5}', "[]", "off"]) {
      assert.equal(resolveIntentPolicy(text), undefined);
    }
  });
});
