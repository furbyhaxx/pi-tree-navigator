import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable facts the synthetic handoff must retain. */
export const FACTS = [
  "Acceptance objective: finish the synthetic service audit, not a production rollout.",
  "Never deploy or delete service data during this audit.",
  "Keep the existing public response codes unchanged.",
  "Completed: audited service configuration and retry boundaries.",
  "Remaining: compare the archived audit with the next supplied change.",
] as const;

/** Builds varied synthetic configuration evidence; no workspace or user files are read. */
export function buildCorpus(blocks: number): string[] {
  if (!Number.isInteger(blocks) || blocks < 1 || blocks > 256)
    throw new Error("blocks must be an integer from 1 to 256");
  return Array.from({ length: blocks }, (_, block) => {
    const services = Array.from({ length: 24 }, (_, item) => {
      const id = block * 24 + item;
      return {
        service: `synthetic-service-${id}`,
        listener: { host: "127.0.0.1", port: 10000 + id },
        request: {
          timeoutMs: 1000 + (id % 9) * 250,
          maxBytes: 65536 + id * 16,
        },
        retry: { attempts: 1 + (id % 3), backoffMs: 50 + (id % 7) * 25 },
        persistence: { namespace: `audit-${id}`, retentionDays: 7 + (id % 14) },
        validation: {
          invalidInput: 422,
          unavailable: 503,
          duplicate: 409,
          tests: [
            `service-${id}-invalid-input`,
            `service-${id}-retry-exhausted`,
          ],
        },
        finding: `Service ${id} validates input before persistence; verify retry exhaustion leaves namespace audit-${id} unchanged.`,
      };
    });
    return `Synthetic audit block ${block + 1}\n${FACTS.join("\n")}\n${JSON.stringify(services, null, 2)}`;
  });
}

/** Records fixture provenance without treating synthetic messages as observed model output. */
export function corpusManifest(corpus: readonly string[]) {
  return corpus.map((text, index) => ({
    index,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  }));
}

/** Seed an explicitly synthetic completed history and a real persisted anchor. */
export function seedCorpus(
  sm: SessionManager,
  corpus: readonly string[],
): void {
  sm.appendMessage({ role: "user", content: FACTS.join("\n"), timestamp: 1 });
  const anchor = sm.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Synthetic fixture: audit begins." }],
    api: "openai-completions",
    provider: "fixture",
    model: "synthetic",
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  sm.appendLabelChange(anchor, "anchor:audit-start");
  for (const [index, text] of corpus.entries()) {
    sm.appendMessage({ role: "user", content: text, timestamp: 3 + index * 2 });
    sm.appendMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Synthetic fixture conclusion for block ${index + 1}: inspected, retain the audit constraints and remaining comparison work.`,
        },
      ],
      api: "openai-completions",
      provider: "fixture",
      model: "synthetic",
      stopReason: "stop",
      timestamp: 4 + index * 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
  }
}
