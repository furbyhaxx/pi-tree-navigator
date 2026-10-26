/** Parameter schema and pinnable kinds for navigate_tree. */

import { Type } from "typebox";
import { MAX_ITEM_TEXT_CHARS } from "../continuity/continuity-ledger-model.ts";
import { MAX_NAME_LENGTH } from "../core/helpers.ts";
import { MIN_SUMMARY_FOCUS_LENGTH } from "../fold/fold-policy.ts";

/** Kinds the agent may pin; rules and the objective are the user's alone. */
export const PIN_KINDS = ["sub-goal", "decision", "fact", "file", "steering"] as const;
type PinKind = (typeof PIN_KINDS)[number];
export const isPinKind = (kind: unknown): kind is PinKind => PIN_KINDS.includes(kind as PinKind);

/** Builds the flat schema supported by the tool adapters. */
export function createNavigateTreeParameters() {
	// The schema is intentionally a flat `Type.Object` with everything-but-
	// `action` optional, with action-conditional required-ness enforced at
	// runtime in `execute`. Discriminated unions / property-level required-
	// when-action shapes break the Kiro/CodeWhisperer adapter, which forwards
	// `inputSchema.json` verbatim and 400s on non-`type: "object"` roots.
	// The runtime guards in `execute` provide the conditional-required
	// behavior the schema can't express.
	return Type.Object({
		action: Type.Union(
			[Type.Literal("anchor"), Type.Literal("rewind"), Type.Literal("list"), Type.Literal("pin")],
			{
				description: "Which operation to perform.",
			},
		),
		name: Type.Optional(
			Type.String({
				description: `Required when action='anchor'. Kebab-case milestone label, max ${MAX_NAME_LENGTH} chars.`,
			}),
		),
		rewindTo: Type.Optional(
			Type.String({
				description: `Required when action='rewind'. Kebab-case name of an existing anchor on the active branch to rewind to.`,
			}),
		),
		newLabel: Type.Optional(
			Type.String({
				description: `Required when action='rewind'. Kebab-case label for the resulting branch_summary entry; reusable as a future rewindTo.`,
			}),
		),
		summaryFocus: Type.Optional(
			Type.String({
				description: `Required when action='rewind'; ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim. Encode: (1) the user's most recent instruction verbatim, (2) what's done in the collapsed segment, (3) what's left to do as a next action; if the user authorized continuing, name the next work item, not a report or wrap-up.`,
			}),
		),
		kind: Type.Optional(
			Type.Union(
				PIN_KINDS.map((kind) => Type.Literal(kind)),
				{
					description: `Required when action='pin'. Your sub-goal, a decision you made, a key fact, a file pointer, or steering that lapses when its anchor is folded.`,
				},
			),
		),
		text: Type.Optional(
			Type.String({
				description: `Required when action='pin' unless kind='file'. What to remember, max ${MAX_ITEM_TEXT_CHARS} chars.`,
			}),
		),
		path: Type.Optional(
			Type.String({
				description: `Required when action='pin' and kind='file'. File path.`,
			}),
		),
		lines: Type.Optional(
			Type.String({
				description: `Optional with kind='file': N or N-M.`,
			}),
		),
		why: Type.Optional(
			Type.String({
				description: `Required when action='pin' and kind='file'. Why the file matters.`,
			}),
		),
		scopeAnchor: Type.Optional(
			Type.String({
				description: `Anchor name for kind='steering' (default: newest anchor); optional for 'sub-goal'.`,
			}),
		),
	});
}
