/**
 * Durable fail-closed USD budget ledger for the classifier live benchmark.
 *
 * The ledger is an append-only JSONL file: a header event fixing the cap,
 * then `reserve` and `settle` events. Amounts are integer nano-USD, converted
 * from USD rounding up. A reservation holds its worst-case cost until a
 * settlement carries an observed actual cost; an unknown outcome
 * (`settle(id, null)`) keeps the full hold and can be reconciled once.
 *
 * Fail closed: a log that is corrupt, partial or opened with another cap is
 * rejected, a second owner is refused by an exclusive `<path>.lock`, and an
 * observed cost above its reservation stops all further reservations. A lock
 * left behind by a crashed owner is never removed automatically.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

const NANO_PER_USD = 1e9;
const NANO_DIGITS = 9;
const LOG_VERSION = 1;

export type BudgetErrorCode =
	| "invalid_amount"
	| "invalid_id"
	| "cap_exceeded"
	| "bound_breach"
	| "duplicate_reservation"
	| "unknown_reservation"
	| "already_settled"
	| "locked"
	| "cap_mismatch"
	| "corrupt_log"
	| "io_error"
	| "closed";

/** Typed failure of the budget ledger. */
export class BudgetError extends Error {
	readonly code: BudgetErrorCode;
	constructor(code: BudgetErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BudgetError";
		this.code = code;
	}
}

export interface BudgetSnapshot {
	readonly limitUsd: number;
	readonly spentUsd: number;
	readonly heldUsd: number;
	/** `limit - spent - held`; negative when an observed cost overran the cap. */
	readonly remainingUsd: number;
}

type LedgerEvent =
	| {
			readonly event: "cap";
			readonly version: typeof LOG_VERSION;
			readonly limitNanoUsd: number;
			readonly at: string;
	  }
	| {
			readonly event: "reserve";
			readonly id: string;
			readonly worstCaseNanoUsd: number;
			readonly at: string;
	  }
	| {
			readonly event: "settle";
			readonly id: string;
			readonly actualNanoUsd: number | null;
			readonly at: string;
	  };

type MutationEvent = Exclude<LedgerEvent, { event: "cap" }>;

interface Reservation {
	readonly worstCase: number;
	status: "held" | "unknown" | "charged";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNano = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isErrno = (error: unknown, code: string): boolean =>
	isRecord(error) && error["code"] === code;

const ioError = (action: string, cause: unknown): BudgetError =>
	new BudgetError("io_error", `${action}: ${messageOf(cause)}`, cause);

/** Converts USD to integer nano-USD from its shortest decimal form, rounding up. */
function toNanoUsd(usd: number, name: string): number {
	if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
		throw new BudgetError(
			"invalid_amount",
			`${name} must be a finite non-negative number, got ${String(usd)}`,
		);
	}
	const [mantissa = "", exponent = "0"] = String(usd).split("e");
	const [whole = "", fraction = ""] = mantissa.split(".");
	const shift = NANO_DIGITS + Number(exponent) - fraction.length;
	const digits = BigInt(whole + fraction);
	const nano =
		shift >= 0
			? digits * 10n ** BigInt(shift)
			: (digits + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift);
	if (nano > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new BudgetError(
			"invalid_amount",
			`${name} ${String(usd)} exceeds the safe integer nano-USD range`,
		);
	}
	return Number(nano);
}

function parseEvent(line: string): LedgerEvent {
	const corrupt = (reason: string) => new BudgetError("corrupt_log", reason);
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new BudgetError("corrupt_log", "line is not valid JSON", error);
	}
	if (!isRecord(value) || typeof value["at"] !== "string") {
		throw corrupt("line is not an event object with a timestamp");
	}
	const at = value["at"];
	if (value["event"] === "cap") {
		if (value["version"] !== LOG_VERSION) throw corrupt("unsupported log version");
		if (!isNano(value["limitNanoUsd"])) throw corrupt("invalid cap amount");
		return {
			event: "cap",
			version: LOG_VERSION,
			limitNanoUsd: value["limitNanoUsd"],
			at,
		};
	}
	if (typeof value["id"] !== "string") throw corrupt("event id is not a string");
	if (value["event"] === "reserve") {
		if (!isNano(value["worstCaseNanoUsd"])) throw corrupt("invalid reserve amount");
		return {
			event: "reserve",
			id: value["id"],
			worstCaseNanoUsd: value["worstCaseNanoUsd"],
			at,
		};
	}
	if (value["event"] === "settle") {
		if (value["actualNanoUsd"] !== null && !isNano(value["actualNanoUsd"])) {
			throw corrupt("invalid settle amount");
		}
		return {
			event: "settle",
			id: value["id"],
			actualNanoUsd: value["actualNanoUsd"],
			at,
		};
	}
	throw corrupt("unknown event type");
}

function acquireLock(lockPath: string): string {
	const token = randomUUID();
	let fd: number;
	try {
		fd = openSync(lockPath, "wx");
	} catch (error) {
		if (isErrno(error, "EEXIST")) {
			throw new BudgetError(
				"locked",
				`budget ledger is locked by another owner: ${lockPath} (a stale lock must be removed manually)`,
				error,
			);
		}
		throw ioError(`cannot create lock ${lockPath}`, error);
	}
	try {
		writeSync(fd, `${JSON.stringify({ token, pid: process.pid })}\n`);
		fsyncSync(fd);
	} catch (error) {
		releaseLock(lockPath, token);
		throw ioError(`cannot write lock ${lockPath}`, error);
	} finally {
		closeSync(fd);
	}
	return token;
}

/** Removes the lock only if it still carries `token`; a foreign lock is left alone. */
function releaseLock(lockPath: string, token: string): void {
	try {
		const owner: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
		if (isRecord(owner) && owner["token"] === token) unlinkSync(lockPath);
	} catch (error) {
		if (isErrno(error, "ENOENT") || error instanceof SyntaxError) return;
		throw ioError(`cannot remove lock ${lockPath}`, error);
	}
}

/** Cumulative USD cap enforced across processes and restarts. */
export class BudgetLedger {
	private readonly path: string;
	private readonly lockPath: string;
	private readonly lockToken: string;
	private readonly limit: number;
	private readonly reservations = new Map<string, Reservation>();
	private spent = 0;
	private held = 0;
	private breached = false;
	private writeFailed = false;
	private closed = false;
	private fd = -1;

	private constructor(path: string, limit: number, lockToken: string) {
		this.path = path;
		this.lockPath = `${path}.lock`;
		this.lockToken = lockToken;
		this.limit = limit;
	}

	/**
	 * Takes exclusive ownership of the ledger at `path` and replays its log, or
	 * creates it with `limitUsd` as the immutable cap. Throws `locked` when
	 * another owner exists, `cap_mismatch` when `limitUsd` differs from the
	 * recorded cap, and `corrupt_log` for any unreadable or partial log.
	 */
	static open(path: string, limitUsd: number): BudgetLedger {
		const limit = toNanoUsd(limitUsd, "limitUsd");
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch (error) {
			throw ioError(`cannot create directory for ${path}`, error);
		}
		const ledger = new BudgetLedger(path, limit, acquireLock(`${path}.lock`));
		try {
			ledger.load();
		} catch (error) {
			ledger.release();
			throw error;
		}
		return ledger;
	}

	/**
	 * Persists and fsyncs a hold for `worstCaseUsd` before returning. Call it
	 * before dispatching the paid request. Throws `cap_exceeded` when
	 * spent + held + new would pass the cap and `bound_breach` after an overrun.
	 */
	reserve(id: string, worstCaseUsd: number): void {
		this.assertUsable();
		this.commit({
			event: "reserve",
			id,
			worstCaseNanoUsd: toNanoUsd(worstCaseUsd, "worstCaseUsd"),
			at: new Date().toISOString(),
		});
	}

	/**
	 * Settles a reservation with the observed cost, releasing the unused hold.
	 * `null` records an unknown outcome and keeps the full hold; it can be
	 * reconciled once with an actual amount. An actual above the reservation is
	 * persisted, closes the ledger to new reservations and throws `bound_breach`.
	 */
	settle(id: string, actualUsd: number | null): void {
		this.assertUsable();
		const actual = actualUsd === null ? null : toNanoUsd(actualUsd, "actualUsd");
		this.commit({
			event: "settle",
			id,
			actualNanoUsd: actual,
			at: new Date().toISOString(),
		});
		const reservation = this.reservations.get(id);
		if (reservation && actual !== null && actual > reservation.worstCase) {
			throw new BudgetError(
				"bound_breach",
				`observed cost ${actual / NANO_PER_USD} USD for ${id} exceeds its reservation of ${reservation.worstCase / NANO_PER_USD} USD; the charge is recorded and no further reservations are allowed`,
			);
		}
	}

	snapshot(): BudgetSnapshot {
		if (this.closed) throw new BudgetError("closed", "ledger is closed");
		return {
			limitUsd: this.limit / NANO_PER_USD,
			spentUsd: this.spent / NANO_PER_USD,
			heldUsd: this.held / NANO_PER_USD,
			remainingUsd: (this.limit - this.spent - this.held) / NANO_PER_USD,
		};
	}

	/** Releases the file handle and this owner's lock. Safe to call repeatedly. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.release();
	}

	private release(): void {
		const fd = this.fd;
		this.fd = -1;
		try {
			if (fd !== -1) closeSync(fd);
		} finally {
			releaseLock(this.lockPath, this.lockToken);
		}
	}

	private assertUsable(): void {
		if (this.closed) throw new BudgetError("closed", "ledger is closed");
		if (this.writeFailed) {
			throw new BudgetError(
				"io_error",
				"ledger is disabled after a failed write; reopen it to replay the log",
			);
		}
	}

	private load(): void {
		let text: string | undefined;
		try {
			text = readFileSync(this.path, "utf8");
		} catch (error) {
			if (!isErrno(error, "ENOENT")) {
				throw ioError(`cannot read ${this.path}`, error);
			}
		}
		if (text === undefined) {
			this.create();
		} else {
			this.replay(text);
			this.fd = this.openAppend("a");
		}
	}

	private create(): void {
		this.fd = this.openAppend("ax");
		this.persist({
			event: "cap",
			version: LOG_VERSION,
			limitNanoUsd: this.limit,
			at: new Date().toISOString(),
		});
		try {
			const dirFd = openSync(dirname(this.path), "r");
			try {
				fsyncSync(dirFd);
			} finally {
				closeSync(dirFd);
			}
		} catch (error) {
			throw ioError(`cannot sync directory of ${this.path}`, error);
		}
	}

	private openAppend(flags: "a" | "ax"): number {
		try {
			return openSync(this.path, flags);
		} catch (error) {
			throw ioError(`cannot open ${this.path}`, error);
		}
	}

	private replay(text: string): void {
		const lines = text.split("\n");
		if (lines.pop() !== "") {
			throw new BudgetError(
				"corrupt_log",
				`${this.path} does not end with a newline (partial write)`,
			);
		}
		if (lines.length === 0) {
			throw new BudgetError("corrupt_log", `${this.path} has no cap header`);
		}
		for (const [index, line] of lines.entries()) {
			try {
				const event = parseEvent(line);
				if (index === 0) {
					this.verifyCap(event);
				} else if (event.event === "cap") {
					throw new BudgetError("corrupt_log", "duplicate cap header");
				} else {
					this.check(event);
					this.apply(event);
				}
			} catch (error) {
				if (error instanceof BudgetError && error.code === "cap_mismatch") {
					throw error;
				}
				throw new BudgetError(
					"corrupt_log",
					`${this.path} line ${index + 1}: ${messageOf(error)}`,
					error,
				);
			}
		}
	}

	private verifyCap(event: LedgerEvent): void {
		if (event.event !== "cap") {
			throw new BudgetError("corrupt_log", "first line is not the cap header");
		}
		if (event.limitNanoUsd !== this.limit) {
			throw new BudgetError(
				"cap_mismatch",
				`${this.path} has a recorded cap of ${event.limitNanoUsd / NANO_PER_USD} USD, not ${this.limit / NANO_PER_USD} USD`,
			);
		}
	}

	private check(event: MutationEvent): void {
		if (event.id === "") {
			throw new BudgetError("invalid_id", "reservation id must not be empty");
		}
		const reservation = this.reservations.get(event.id);
		if (event.event === "reserve") {
			if (this.breached) {
				throw new BudgetError(
					"bound_breach",
					"an observed cost overran its reservation; no further reservations are allowed",
				);
			}
			if (reservation) {
				throw new BudgetError("duplicate_reservation", `reservation ${event.id} already exists`);
			}
			if (this.spent + this.held + event.worstCaseNanoUsd > this.limit) {
				throw new BudgetError(
					"cap_exceeded",
					`reserving ${event.worstCaseNanoUsd / NANO_PER_USD} USD would exceed the ${this.limit / NANO_PER_USD} USD cap (spent ${this.spent / NANO_PER_USD}, held ${this.held / NANO_PER_USD})`,
				);
			}
			return;
		}
		if (!reservation) {
			throw new BudgetError("unknown_reservation", `reservation ${event.id} does not exist`);
		}
		if (
			reservation.status === "charged" ||
			(reservation.status === "unknown" && event.actualNanoUsd === null)
		) {
			throw new BudgetError(
				"already_settled",
				`reservation ${event.id} is already ${reservation.status}`,
			);
		}
		if (event.actualNanoUsd !== null && !Number.isSafeInteger(this.spent + event.actualNanoUsd)) {
			throw new BudgetError(
				"invalid_amount",
				"cumulative spend exceeds the safe integer nano-USD range",
			);
		}
	}

	private apply(event: MutationEvent): void {
		if (event.event === "reserve") {
			this.reservations.set(event.id, {
				worstCase: event.worstCaseNanoUsd,
				status: "held",
			});
			this.held += event.worstCaseNanoUsd;
			return;
		}
		const reservation = this.reservations.get(event.id);
		if (!reservation) return;
		if (event.actualNanoUsd === null) {
			reservation.status = "unknown";
			return;
		}
		reservation.status = "charged";
		this.held -= reservation.worstCase;
		this.spent += event.actualNanoUsd;
		if (event.actualNanoUsd > reservation.worstCase) this.breached = true;
	}

	private commit(event: MutationEvent): void {
		this.check(event);
		this.persist(event);
		this.apply(event);
	}

	private persist(event: LedgerEvent): void {
		const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
		try {
			if (writeSync(this.fd, bytes) !== bytes.length) {
				throw new Error("short write");
			}
			fsyncSync(this.fd);
		} catch (error) {
			this.writeFailed = true;
			throw ioError(`cannot append to ${this.path}`, error);
		}
	}
}
