/** Validation and normalization of new ledger items and file pointers. */

import { isValidName } from "../core/helpers.ts";
import {
	ContinuityError,
	capText,
	type FilePointer,
	ITEM_KINDS,
	type ItemKind,
	LINES_RE,
	locator,
	MAX_ITEM_TEXT_CHARS,
	MAX_PATH_CHARS,
	MAX_QUOTE_CHARS,
	type NewItem,
	SHA256_RE,
} from "./continuity-ledger-model.ts";

export const invalid = (message: string, itemId?: string): ContinuityError =>
	new ContinuityError("invalid_op", message, itemId);

export interface Normalized {
	readonly kind: ItemKind;
	readonly text: string;
	readonly quote?: string;
	readonly scopeAnchor?: string;
	readonly file?: FilePointer;
}

export function capRequired(value: unknown, max: number, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw invalid(`${label} must be a non-empty string`);
	}
	return capText(value.trim(), max);
}

export function normalizeFile(file: FilePointer): FilePointer {
	if (
		typeof file.path !== "string" ||
		file.path.length === 0 ||
		file.path.length > MAX_PATH_CHARS
	) {
		throw invalid(`file.path must be 1-${MAX_PATH_CHARS} characters`);
	}
	if (file.lines !== undefined && !LINES_RE.test(file.lines)) {
		throw invalid("file.lines must be N or N-M");
	}
	if (file.sha256 !== undefined && !SHA256_RE.test(file.sha256)) {
		throw invalid("file.sha256 must be 64 lowercase hex characters");
	}
	return {
		path: file.path,
		...(file.lines !== undefined && { lines: file.lines }),
		...(file.sha256 !== undefined && { sha256: file.sha256 }),
		why: capRequired(file.why, MAX_ITEM_TEXT_CHARS, "file.why"),
	};
}

export function normalizeNewItem(input: NewItem): Normalized {
	const { kind } = input;
	if (!ITEM_KINDS.includes(kind)) throw invalid(`unknown kind ${String(kind)}`);
	const quote =
		input.quote === undefined ? undefined : capRequired(input.quote, MAX_QUOTE_CHARS, "quote");
	const { scopeAnchor } = input;
	if (kind === "steering" && scopeAnchor === undefined) {
		throw invalid("steering requires a scopeAnchor");
	}
	if (scopeAnchor !== undefined) {
		if (kind !== "steering" && kind !== "sub-goal") {
			throw invalid(`${kind} items cannot have a scopeAnchor`);
		}
		if (!isValidName(scopeAnchor)) {
			throw invalid(`scopeAnchor ${String(scopeAnchor)} is not an anchor name`);
		}
	}
	const common = {
		kind,
		...(quote !== undefined && { quote }),
		...(scopeAnchor !== undefined && { scopeAnchor }),
	};
	if (kind === "file") {
		if (input.text !== undefined) throw invalid("file text is derived");
		if (!input.file) throw invalid("file items require a file pointer");
		const file = normalizeFile(input.file);
		return { ...common, text: locator(file), file };
	}
	if (input.file !== undefined) throw invalid(`${kind} items cannot have a file`);
	return {
		...common,
		text: capRequired(input.text, MAX_ITEM_TEXT_CHARS, "text"),
	};
}
