import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { showView } from "./clone-screen.ts";
import {
  entryIndex,
  formatCreateConfirmation,
  formatInspect,
  formatPreview,
  inspectBadge,
  planTitles,
  previewBadge,
  type ViewContext,
} from "./clone-views.ts";
import { handleTreeProposal } from "./proposal-command.ts";
import {
  cloneRetrospectiveSession,
  previewRetrospectiveSession,
  type RetrospectivePreview,
} from "./retrospective.ts";
import {
  inspectRetrospectiveSession,
  readRetrospectivePlan,
  readSessionSnapshot,
} from "./retrospective-plan.ts";

export const CLONE_USAGE =
  "Usage: /anchor clone [inspect <session.jsonl>|propose [session.jsonl] [--llm] [--model provider/model:thinking] [--output plan.json] [--omit-tool name] [--calls-only-tool name] [--full-tool name]|preview <plan.json>|create <plan.json>]";

export const CLONE_PROPOSE_FLAGS = [
  "--llm",
  "--model",
  "--output",
  "--omit-tool",
  "--calls-only-tool",
  "--full-tool",
] as const;

export const CLONE_SUBCOMMANDS = [
  { name: "inspect", path: "<session.jsonl>", summary: "inspect a session" },
  {
    name: "propose",
    path: "[session.jsonl] [--llm] [--model provider/model:thinking]",
    summary: "derive a reviewable tree plan",
  },
  { name: "preview", path: "<plan.json>", summary: "review a clone plan" },
  { name: "create", path: "<plan.json>", summary: "create a confirmed clone" },
] as const;

type Subcommand = (typeof CLONE_SUBCOMMANDS)[number]["name"];

function parsePathArgument(
  rawPath: string,
  subcommand: Subcommand,
): string | undefined {
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
      throw new Error(`Path quotes must match. ${CLONE_USAGE}`);
    }
    return value.slice(1, -1) || undefined;
  }

  // Unquoted paths may contain spaces; an option token there is a mistake, not part of the name.
  const option = value.split(/\s+/).find((token) => token.startsWith("--"));
  if (option) {
    throw new Error(
      `/anchor clone ${subcommand} takes no options (got "${option}"); only propose accepts options. Quote a path that contains "--". ${CLONE_USAGE}`,
    );
  }
  return value;
}

async function getPath(
  subcommand: Subcommand,
  rawPath: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string> {
  const providedPath = rawPath
    ? parsePathArgument(rawPath, subcommand)
    : undefined;
  if (providedPath) return resolve(ctx.cwd, providedPath);

  if (subcommand === "inspect") {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) return resolve(ctx.cwd, sessionFile);
    throw new Error(
      `No current session file is available. Provide a session path. ${CLONE_USAGE}`,
    );
  }

  if (!ctx.hasUI) {
    throw new Error(`A plan path is required in headless mode. ${CLONE_USAGE}`);
  }

  const label = subcommand === "preview" ? "preview" : "clone";
  const input = await ctx.ui.input(`Plan file to ${label}`, "<plan.json>");
  const promptedPath = input ? parsePathArgument(input, subcommand) : undefined;
  if (!promptedPath) throw new Error(`No plan path provided. ${CLONE_USAGE}`);
  return resolve(ctx.cwd, promptedPath);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Entry counts and group titles for a preview; best effort, the preview reads fine without them. */
async function previewContext(
  planPath: string,
  preview: RetrospectivePreview,
): Promise<ViewContext> {
  try {
    const [plan, snapshot] = await Promise.all([
      readRetrospectivePlan(planPath),
      readSessionSnapshot(preview.source),
    ]);
    return {
      entryIndex: entryIndex(snapshot.entries),
      titles: planTitles(plan),
    };
  } catch {
    return {};
  }
}

/** The preview screen; Enter continues, Escape leaves, `j` shows the raw JSON. */
function showPreview(
  ctx: ExtensionCommandContext,
  preview: RetrospectivePreview,
  context: ViewContext,
  actions: { enter: string; cancel: string },
): Promise<string | undefined> {
  return showView(
    ctx,
    {
      breadcrumbs: ["Anchor", "Clone", "Preview"],
      rightBadge: previewBadge(preview),
      enterAction: actions.enter,
      cancelAction: actions.cancel,
      lines: (width) => formatPreview(preview, width, context),
    },
    { title: "Retrospective clone preview (read-only)", value: preview },
  );
}

function notifyCreateNotIdle(ctx: ExtensionCommandContext): void {
  ctx.ui.notify(
    "Cannot create a retrospective clone while Pi is busy. Retry when the session is idle; no session changes were made.",
    "warning",
  );
}

/** Run `/anchor clone <args>`: read-only inspection, proposal dispatch, preview and confirmed creation without switching sessions. */
export async function runCloneSubcommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    ctx.ui.notify(CLONE_USAGE, "info");
    return;
  }

  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const subcommand = match?.[1];
  if (!CLONE_SUBCOMMANDS.some((command) => command.name === subcommand)) {
    ctx.ui.notify(
      `Unknown subcommand "${subcommand}". ${CLONE_USAGE}`,
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
    if (operation === "propose") {
      await handleTreeProposal(match?.[2] ?? "", ctx, pi);
      return;
    }
    const path = await getPath(operation, match?.[2], ctx);
    if (operation === "inspect") {
      const inspected = await inspectRetrospectiveSession(path);
      if (ctx.hasUI) {
        await showView(
          ctx,
          {
            breadcrumbs: ["Anchor", "Clone", "Inspect"],
            rightBadge: inspectBadge(inspected),
            enterAction: "close",
            cancelAction: "back",
            lines: (width) => formatInspect(inspected, width),
          },
          {
            title: "Retrospective session inspection (read-only)",
            value: inspected,
          },
        );
        ctx.ui.notify(
          `Inspected "${inspected.name}": ${inspected.entries} entries and ${inspected.turns.length} user turns.`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Inspected "${inspected.name}": ${inspected.entries} entries and ${inspected.turns.length} user turns. Rerun /anchor clone inspect <session.jsonl> in a UI-capable Pi session to browse the full inspection.`,
          "info",
        );
      }
      return;
    }

    const preview = await previewRetrospectiveSession(path);
    const warningNote = preview.warnings.length
      ? `, ${preview.warnings.length} warning(s)`
      : "";
    const summary = `Preview for "${preview.name}": ${preview.groups.length} groups, ${preview.addedEntries} added entries and ${preview.descendants.length} descendant sessions${warningNote}.`;
    if (operation === "preview") {
      if (ctx.hasUI) {
        await showPreview(ctx, preview, await previewContext(path, preview), {
          enter: "close",
          cancel: "back",
        });
        ctx.ui.notify(summary, "info");
      } else {
        ctx.ui.notify(
          `${summary} Rerun /anchor clone preview <plan.json> in a UI-capable Pi session to review the full preview.`,
          "info",
        );
      }
      return;
    }

    const reviewed = await showPreview(
      ctx,
      preview,
      await previewContext(path, preview),
      { enter: "continue", cancel: "cancel" },
    );
    const confirmed =
      reviewed !== undefined &&
      (await ctx.ui.confirm(
        `Create clone "${preview.name}"?`,
        formatCreateConfirmation(preview),
      ));
    if (!confirmed) {
      ctx.ui.notify("Clone cancelled; no files were written.", "info");
      return;
    }
    if (!ctx.isIdle()) {
      notifyCreateNotIdle(ctx);
      return;
    }

    const clone = await cloneRetrospectiveSession(path, preview.previewToken);
    ctx.ui.notify(
      `Created clone "${clone.name}" at ${clone.path}, with ${clone.descendants.length} descendant sessions. The original session was left untouched.${clone.warnings.length ? ` ${clone.warnings.join(" ")}` : ""}`,
      clone.warnings.length ? "warning" : "info",
    );
  } catch (error) {
    ctx.ui.notify(errorText(error), "warning");
  }
}
