#!/usr/bin/env node
import { resolve, join } from "node:path";
import {
  buildSessionContext,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { loadTreeNavigatorConfig, TREE_NAVIGATOR_CONFIG_FILENAME } from "../extensions/navigate-tree/config.ts";
import { parseProposalArguments, saveTreeProposal, formatProposalOutline, validateTreeProposal } from "../extensions/navigate-tree/proposal-command.ts";
import { proposeTree } from "../extensions/navigate-tree/proposal-engine.ts";
import { createProposalModelRunner, resolveProposalModel } from "../extensions/navigate-tree/proposal-model.ts";
import { mergeProposalOptions } from "../extensions/navigate-tree/proposal-options.ts";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
} from "../extensions/navigate-tree/retrospective.ts";
import { inspectRetrospectiveSession, readSessionSnapshot, validateCompleteToolCalls } from "../extensions/navigate-tree/retrospective-plan.ts";

const usage = `Usage:
  node scripts/restructure-session.mjs inspect <session.jsonl>
  node scripts/restructure-session.mjs propose <session.jsonl> [--llm] [--model provider/model:thinking] [--output plan.json]
    [--omit-tool name] [--calls-only-tool name] [--full-tool name]
  node scripts/restructure-session.mjs preview <plan.json>
  node scripts/restructure-session.mjs create <plan.json> <preview-token>

Inspect prints graph metadata, stable IDs and the source SHA-256.
Propose derives a heuristic tree locally. --llm or --model explicitly authorizes
provider requests using all permitted textual history; long inputs need multiple
requests. --output saves a NEW private plan; existing files are never overwritten.
CLI model selection defaults to global treeProposal.model, then the source's
recorded model/thinking. Project config is not trusted/read by this offline CLI;
use command flags for project-specific model and disclosure rules.
Preview validates the entire plan without writing a session.
Create publishes a new session family; source files are never changed.
Descendant histories are copied unchanged unless the plan opts into recurse
and supplies reviewed descendantPlans. Review every handoff and family preview.
Inspect, heuristic proposals, preview and create make no model calls.`;

const [action, ...args] = process.argv.slice(2);
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
try {
  if (!action || action === "--help" || action === "-h") console.log(usage);
  else {
    let result;
    if (action === "propose") {
      const parsed = parseProposalArguments(args);
      if (!parsed.source) throw new Error(`Propose requires a session path.\n${usage}`);
      const snapshot = await readSessionSnapshot(resolve(parsed.source));
      validateCompleteToolCalls(snapshot);
      const loaded = await loadTreeNavigatorConfig({ agentDir: getAgentDir(), projectPath: join(process.cwd(), ".pi", TREE_NAVIGATOR_CONFIG_FILENAME), projectTrusted: false });
      for (const warning of loaded.warnings) console.error(warning);
      if (parsed.llm && loaded.config.proposalError) throw new Error(loaded.config.proposalError);
      const input = mergeProposalOptions(loaded.config.proposal ?? { tools: {} }, parsed.input);
      let model;
      if (parsed.llm) {
        const registry = new ModelRegistry(await ModelRuntime.create({ allowModelNetwork: false, signal: controller.signal }));
        const state = buildSessionContext(snapshot.entries);
        const currentModel = state.model ? registry.find(state.model.provider, state.model.modelId) : undefined;
        model = createProposalModelRunner({ registry, ...resolveProposalModel({ registry, currentModel, currentThinking: state.thinkingLevel, selector: input.model }) });
        console.error(`Analyzing full permitted textual history with ${model.name}; provider charges may apply.`);
      }
      const proposal = validateTreeProposal(snapshot, await proposeTree(snapshot, { input, model, signal: controller.signal, onProgress: (message) => console.error(message) }));
      const planPath = parsed.output ? await saveTreeProposal(snapshot, proposal.plan, resolve(parsed.output)) : undefined;
      result = { ...proposal, outline: formatProposalOutline(proposal.plan), ...(planPath ? { planPath } : {}) };
    } else {
      const [path, token, ...extra] = args;
      if (!path || extra.length || (action !== "create" && token)) throw new Error(usage);
      switch (action) {
        case "inspect": result = await inspectRetrospectiveSession(resolve(path)); break;
        case "preview": result = await previewRetrospectiveSession(resolve(path)); break;
        case "create":
          if (!token) throw new Error(`Create requires the token from a reviewed preview.\n${usage}`);
          result = await cloneRetrospectiveSession(resolve(path), token); break;
        default: throw new Error(`Unknown action: ${action}\n${usage}`);
      }
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", abort);
}
