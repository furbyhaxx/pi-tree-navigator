#!/usr/bin/env node
import { resolve } from "node:path";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
} from "../extensions/navigate-tree/retrospective.ts";
import { inspectRetrospectiveSession } from "../extensions/navigate-tree/retrospective-plan.ts";

const usage = `Usage:
  node scripts/restructure-session.mjs inspect <session.jsonl>
  node scripts/restructure-session.mjs preview <plan.json>
  node scripts/restructure-session.mjs create <plan.json> <preview-token>

Inspect prints stable user-turn IDs and the source SHA-256.
Preview validates the entire plan without writing a session.
Create publishes a new session family; source files are never changed.
Descendant histories are copied unchanged unless the plan opts into recurse
and supplies reviewed descendantPlans. Review the complete family preview.
Review every handoff before using the preview token. No model calls are made.`;

const [action, path, token, ...extra] = process.argv.slice(2);
try {
  if (!action || action === "--help" || action === "-h") {
    console.log(usage);
  } else {
    if (!path || extra.length || (action !== "create" && token))
      throw new Error(usage);
    let result;
    switch (action) {
      case "inspect":
        result = await inspectRetrospectiveSession(resolve(path));
        break;
      case "preview":
        result = await previewRetrospectiveSession(resolve(path));
        break;
      case "create":
        if (!token)
          throw new Error(
            `Create requires the token from a reviewed preview.\n${usage}`,
          );
        result = await cloneRetrospectiveSession(resolve(path), token);
        break;
      default:
        throw new Error(`Unknown action: ${action}\n${usage}`);
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
