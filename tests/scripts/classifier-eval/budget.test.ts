import { afterEach, beforeEach, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	BudgetError,
	type BudgetErrorCode,
	BudgetLedger,
} from "../../../scripts/classifier-eval/budget.ts";

const BUDGET_URL = pathToFileURL(
	join(import.meta.dirname, "../../../scripts/classifier-eval/budget.ts"),
).href;

let directory = "";
let logPath = "";
let lockPath = "";
const opened: BudgetLedger[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "budget-ledger-"));
	logPath = join(directory, "campaign", "budget.jsonl");
	lockPath = `${logPath}.lock`;
});

afterEach(() => {
	for (const ledger of opened.splice(0)) ledger.close();
	rmSync(directory, { recursive: true, force: true });
});

const open = (limitUsd = 25): BudgetLedger => {
	const ledger = BudgetLedger.open(logPath, limitUsd);
	opened.push(ledger);
	return ledger;
};

const failsWith =
	(code: BudgetErrorCode) =>
	(error: unknown): boolean => {
		assert.ok(error instanceof BudgetError, String(error));
		assert.equal(error.code, code, error.message);
		return true;
	};

const lines = (): string[] => readFileSync(logPath, "utf8").trimEnd().split("\n");

const runChild = (body: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const script = `import { BudgetLedger } from ${JSON.stringify(BUDGET_URL)};\n${body}`;
		execFile(
			process.execPath,
			["--input-type=module", "-e", script],
			{ encoding: "utf8" },
			(error, stdout, stderr) =>
				error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout),
		);
	});

describe("amounts", () => {
	it("converts USD to nano-USD rounding up from the decimal form", () => {
		const ledger = open();
		ledger.reserve("exact", 0.07);
		assert.equal(ledger.snapshot().heldUsd, 0.07);
		ledger.reserve("sub-nano", 1e-10);
		ledger.reserve("tiny", 5e-324);
		assert.equal(ledger.snapshot().heldUsd, 0.070000002);
		ledger.reserve("sum-noise", 0.1 + 0.2);
		assert.equal(ledger.snapshot().heldUsd, 0.370000003);
		assert.equal(JSON.parse(lines()[1] ?? "").worstCaseNanoUsd, 70_000_000);
	});

	it("rejects non-finite, negative and unsafe amounts and bad ids", () => {
		const ledger = open();
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1e7, 1e300]) {
			assert.throws(() => ledger.reserve("a", bad), failsWith("invalid_amount"));
		}
		assert.throws(() => ledger.reserve("", 1), failsWith("invalid_id"));
		assert.throws(() => ledger.settle("a", -1), failsWith("invalid_amount"));
		assert.throws(
			() => BudgetLedger.open(join(directory, "other.jsonl"), Number.NaN),
			failsWith("invalid_amount"),
		);
		assert.equal(lines().length, 1);
		assert.equal(existsSync(join(directory, "other.jsonl")), false);
	});
});

describe("reservations", () => {
	it("lets exactly one of two competing reservations through", async () => {
		const ledger = open(25);
		const results = await Promise.allSettled([
			Promise.resolve().then(() => ledger.reserve("a", 15)),
			Promise.resolve().then(() => ledger.reserve("b", 15)),
		]);
		assert.deepEqual(
			results.map((result) => result.status),
			["fulfilled", "rejected"],
		);
		assert.throws(() => {
			throw (results[1] as PromiseRejectedResult).reason;
		}, failsWith("cap_exceeded"));
		assert.deepEqual(ledger.snapshot(), {
			limitUsd: 25,
			spentUsd: 0,
			heldUsd: 15,
			remainingUsd: 10,
		});
	});

	it("accepts an exact fit and rejects one nano-USD more", () => {
		const ledger = open(25);
		ledger.reserve("a", 24.999999999);
		assert.throws(() => ledger.reserve("b", 1e-9 + 1e-9), failsWith("cap_exceeded"));
		ledger.reserve("b", 1e-9);
		assert.equal(ledger.snapshot().remainingUsd, 0);
	});

	it("persists a reservation before reserve returns and rejects duplicates", () => {
		const ledger = open();
		ledger.reserve("call-1", 2);
		const event = JSON.parse(lines()[1] ?? "");
		assert.equal(event.event, "reserve");
		assert.equal(event.id, "call-1");
		assert.throws(() => ledger.reserve("call-1", 1), failsWith("duplicate_reservation"));
		assert.equal(lines().length, 2);
	});

	it("releases the unused hold on a verified settlement", () => {
		const ledger = open();
		ledger.reserve("a", 5);
		ledger.settle("a", 1.25);
		assert.deepEqual(ledger.snapshot(), {
			limitUsd: 25,
			spentUsd: 1.25,
			heldUsd: 0,
			remainingUsd: 23.75,
		});
		assert.throws(() => ledger.settle("a", 1.25), failsWith("already_settled"));
		assert.throws(() => ledger.settle("a", null), failsWith("already_settled"));
		assert.throws(() => ledger.settle("missing", 1), failsWith("unknown_reservation"));
	});
});

describe("unknown outcomes", () => {
	it("keep the full hold across reopen and reconcile exactly once", () => {
		const first = open(25);
		first.reserve("flight", 20);
		first.reserve("error", 5);
		first.settle("error", null);
		assert.throws(() => first.settle("error", null), failsWith("already_settled"));
		first.close();

		const second = open(25);
		assert.deepEqual(second.snapshot(), {
			limitUsd: 25,
			spentUsd: 0,
			heldUsd: 25,
			remainingUsd: 0,
		});
		assert.throws(() => second.reserve("more", 0.01), failsWith("cap_exceeded"));

		second.settle("error", 0.5);
		assert.throws(() => second.settle("error", 0.5), failsWith("already_settled"));
		second.close();

		const third = open(25);
		assert.deepEqual(third.snapshot(), {
			limitUsd: 25,
			spentUsd: 0.5,
			heldUsd: 20,
			remainingUsd: 4.5,
		});
	});
});

describe("overrun", () => {
	it("persists an actual above its reservation, reports it and closes reservations", () => {
		const ledger = open(25);
		ledger.reserve("a", 1);
		assert.throws(() => ledger.settle("a", 1.5), failsWith("bound_breach"));
		assert.equal(ledger.snapshot().spentUsd, 1.5);
		assert.equal(JSON.parse(lines()[2] ?? "").actualNanoUsd, 1_500_000_000);
		assert.throws(() => ledger.reserve("b", 1), failsWith("bound_breach"));
		ledger.close();

		const reopened = open(25);
		assert.equal(reopened.snapshot().spentUsd, 1.5);
		assert.throws(() => reopened.reserve("b", 1), failsWith("bound_breach"));
	});

	it("breaches when an unknown outcome reconciles above its hold, and reports negative remaining past the cap", () => {
		const ledger = open(2);
		ledger.reserve("a", 2);
		ledger.settle("a", null);
		assert.throws(() => ledger.settle("a", 3), failsWith("bound_breach"));
		assert.deepEqual(ledger.snapshot(), {
			limitUsd: 2,
			spentUsd: 3,
			heldUsd: 0,
			remainingUsd: -1,
		});
	});
});

describe("ownership", () => {
	it("allows one owner, removes only its own lock and closes idempotently", () => {
		const owner = open();
		assert.throws(() => BudgetLedger.open(logPath, 25), failsWith("locked"));
		assert.equal(existsSync(lockPath), true);
		assert.equal(lines().length, 1);

		owner.close();
		owner.close();
		assert.equal(existsSync(lockPath), false);
		assert.throws(() => owner.reserve("a", 1), failsWith("closed"));
		assert.throws(() => owner.snapshot(), failsWith("closed"));

		const next = open();
		writeFileSync(lockPath, `${JSON.stringify({ token: "foreign" })}\n`);
		next.close();
		assert.equal(existsSync(lockPath), true);
	});

	it("never removes a stale lock on its own", () => {
		BudgetLedger.open(logPath, 25).close();
		writeFileSync(lockPath, "stale\n");
		assert.throws(() => BudgetLedger.open(logPath, 25), failsWith("locked"));
		assert.equal(readFileSync(lockPath, "utf8"), "stale\n");
	});

	it("keeps holds of a crashed owner and admits a single process at a time", async () => {
		const attempt = `
      try {
        const ledger = BudgetLedger.open(${JSON.stringify(logPath)}, 25);
        ledger.reserve("crashed-" + process.pid, 20);
        console.log("reserved");
        process.exit(0);
      } catch (error) {
        console.log(error.code);
      }
    `;
		const outcomes = (await Promise.all([runChild(attempt), runChild(attempt)]))
			.map((out) => out.trim())
			.sort();
		assert.deepEqual(outcomes, ["locked", "reserved"]);
		assert.equal(existsSync(lockPath), true);
		assert.throws(() => BudgetLedger.open(logPath, 25), failsWith("locked"));

		rmSync(lockPath);
		const ledger = open(25);
		assert.equal(ledger.snapshot().heldUsd, 20);
		assert.throws(() => ledger.reserve("next", 6), failsWith("cap_exceeded"));
	});
});

describe("corrupt state", () => {
	const valid = (limit = 25_000_000_000): string[] => [
		JSON.stringify({ event: "cap", version: 1, limitNanoUsd: limit, at: "t" }),
		JSON.stringify({ event: "reserve", id: "a", worstCaseNanoUsd: 5, at: "t" }),
	];
	const cases: [string, string, BudgetErrorCode][] = [
		["empty file", "", "corrupt_log"],
		["partial last line", `${valid().join("\n")}\n{"event":"res`, "corrupt_log"],
		["missing final newline", valid().join("\n"), "corrupt_log"],
		["garbage line", `${valid().join("\n")}\nnot json\n`, "corrupt_log"],
		["blank line", `${valid().join("\n")}\n\n`, "corrupt_log"],
		["no cap header", `${valid()[1]}\n`, "corrupt_log"],
		["duplicate cap header", `${valid().join("\n")}\n${valid()[0]}\n`, "corrupt_log"],
		["duplicate reservation", `${valid().join("\n")}\n${valid()[1]}\n`, "corrupt_log"],
		[
			"settle without reservation",
			`${valid()[0]}\n{"event":"settle","id":"x","actualNanoUsd":1,"at":"t"}\n`,
			"corrupt_log",
		],
		[
			"reservation over the cap",
			`${valid()[0]}\n{"event":"reserve","id":"x","worstCaseNanoUsd":25000000001,"at":"t"}\n`,
			"corrupt_log",
		],
		[
			"negative amount",
			`${valid()[0]}\n{"event":"reserve","id":"x","worstCaseNanoUsd":-1,"at":"t"}\n`,
			"corrupt_log",
		],
		["changed cap", `${valid(30_000_000_000).join("\n")}\n`, "cap_mismatch"],
	];

	for (const [name, content, code] of cases) {
		it(`rejects ${name} and releases the lock`, () => {
			BudgetLedger.open(logPath, 25).close();
			writeFileSync(logPath, content);
			assert.throws(() => BudgetLedger.open(logPath, 25), failsWith(code));
			assert.equal(existsSync(lockPath), false);
			assert.equal(readFileSync(logPath, "utf8"), content);
		});
	}

	it("replays an intact log written by an earlier owner", () => {
		BudgetLedger.open(logPath, 25).close();
		writeFileSync(logPath, `${valid().join("\n")}\n`);
		const ledger = open(25);
		assert.equal(ledger.snapshot().heldUsd, 5e-9);
	});
});
