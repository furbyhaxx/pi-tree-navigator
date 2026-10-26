/** Terminal-safe text and printable keyboard input for frame panels. */
import { decodeKittyPrintable, stripTerminalSequences } from "@earendil-works/pi-tui";

function isControl(code: number): boolean {
	return (
		code <= 0x08 ||
		(code >= 0x0b && code <= 0x1f) ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0xfff9 && code <= 0xfffb)
	);
}

/** Strip terminal escape sequences and control characters; tab and newline survive. */
export function cleanTerminalText(text: string): string {
	let clean = "";
	for (const char of stripTerminalSequences(text)) {
		if (!isControl(char.codePointAt(0) ?? 0)) clean += char;
	}
	return clean;
}

export function singleLine(text: string): string {
	return cleanTerminalText(text).replace(/[\n\t]/g, " ");
}

export function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	const typed = [...data].every((char) => {
		const code = char.codePointAt(0) ?? 0;
		return code >= 0x20 && !isControl(code);
	});
	return data && typed ? data : undefined;
}
