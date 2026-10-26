import * as assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { loadTreeNavigatorConfig } from "./config.ts";
import {
  mergeProposalOptions,
  parseProposalModel,
  parseProposalOptions,
} from "./proposal-options.ts";

describe("tree proposal options", () => {
  it("parses model and thinking independently without guessing a model", () => {
    assert.equal(parseProposalModel("current"), undefined);
    assert.deepEqual(parseProposalModel("test/model:high"), {
      provider: "test",
      id: "model",
      thinking: "high",
    });
    assert.deepEqual(parseProposalModel("test/organization/model"), {
      provider: "test",
      id: "organization/model",
    });
    for (const value of [
      "model",
      "/model",
      "test/",
      "test/model:unknown",
      "test/model:",
      "test /model",
    ])
      assert.throws(() => parseProposalModel(value));
  });

  it("merges disclosure rules per exact tool name and permits an explicit current-model reset", () => {
    assert.deepEqual(
      mergeProposalOptions(
        parseProposalOptions({
          model: "test/model:high",
          tools: { bash: "calls-only", read: "omit" },
        }),
        parseProposalOptions({ model: "current", tools: { bash: "full" } }),
      ),
      { model: "current", tools: { bash: "full", read: "omit" } },
    );
    for (const value of [
      { tools: { bash: "calls" } },
      { tool: {} },
      { tools: ["bash"] },
      { model: null },
      { tools: { "": "omit" } },
    ])
      assert.throws(() => parseProposalOptions(value));
  });

  it("honors trusted config layers and blocks malformed disclosure rules", async () => {
    const readFile = async (path: string) =>
      JSON.stringify(
        path === "/global/tree-navigator.json"
          ? {
              treeProposal: {
                model: "test/model:high",
                tools: { read: "omit" },
              },
            }
          : { treeProposal: { tools: { bash: "calls-only" } } },
      );
    const opts = {
      agentDir: "/global",
      projectPath: "/project/tree-navigator.json",
      readFile,
    };
    const trusted = await loadTreeNavigatorConfig({
      ...opts,
      projectTrusted: true,
    });
    assert.deepEqual(trusted.config.proposal, {
      model: "test/model:high",
      tools: { read: "omit", bash: "calls-only" },
    });
    const untrusted = await loadTreeNavigatorConfig({
      ...opts,
      projectTrusted: false,
    });
    assert.deepEqual(untrusted.config.proposal, {
      model: "test/model:high",
      tools: { read: "omit" },
    });
    const invalid = await loadTreeNavigatorConfig({
      ...opts,
      projectTrusted: true,
      readFile: async () =>
        JSON.stringify({ treeProposal: { tools: { read: "omti" } } }),
    });
    assert.equal(invalid.config.proposal, undefined);
    assert.match(invalid.config.proposalError ?? "", /read/);
    assert.ok(invalid.warnings.every((warning) => warning.includes("blocked")));
  });
});
