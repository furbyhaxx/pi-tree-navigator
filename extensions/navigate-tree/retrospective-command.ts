import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
} from "./retrospective.ts";
import { inspectRetrospectiveSession } from "./retrospective-plan.ts";

const USAGE =
  "Usage: /tree-clone [inspect <session.jsonl>|preview <plan.json>|create <plan.json>]";

const SUBCOMMANDS = [
  { name: "inspect", path: "<session.jsonl>", summary: "inspect a session" },
  { name: "preview", path: "<plan.json>", summary: "review a clone plan" },
  { name: "create", path: "<plan.json>", summary: "create a confirmed clone" },
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number]["name"];

function parsePathArgument(rawPath: string): string | undefined {
  const value = rawPath.trim();
  if (!value) return undefined;

  const startsQuoted = value.startsWith('"') || value.startsWith("'");
  const endsQuoted = value.endsWith('"') || value.endsWith("'");
  if (startsQuoted || endsQuoted) {
    const quote = value[0];
    if (
      value.length < 2 ||
      (quote !== '"' && quote !== "'") ||
      value.at(-1) !== quote
    ) {
      throw new Error(`Path quotes must match. ${USAGE}`);
    }
    return value.slice(1, -1) || undefined;
  }

  return value;
}

async function getPath(
  subcommand: Subcommand,
  rawPath: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const providedPath = rawPath ? parsePathArgument(rawPath) : undefined;
  if (providedPath) return resolve(ctx.cwd, providedPath);

  if (subcommand === "inspect") {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) return resolve(ctx.cwd, sessionFile);
    throw new Error(
      `No current session file is available. Provide a session path. ${USAGE}`,
    );
  }

  if (!ctx.hasUI) {
    throw new Error(`A plan path is required in headless mode. ${USAGE}`);
  }

  const label = subcommand === "preview" ? "preview" : "clone";
  const input = await ctx.ui.input(`Plan file to ${label}`, "<plan.json>");
  const promptedPath = input ? parsePathArgument(input) : undefined;
  if (!promptedPath) throw new Error(`No plan path provided. ${USAGE}`);
  return resolve(ctx.cwd, promptedPath);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notifyCreateNotIdle(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Cannot create a retrospective clone while Pi is busy. Retry when the session is idle; no session changes were made.",
    "warning",
  );
}

export function registerRetrospectiveCommand(pi: ExtensionAPI): void {
  pi.registerCommand("tree-clone", {
    description:
      "[inspect <session.jsonl>|preview <plan.json>|create <plan.json>] — inspect or create a retrospective clone",
    getArgumentCompletions(argumentText) {
      const input = argumentText.trimStart();
      if (/\s/.test(input)) return null;
      const query = input.toLowerCase();
      const matches = SUBCOMMANDS.filter((command) =>
        command.name.startsWith(query),
      );
      return matches.length
        ? matches.map((command) => ({
            value: `${command.name} `,
            label: command.name,
            description: `${command.path} — ${command.summary}`,
          }))
        : null;
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
      const subcommand = match?.[1];
      if (!SUBCOMMANDS.some((command) => command.name === subcommand)) {
        ctx.ui.notify(
          `Unknown subcommand "${subcommand}". ${USAGE}`,
          "warning",
        );
        return;
      }

      const operation = subcommand as Subcommand;
      if (operation === "create" && !ctx.hasUI) {
        ctx.ui.notify(
          "Creating a retrospective clone requires a UI confirmation. Run `node scripts/restructure-session.mjs` to create clones from the CLI.",
          "warning",
        );
        return;
      }
      if (operation === "create" && !ctx.isIdle()) {
        notifyCreateNotIdle(ctx);
        return;
      }

      try {
        const path = await getPath(operation, match?.[2], ctx);
        if (operation === "inspect") {
          const inspected = await inspectRetrospectiveSession(path);
          if (ctx.hasUI) {
            await ctx.ui.editor(
              "Retrospective session inspection (read-only)",
              JSON.stringify(inspected, null, 2),
            );
            ctx.ui.notify(
              `Inspected "${inspected.name}": ${inspected.entries} entries and ${inspected.turns.length} user turns.`,
              "info",
            );
          } else {
            ctx.ui.notify(
              `Inspected "${inspected.name}": ${inspected.entries} entries and ${inspected.turns.length} user turns. Rerun /tree-clone inspect <session.jsonl> in a UI-capable Pi session to view the full JSON.`,
              "info",
            );
          }
          return;
        }

        const preview = await previewRetrospectiveSession(path);
        const warningNote = preview.warnings.length
          ? `, ${preview.warnings.length} warning(s)`
          : "";
        const summary = `Preview for "${preview.name}": ${preview.groups.length} groups and ${preview.addedEntries} added entries${warningNote}.`;
        if (operation === "preview") {
          if (ctx.hasUI) {
            await ctx.ui.editor(
              "Retrospective clone preview (read-only)",
              JSON.stringify(preview, null, 2),
            );
            ctx.ui.notify(summary, "info");
          } else {
            ctx.ui.notify(
              `${summary} Rerun /tree-clone preview <plan.json> in a UI-capable Pi session to review the full preview.`,
              "info",
            );
          }
          return;
        }

        await ctx.ui.editor(
          "Retrospective clone preview (read-only)",
          JSON.stringify(preview, null, 2),
        );
        const confirmed = await ctx.ui.confirm(
          `Create clone "${preview.name}"?`,
          `Create a new session from ${preview.source}? The original session will remain untouched.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Clone cancelled; no files were written.", "info");
          return;
        }
        if (!ctx.isIdle()) {
          notifyCreateNotIdle(ctx);
          return;
        }

        const clone = await cloneRetrospectiveSession(
          path,
          preview.previewToken,
        );
        ctx.ui.notify(
          `Created clone "${clone.name}" at ${clone.path}. The original session was left untouched.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorText(error), "warning");
      }
    },
  });
}
