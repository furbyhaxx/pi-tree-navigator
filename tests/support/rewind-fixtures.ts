/** Complete rewind fixtures with configurable parent handoffs. */
import {
	cleanupConfigFixture,
	makeConfigFixture,
	runSessionStart,
	writeGlobalConfig,
} from "./config-fixtures.ts";
import { setup } from "./extension-harness.ts";
import { fakeRegistry, reply } from "./model-registry.ts";
import { requestRewind, rewindMessages } from "./rewind-drivers.ts";
import { setupRewindable } from "./session-fakes.ts";

export async function configureParentMode(f: ReturnType<typeof setup>, mode: "full" | "digest") {
	const fixture = makeConfigFixture();
	try {
		writeGlobalConfig(fixture, JSON.stringify({ parentHandoffMode: mode }));
		await runSessionStart(f.pi, f.ctx, fixture);
	} finally {
		cleanupConfigFixture(fixture);
	}
}

/**
 * Full rewind: canonical fixture and the rewind call, whose fold lands at its
 * `turn_end`. Returns the fixture plus the call's result and the continuation
 * message.
 */
export async function rewindFixture(
	opts: { capture?: boolean; summary?: string; mode?: "full" | "digest" } = {},
) {
	const f = setup();
	if (opts.mode) await configureParentMode(f, opts.mode);
	if (opts.summary !== undefined) {
		const summary = opts.summary;
		f.ctx.modelRegistry = fakeRegistry(() => reply(summary)).registry;
	}
	const { fake, anchorId } = setupRewindable(f.sm, f.pi, {
		capture: opts.capture ?? true,
	});
	const oldLeafBeforeCall = f.sm.getLeafId();
	const { result, leafBeforeFold } = await requestRewind(f);
	const messages = rewindMessages(f.pi);
	return {
		...f,
		fake,
		anchorId,
		result,
		oldLeafBeforeCall,
		leafBeforeFold,
		done: messages[messages.length - 1],
	};
}
