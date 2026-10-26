/** Transcript renderers for continuity operations and historical rewind messages. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTINUITY_OPS_CUSTOM_TYPE } from "../continuity/continuity-store.ts";
import { extractTextContent } from "../core/helpers.ts";
import {
	LEGACY_REWIND_OUTCOME_CUSTOM_TYPE,
	LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE,
	legacyRewindOutcomeRow,
	legacySummaryRequestRow,
	sanitizeLegacyText,
} from "../core/legacy-rewind.ts";
import { CONTINUE_NUDGE_STATUS, REWIND_CUSTOM_TYPE, StyledLines } from "../fold/fold-receipts.ts";
import { renderContinuityOps } from "./tool-renderer.ts";

/** Registers the navigator's message and entry renderers in transcript order. */
export function registerNavigatorRenderers(pi: ExtensionAPI): void {
	// TUI rows: local components styled through `theme`.
	pi.registerEntryRenderer(CONTINUITY_OPS_CUSTOM_TYPE, renderContinuityOps);
	pi.registerMessageRenderer(LEGACY_SUMMARY_REQUEST_CUSTOM_TYPE, (message, options, theme) => {
		const lines = [legacySummaryRequestRow(message.details)];
		if (options.expanded) {
			lines.push("", ...sanitizeLegacyText(extractTextContent(message.content)).split("\n"));
		}
		return new StyledLines(
			lines,
			(line) => theme.fg("customMessageText", line),
			options.outputPad ?? 1,
			options.expanded,
		);
	});
	pi.registerEntryRenderer(LEGACY_REWIND_OUTCOME_CUSTOM_TYPE, (entry, _options, theme) => {
		const row = legacyRewindOutcomeRow(entry.data);
		if (!row) return undefined;
		const status = (entry.data as { status?: unknown } | undefined)?.status;
		const failed = status === "failed";
		return new StyledLines(
			[`${failed ? "✗" : "⚠"} ${row}`],
			(line) => theme.fg(failed ? "error" : "warning", line),
			1,
			false,
		);
	});
	// The final error of rewind-driven compaction (#101, D8): one
	// error-styled row, full text, nothing to expand. The continue nudge is
	// one line, expandable. Every other rewind message (the continuation, the
	// forced-rewind message) keeps pi's default rendering.
	pi.registerMessageRenderer(REWIND_CUSTOM_TYPE, (message, options, theme) => {
		const status = (message.details as { status?: unknown } | undefined)?.status;
		if (status === CONTINUE_NUDGE_STATUS) {
			const lines = [
				"[navigate_tree] turn ended right after a rewind \u00b7 nudged once to continue",
			];
			if (options.expanded) {
				lines.push("", ...extractTextContent(message.content).split("\n"));
			}
			return new StyledLines(
				lines,
				(line) => theme.fg("customMessageText", line),
				options.outputPad ?? 1,
			);
		}
		if (status !== "failed") return undefined;
		return new StyledLines(
			extractTextContent(message.content).split("\n"),
			(line) => theme.fg("error", line),
			options.outputPad ?? 1,
		);
	});
}
