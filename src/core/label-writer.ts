/** Best-effort label writes that preserve the captured session cursor. */

import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { unrestoredFoldCursors } from "../fold/fold-commit.ts";
import { trySessionWrite } from "./session-write.ts";

/** Creates a label writer with Pi delivery and a captured-manager fallback. */
export function createLabelWriter(pi: Pick<ExtensionAPI, "setLabel">) {
	/** Best-effort label write: `pi.setLabel`, else the captured manager. */
	function writeLabel(sm: SessionManager, entryId: string, label: string | undefined): boolean {
		if (unrestoredFoldCursors.has(sm)) return false;
		const primary = trySessionWrite(sm, () => pi.setLabel(entryId, label));
		if (primary.ok) return true;
		if (!primary.cursorRestored) return false;
		return trySessionWrite(sm, () => sm.appendLabelChange(entryId, label)).ok;
	}

	return writeLabel;
}
