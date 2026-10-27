/** navigate_tree definition and action dispatch, without registration. */

import { normalize } from "node:path";
import {
	collectEntriesForBranchSummary,
	type ExtensionAPI,
	type SessionEntry,
	type SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isVisible, renderBriefing } from "../continuity/continuity-briefing.ts";
import { type LedgerOp, MAX_ITEM_TEXT_CHARS } from "../continuity/continuity-ledger-model.ts";
import { applyOps } from "../continuity/continuity-ledger-reducer.ts";
import {
	appendOpsEntry,
	readBranchLedger,
	userEntryIndexOf,
} from "../continuity/continuity-store.ts";
import {
	activeAnchorNames,
	buildMinSavingsRejection,
	collectActiveAnchors,
	findLabelHint,
	hashPinnedFile,
	isFilled,
	resolveAnchorTarget,
} from "../core/anchors.ts";
import {
	type AnchorTableRow,
	formatAnchorTable,
	formatPct1,
	formatWindow,
	isValidName,
	LABEL_PREFIX,
	MAX_NAME_LENGTH,
	TOOL_NAME,
} from "../core/helpers.ts";
import type { NavigatorState } from "../core/navigator-state.ts";
import { findOwningSession, REFLECTION_BOOTSTRAP_WARNING_LIST } from "../core/pi-internals.ts";
import { findLabeledEntry, precedesLatestCompaction } from "../core/projection.ts";
import { estimateAdmissionTokens, estimateAtEntry } from "../core/request-accounting.ts";
import type { createFoldAdaptersController } from "../fold/fold-adapters.ts";
import { MIN_SUMMARY_FOCUS_LENGTH } from "../fold/fold-policy.ts";
import { buildRewindAcceptedText, toolError } from "../fold/fold-receipts.ts";
import { renderToolCall, renderToolResult, type ToolRowState } from "../ui/tool-renderer.ts";
import { createNavigateTreeParameters, isPinKind, PIN_KINDS } from "./navigate-tree-parameters.ts";

/** Token budget of the ledger briefing appended to `list`. */
const LIST_BRIEFING_MAX_TOKENS = 500;

// Hint length cap for the hint shown in the `anchor` response. The anchor
// response is a single block of prose (not a column-aligned table) so it
// can afford a longer hint than `list`'s per-row preview.
const ANCHOR_HINT_MAX_LENGTH = 60;

/** Live configuration and operations used by the tool actions. */
export interface NavigateTreeToolDeps {
	pi: Pick<ExtensionAPI, "setLabel" | "appendEntry">;
	state: Pick<NavigatorState, "config">;
	queueFold: ReturnType<typeof createFoldAdaptersController>["queueFold"];
	minRewindSavingsTokens: number;
}

/** Builds the tool without registering it or reading replaceable configuration. */
export function createNavigateTreeTool({
	pi,
	state,
	queueFold,
	minRewindSavingsTokens: MIN_REWIND_SAVINGS_TOKENS,
}: NavigateTreeToolDeps): ToolDefinition<
	ReturnType<typeof createNavigateTreeParameters>,
	unknown,
	ToolRowState
> {
	return {
		name: TOOL_NAME,
		label: "Navigate Tree",
		// Stateful: every action mutates SessionManager; concurrent calls would
		// race on `leafId` / `labelsById` and produce an undefined tree.
		executionMode: "sequential",
		promptGuidelines: [
			`${TOOL_NAME}: when rewinding, prefer the oldest anchor that keeps what you'd otherwise re-read or re-derive; persist durable findings to files first.`,
			`${TOOL_NAME}: don't rewind while a user decision or unresolved question is pending — ask the user instead.`,
			`${TOOL_NAME}: pin durable sub-goals, decisions, facts and file pointers you must not lose across folds; the user's own rules and goals are captured automatically and cannot be pinned or changed by you.`,
		],
		description: `Long-session context management via the pi session tree. Anchor named milestones, then collapse work between them into a model-generated summary to free context.
\`rewind\` does not restore prior state: it forks a sibling branch from the anchor and continues forward from a model-generated summary.

Operations (set \`action\`):
  • 'anchor', name='<milestone-name>': label the current point. Anchor at the start of a stage you'll summarize (e.g. 'impl-start').
  • 'rewind', rewindTo='<existing>', newLabel='<new>': collapse work between rewindTo and the current leaf into a branch_summary labeled newLabel, so rewinds can chain.
  • 'list': show all anchors on the active branch, oldest first, with cumulative context % at each.
  • 'pin', kind='sub-goal'|'decision'|'fact'|'file'|'steering', text='<what to keep>': record a durable item that survives folds; \`list\` shows them. 'file' takes path+why instead of text; 'steering' belongs to an anchor (scopeAnchor, default newest). Refused when the user disabled the continuity ledger (continuity.capture=false).

\`name\` (anchor) and \`newLabel\` (rewind) write into one shared anchor namespace: labels are unique on the active branch — both actions refuse a name that already exists — and everything written there is addressable as a future \`rewindTo\`. Avoid the reserved \`${LABEL_PREFIX}\` prefix.`,
		promptSnippet:
			"Use to anchor named milestones and rewind the conversation tree to a prior point with a model-generated summary, for token-efficient long autonomous sessions. Also pins durable sub-goals, decisions, facts and file pointers that survive folds.",
		parameters: createNavigateTreeParameters(),
		renderShell: "self",
		renderCall: (args, theme, context) => renderToolCall(args, theme, context.expanded, context),
		renderResult: (result, options, theme, context) =>
			renderToolResult(result, options, theme, context.isError, context),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const sm = ctx.sessionManager as SessionManager;
			const p = params as {
				action: "anchor" | "rewind" | "list" | "pin";
				name?: string;
				rewindTo?: string;
				newLabel?: string;
				summaryFocus?: string;
				kind?: string;
				text?: string;
				path?: string;
				lines?: string;
				why?: string;
				scopeAnchor?: string;
			};

			// --- list ---
			if (p.action === "list") {
				const cw = ctx.model?.contextWindow ?? 0;
				const totalTokens = estimateAdmissionTokens(sm);
				const reflectionOk = !!findOwningSession(sm);

				const rows: AnchorTableRow[] = collectActiveAnchors(sm).map(({ name, tokens, hint }) => ({
					pct: formatPct1(tokens, cw),
					name,
					...(hint ? { after: hint } : {}),
				}));

				const reflectionWarning = reflectionOk ? "" : ` · ${REFLECTION_BOOTSTRAP_WARNING_LIST}`;
				const header = `[list] · ${rows.length} label${rows.length === 1 ? "" : "s"} · ctx ${formatPct1(totalTokens, cw)}${cw > 0 ? ` of ${formatWindow(cw)}` : ""}${reflectionWarning}`;
				const body = rows.length ? formatAnchorTable(rows, cw) : "No labels on the active branch.";
				const { ledger } = readBranchLedger(sm.getBranch());
				const ledgerText = ledger.items.some(isVisible)
					? `\n\n${renderBriefing(ledger, { maxTokens: LIST_BRIEFING_MAX_TOKENS }).text}`
					: "";
				return {
					content: [{ type: "text", text: `${header}\n\n${body}${ledgerText}` }],
					details: {
						count: rows.length,
						contextTokens: totalTokens,
						contextWindow: cw,
						reflectionOk,
					},
				};
			}

			// --- anchor ---
			if (p.action === "anchor") {
				const target = resolveAnchorTarget(sm, p.name);
				if (!target.ok) {
					if (target.problem === "invalid-name") {
						return toolError(
							`anchor requires \`name\` in kebab-case, max ${MAX_NAME_LENGTH} chars (e.g. 'impl-start').`,
						);
					}
					if (target.problem === "no-leaf") {
						return toolError("No session entries yet — nothing to anchor.");
					}
					return toolError(
						`A label '${p.name}' already exists on the active branch — labels are unique and immutable once written. Use action='list' to review the active labels, then pick a fresh name.`,
					);
				}
				const { leafId, fullLabel } = target;
				// Atomic anchor: compute the estimate BEFORE writing the label. A
				// throw from the estimator must not leave a label on disk —
				// otherwise the agent sees an error yet a retry with the same
				// name is rejected as a duplicate.
				const cw = ctx.model?.contextWindow ?? 0;
				const tokensHere = estimateAdmissionTokens(sm);
				const labelHint = findLabelHint(sm, leafId, ANCHOR_HINT_MAX_LENGTH);
				const positionLine = `${formatPct1(tokensHere, cw)}${cw > 0 ? ` of ${formatWindow(cw)}` : ""}`;
				const hintLine = labelHint ? ` (after: “${labelHint}”)` : "";
				pi.setLabel(leafId, fullLabel);
				return {
					content: [
						{
							type: "text",
							text:
								`[anchor '${p.name}'] set at ${positionLine}${hintLine}\n\n` +
								`Once real work has accumulated after this anchor, collapse it into a summary with: ${TOOL_NAME}(action='rewind', rewindTo='<oldest appropriate anchor>', newLabel='<milestone-name>', summaryFocus='<≥${MIN_SUMMARY_FOCUS_LENGTH}-char focus: latest user instruction + done + remaining>').`,
						},
					],
					details: {
						label: p.name,
						entryId: leafId,
						contextTokens: tokensHere,
						labelHint,
					},
				};
			}

			// --- pin ---
			// Agent-origin ledger item: the reducer decides duplicates, caps and
			// limits; only the agent-allowed kinds and the params of each kind are
			// checked here. A pin is not a rewind: no solo-call guard.
			if (p.action === "pin") {
				if (!state.config.continuity.capture) {
					return toolError("continuity ledger is disabled by config");
				}
				if (!isPinKind(p.kind)) {
					return toolError(
						p.kind === "rule" || p.kind === "objective"
							? `pin cannot record a ${p.kind}: the user's rules and objective are captured automatically.`
							: `pin requires \`kind\`: ${PIN_KINDS.join(", ")}.`,
					);
				}
				let op: LedgerOp;
				if (p.kind === "file") {
					if (!isFilled(p.path) || !isFilled(p.why)) {
						return toolError("pin kind='file' requires `path` and `why`.");
					}
					const path = normalize(p.path.trim());
					const sha = await hashPinnedFile(ctx.cwd, path);
					op = {
						op: "add",
						kind: "file",
						file: {
							path,
							...(isFilled(p.lines) && { lines: p.lines.trim() }),
							...(sha !== undefined && { sha256: sha }),
							why: p.why,
						},
					};
				} else {
					if (!isFilled(p.text)) {
						return toolError(`pin kind='${p.kind}' requires \`text\`.`);
					}
					let scopeAnchor: string | undefined;
					if (p.kind === "steering" || p.kind === "sub-goal") {
						const anchors = activeAnchorNames(sm);
						scopeAnchor = isFilled(p.scopeAnchor)
							? p.scopeAnchor.trim()
							: p.kind === "steering"
								? anchors.at(-1)
								: undefined;
						if (scopeAnchor === undefined && p.kind === "steering") {
							return toolError(
								"steering belongs to an anchor and the active branch has none — anchor first.",
							);
						}
						if (scopeAnchor !== undefined && !anchors.includes(scopeAnchor)) {
							return toolError(
								`No label '${scopeAnchor}' on the active branch. Use action='list' to see available labels.`,
							);
						}
					}
					op = {
						op: "add",
						kind: p.kind,
						text: p.text,
						...(scopeAnchor !== undefined && { scopeAnchor }),
					};
				}
				const branch = sm.getBranch();
				const result = applyOps(readBranchLedger(branch).ledger, [op], {
					origin: "agent",
					userEntryIndex: userEntryIndexOf(branch),
				});
				const outcome = result.applied[0];
				if (!outcome) {
					const reason = result.rejected[0]?.reason;
					return toolError(`pin rejected: ${reason?.message ?? "no change"}`, {
						...(reason && { code: reason.code }),
					});
				}
				const { id } = outcome.item;
				const details = {
					id,
					kind: p.kind,
					effect: outcome.effect,
					rev: result.ledger.rev,
				};
				if (outcome.effect === "duplicate") {
					return {
						content: [
							{
								type: "text",
								text: `[pin] ${id} already records this ${p.kind}; nothing added.`,
							},
						],
						details,
					};
				}
				appendOpsEntry(pi, [{ op, ctx: { origin: "agent" } }]);
				const cut =
					p.kind !== "file" && outcome.item.text !== p.text?.trim()
						? ` (text cut to ${MAX_ITEM_TEXT_CHARS} chars)`
						: "";
				return {
					content: [{ type: "text", text: `[pin] ${id} ${p.kind} recorded${cut}` }],
					details,
				};
			}

			// --- rewind ---
			if (!isValidName(p.rewindTo)) {
				return toolError(
					`rewind requires \`rewindTo\` in kebab-case, max ${MAX_NAME_LENGTH} chars.`,
				);
			}
			if (!isValidName(p.newLabel)) {
				return toolError(
					`rewind requires \`newLabel\` in kebab-case, max ${MAX_NAME_LENGTH} chars.`,
				);
			}
			if (!p.summaryFocus || p.summaryFocus.trim().length < MIN_SUMMARY_FOCUS_LENGTH) {
				const focusLen = p.summaryFocus?.trim().length ?? 0;
				return toolError(
					`\`summaryFocus\` must be ≥${MIN_SUMMARY_FOCUS_LENGTH} chars after trim (got ${focusLen}). The user's most recent instruction (which triggered this rewind) lives on the chain that's about to be collapsed — if summaryFocus doesn't preserve it, the post-rewind turn won't know what's left to do.\n\n` +
						`Include in summaryFocus:\n` +
						`  1. the user's most recent instruction verbatim,\n` +
						`  2. which parts have already been done in the work being collapsed,\n` +
						`  3. which parts remain unactioned.`,
				);
			}

			// Label uniqueness (issue #55, C8): a `newLabel` already on the
			// active branch is refused BEFORE any fold is queued — labels are
			// immutable once written, so the anchor→rewind rename-forward idiom is
			// retired. The existing label stays addressable via `rewindTo`.
			const existingLabel = findLabeledEntry(sm, LABEL_PREFIX + p.newLabel);
			if (existingLabel) {
				if (sm.getEntry(existingLabel)?.type === "branch_summary") {
					return toolError(
						`Label '${p.newLabel}' already names a stored handoff on the active branch. This request did not create another fold. If you intended that completed milestone, continue from the newest handoff's remaining work instead of repeating it. Use action='list' to inspect the active labels; choose a fresh newLabel only for different, uncollapsed work.`,
					);
				}
				return toolError(
					`A label '${p.newLabel}' already exists on the active branch — labels are unique and immutable once written, so rewind requires a fresh \`newLabel\`. The existing '${p.newLabel}' label stays addressable via \`rewindTo\`. Use action='list' to review the active labels, then pick a fresh newLabel.`,
				);
			}

			const target = findLabeledEntry(sm, LABEL_PREFIX + p.rewindTo);
			if (!target) {
				return toolError(
					`No label '${p.rewindTo}' on the active branch. Use action='list' to see available labels.`,
				);
			}

			const oldLeaf = sm.getLeafId();
			if (!oldLeaf || oldLeaf === target) {
				return toolError(`Already at '${p.rewindTo}' — nothing to summarize.`);
			}

			// Token math (#21): pure SessionManager reads, so the min-savings
			// floor below can reject before a fold is queued.
			// `allEntries`/`byId` are hoisted out of the parented-assistant branch
			// because the floor rejection copy reports per-anchor percentages from
			// the same maps.
			//
			// The leaf at execute time is the assistant that just streamed the
			// rewind tool call. Its `usage.input` is the *minimum* of recent API
			// calls in this turn, so estimating from it understates what the
			// user just saw. Use the chain up to its parent (which has the prior
			// assistant's usage as baseline) so beforeTokens matches the value
			// `list` would have reported on the previous turn.
			const oldLeafEntry = sm.getEntry(oldLeaf);
			const allEntries = sm.getEntries();
			const byId = new Map<string, SessionEntry>();
			for (const e of allEntries) byId.set(e.id, e);
			let beforeTokens: number;
			if (
				oldLeafEntry &&
				oldLeafEntry.type === "message" &&
				oldLeafEntry.message.role === "assistant" &&
				oldLeafEntry.parentId
			) {
				beforeTokens = estimateAtEntry(sm, allEntries, oldLeafEntry.parentId, byId);
			} else {
				beforeTokens = estimateAdmissionTokens(sm);
			}
			const tokensAtTarget = estimateAtEntry(sm, allEntries, target, byId);
			const contextWindow = ctx.model?.contextWindow ?? 0;

			const { entries } = collectEntriesForBranchSummary(sm, oldLeaf, target);
			if (entries.length === 0) {
				return toolError(`No entries between leaf and '${p.rewindTo}' — nothing to summarize.`);
			}
			// Minimum-savings floor (#21): refuse rewinds whose apparent savings
			// is below MIN_REWIND_SAVINGS_TOKENS — collapsing a near-empty segment
			// pays for a summary, forks a junk branch_summary, consumes a
			// milestone label, and grows live context.
			const apparentSavings = beforeTokens - tokensAtTarget;
			if (apparentSavings < MIN_REWIND_SAVINGS_TOKENS) {
				return toolError(
					buildMinSavingsRejection(
						p.rewindTo,
						p.newLabel,
						apparentSavings,
						sm,
						contextWindow,
						allEntries,
						byId,
						precedesLatestCompaction(sm.getBranch(), target),
					),
					{ rejected: "min-savings", apparentSavings },
				);
			}

			let sessionId: string;
			try {
				sessionId = sm.getSessionId();
			} catch (err) {
				return toolError(
					`Could not read the session id: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			// The fold runs at this turn's `turn_end`, after the tool results are
			// on the branch, through the independent engine: the summary is written
			// by side calls, so a session whose next main request the admission
			// guard would refuse can still fold.
			const queued = queueFold(sessionId, {
				origin: "agent",
				rewindTo: p.rewindTo,
				newLabel: p.newLabel,
				focus: p.summaryFocus,
				toolCallId,
			});
			if (!queued.ok) return toolError(`Rewind refused: ${queued.reason}.`);

			return {
				content: [
					{
						type: "text",
						text: buildRewindAcceptedText(p.rewindTo, p.newLabel),
					},
				],
				details: {
					status: "queued",
					rewindTo: p.rewindTo,
					newLabel: p.newLabel,
					targetId: target,
					contextBefore: beforeTokens,
					tokensAtTarget,
					contextWindow,
				},
			};
		},
	};
}
