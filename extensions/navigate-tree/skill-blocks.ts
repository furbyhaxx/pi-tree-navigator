import { parseSkillBlock } from "@earendil-works/pi-coding-agent";

/**
 * The part of a user message the user wrote. Pi expands `/skill:<name>` into a
 * leading `<skill name=… location=…>…</skill>` block followed by the user's own
 * text; the block is file content, not user intent.
 */
export function userAuthoredText(text: string): {
  text: string;
  skill?: { name: string; location: string };
} {
  const parsed = parseSkillBlock(text);
  if (!parsed) return { text };
  return {
    text: parsed.userMessage ?? "",
    skill: { name: parsed.name, location: parsed.location },
  };
}

/** A user message with any expanded skill body replaced by a one-line reference to its file. */
export function withoutSkillBody(text: string): string {
  const { text: own, skill } = userAuthoredText(text);
  if (!skill) return text;
  const reference = `[skill "${skill.name}" was attached from ${skill.location}; its content is not repeated here, re-read that file if needed]`;
  return own ? `${reference}\n\n${own}` : reference;
}
