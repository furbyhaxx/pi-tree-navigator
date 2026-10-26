/** Live Pi compaction settings shared by recovery gates and anchor hints. */

import { type SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { NavigatorState } from "./navigator-state.ts";
import { asInternals, findOwningSession } from "./pi-internals.ts";
import type { OverflowModel } from "./request-accounting.ts";

/** Configuration source used when no captured session owns the manager. */
export interface PiCompactionDeps {
	state: Pick<NavigatorState, "config">;
}

/** Creates the live settings reader without registering handlers or loading settings. */
export function createPiCompactionController({ state }: PiCompactionDeps) {
	/**
	 * pi's compaction settings for `model` (#101, S3/S4/D9), or `null`. Read
	 * from the captured session's live settings manager, the one pi decides
	 * from; the disk (with the session's project trust) only when no session
	 * is captured.
	 */
	function piCompaction(
		sm: SessionManager,
		model: OverflowModel | undefined,
	): { enabled: boolean; reserveTokens: number } | null {
		try {
			const session = findOwningSession(sm);
			let settingsManager = session ? asInternals(session).settingsManager : undefined;
			if (!settingsManager) {
				if (!state.config.piSettingsSource) return null;
				settingsManager = SettingsManager.create(
					state.config.piSettingsSource.cwd,
					state.config.piSettingsSource.agentDir,
					{
						projectTrusted: state.config.piSettingsSource.projectTrusted,
					},
				);
			}
			const settings = settingsManager.getCompactionSettings(model);
			return {
				enabled: settings.enabled,
				reserveTokens: settings.reserveTokens,
			};
		} catch {
			// Invalid settings: pi's own compaction throws on them too.
			return null;
		}
	}

	return { piCompaction };
}
