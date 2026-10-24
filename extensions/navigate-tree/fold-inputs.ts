import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  type ProjectedSessionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { FoldSegmentRecord } from "./fold-summarizer.ts";
import { projectHandoffs } from "./handoff-projection.ts";

type Blocks = string | readonly (TextContent | ImageContent)[];

function imagePlaceholder(image: ImageContent): string {
  return `[image omitted: ${image.mimeType}, ${Math.ceil((image.data.length * 3) / 4)} bytes]`;
}

function blocksText(content: Blocks): string {
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      block.type === "text" ? block.text : imagePlaceholder(block),
    )
    .join("\n");
}

type RecordBody = Pick<FoldSegmentRecord, "role" | "text">;

function recordBody(
  message: AgentMessage,
  source: SessionEntry,
): RecordBody | undefined {
  const [llm] = convertToLlm([message]);
  if (!llm) return undefined;
  const text = llm.role === "user" ? blocksText(llm.content) : "";
  switch (message.role) {
    case "user":
    case "bashExecution":
      return { role: "user", text };
    case "branchSummary":
    case "compactionSummary":
      return { role: "summary", text };
    case "custom":
      if (source.type === "branch_summary") return { role: "summary", text };
      return message.display ? { role: "custom", text } : undefined;
    case "assistant":
      return {
        role: "assistant",
        text: message.content
          .flatMap((block) =>
            block.type === "text"
              ? [block.text]
              : block.type === "toolCall"
                ? [
                    `[tool call ${block.name}] ${JSON.stringify(block.arguments)}`,
                  ]
                : [],
          )
          .join("\n"),
      };
    case "toolResult": {
      const body = blocksText(message.content);
      return {
        role: "tool",
        text: `[result of ${message.toolName}${message.isError ? ", error" : ""}]${body ? `\n${body}` : " (empty)"}`,
      };
    }
    default:
      return undefined;
  }
}

function entryRecords(entry: ProjectedSessionEntry): FoldSegmentRecord[] {
  const bodies = entry.messages.flatMap((message) => {
    const body = recordBody(message, entry.sourceEntry);
    return body?.text.trim() ? [body] : [];
  });
  return bodies.map((body, index) => ({
    id:
      bodies.length === 1
        ? entry.sourceEntry.id
        : `${entry.sourceEntry.id}.${index + 1}`,
    ...body,
  }));
}

/** Current canonical context restricted to the selected fold point ancestry. */
export function buildFoldProjection(
  entries: SessionEntry[],
  leafId: string,
  throughId = leafId,
) {
  const projection = projectHandoffs(
    buildSessionProjection(entries, leafId),
    entries,
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ancestry = new Set<string>();
  let id: string | null = throughId;
  while (id !== null) {
    if (ancestry.has(id)) throw new Error("cyclic fold ancestry");
    ancestry.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error("missing fold ancestry");
    id = entry.parentId;
  }
  const restricted = projection.entries.filter((entry) =>
    ancestry.has(entry.sourceEntry.id),
  );
  return {
    ...projection,
    entries: restricted,
    messages: restricted.flatMap((entry) => entry.messages),
  };
}

/**
 * The collapsed segment as the model saw it: the anchor's descendants on the
 * branch to `leafId`, after context edits, compaction and handoff projection.
 * `throughId` excludes later input without discarding later edits to the work.
 * Records keep their full text (images become a placeholder naming what was
 * omitted, thinking blocks are not evidence) and hidden custom messages are
 * skipped; summarizing splits oversized records. A `targetId` that the
 * projection no longer carries (older than the latest compaction) makes every
 * visible message collapsed evidence.
 *
 * `background` is the newest child handoff before the target, or empty: one
 * report bounds the context repeated in every extraction call while still
 * telling the summarizer what the collapsed work builds on.
 */
export function buildFoldSegment(
  entries: SessionEntry[],
  leafId: string,
  targetId: string,
  throughId = leafId,
): { background: string; records: FoldSegmentRecord[] } {
  const projected = buildFoldProjection(entries, leafId, throughId).entries;
  const at = projected.findIndex((entry) => entry.sourceEntry.id === targetId);
  const handoff = projected
    .slice(0, at + 1)
    .findLast(
      (entry) =>
        entry.sourceEntry.type === "branch_summary" &&
        entry.messages.length > 0,
    );
  const background =
    handoff?.messages
      .flatMap((message) => {
        const body = recordBody(message, handoff.sourceEntry);
        return body ? [body.text] : [];
      })
      .join("\n\n") ?? "";
  return {
    background,
    records: projected.slice(at + 1).flatMap(entryRecords),
  };
}

/**
 * Consolidation evidence: every projected record before `firstKeptId`, the
 * latest compaction summary and older handoffs included, so a new compaction
 * replaces them without losing what the previous one kept. Empty when the
 * projection does not carry `firstKeptId`.
 */
export function buildConsolidationSegment(
  entries: SessionEntry[],
  leafId: string,
  firstKeptId: string,
): FoldSegmentRecord[] {
  const projected = buildFoldProjection(entries, leafId).entries;
  const at = projected.findIndex(
    (entry) => entry.sourceEntry.id === firstKeptId,
  );
  return at < 0 ? [] : projected.slice(0, at).flatMap(entryRecords);
}

/**
 * Index in `projection.messages` of the anchor's last message, or -1 when the
 * projection no longer carries the anchor.
 */
export function anchorMessageIndex(
  projection: { entries: readonly ProjectedSessionEntry[] },
  targetId: string,
): number {
  let count = 0;
  for (const entry of projection.entries) {
    count += entry.messages.length;
    if (entry.sourceEntry.id === targetId) return count - 1;
  }
  return -1;
}

/**
 * True when the provider's serializer will send this message. Adapters skip
 * assistant messages without text, thinking or tool calls, so such a message
 * must not consume a message number. Unknown block types count as visible.
 */
function isProviderVisible(message: Message): boolean {
  if (message.role !== "assistant") return true;
  const content: unknown = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return true;
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const entry = block as { [key: string]: unknown };
    if (entry.type === "text") {
      if (typeof entry.text === "string" && entry.text.trim().length > 0)
        return true;
    } else if (entry.type === "thinking") {
      const { thinking, thinkingSignature } = entry;
      if (
        (typeof thinking === "string" && thinking.trim().length > 0) ||
        (typeof thinkingSignature === "string" &&
          thinkingSignature.trim().length > 0) ||
        entry.redacted === true
      )
        return true;
    } else if (entry.type !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * The live request up to the leaf for Strategy A: the captured system messages
 * followed by the projected transcript. `first` is the 1-based number of the
 * first collapsed message as the summary instruction counts them: system
 * messages and provider-invisible assistants do not consume a number, and
 * `targetIndex` (see {@link anchorMessageIndex}) ends the background.
 */
export function buildInContextMessages(
  systemMessages: readonly Message[],
  projectedMessages: AgentMessage[],
  targetIndex: number,
): { messages: Message[]; first: number } {
  const background = convertToLlm(
    targetIndex < 0 ? [] : projectedMessages.slice(0, targetIndex + 1),
  );
  return {
    messages: [...systemMessages, ...convertToLlm(projectedMessages)],
    first:
      background.filter(
        (message) => message.role !== "system" && isProviderVisible(message),
      ).length + 1,
  };
}
