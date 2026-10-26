/** Suite-wide hooks: bun runs every test file in one process, so global patches must not leak. */
import { afterEach } from "bun:test";
import { resetHandoffProjection } from "../src/fold/handoff-projection.ts";

afterEach(() => resetHandoffProjection());
