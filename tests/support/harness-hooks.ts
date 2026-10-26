/** Shared extension test harness hooks. */
import { afterEach } from "bun:test";
import { __testHooks } from "../../src/index.ts";
import type { FakeAgentSession } from "./session-fakes.ts";

// The extension holds captured sessions weakly; retain fakes until each test ends.
export const capturedFakes: FakeAgentSession[] = [];

/** Restore extension reflection and release captured fakes after each test in the caller. */
export function installHarnessHooks(): void {
	afterEach(() => {
		capturedFakes.length = 0;
		__testHooks.resetPrototype();
	});
}
