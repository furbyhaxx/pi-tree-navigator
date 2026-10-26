/** Shared fold focus and recovery headroom policy. */
import { LABEL_PREFIX } from "../core/helpers.ts";

/**
 * Label written by the automatic start anchor (#55). Exported for the test
 * suite; production callers should rely on the registered tool surface.
 */
export const START_ANCHOR_LABEL = `${LABEL_PREFIX}start`;

// ---------------------------------------------------------------------------
// Exported boundary constants below (MIN_SUMMARY_FOCUS_LENGTH,
// MIN_REWIND_SAVINGS_TOKENS).
//
// Stability: these are internal tunables. Exported only so the test suite
// can pin boundary cases by constant rather than literal. Re-tuning is
// NOT a semver-breaking change for this package — production callers
// should rely on the registered `navigate_tree` tool surface, not import
// these constants directly. The `__testHooks` JSDoc carries the same
// caveat for module-internal helpers.
// ---------------------------------------------------------------------------
// Floor on `summaryFocus` length (after trim) for `rewind`. The user's most
// recent instruction lives on the chain about to be collapsed; if the focus
// is shorter than this, it almost always elides that instruction (a terse
// "finish parser fix" is 17 chars and conveys nothing the next turn can
// act on). 20 is the empirical threshold below which the post-rewind turn
// reliably loses continuity — raising it forces more useful focus text
// without inviting verbosity.
export const MIN_SUMMARY_FOCUS_LENGTH = 20;

export const RECOVERY_MIN_OUTPUT_TOKENS = 1_024;

export const RECOVERY_HEADROOM_TOKENS = 4_096;
