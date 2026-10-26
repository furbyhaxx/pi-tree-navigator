import { afterEach, describe, it } from "bun:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CLONE_USAGE, runCloneSubcommand } from "../../src/retrospective/retrospective-command.ts";
import { inspectRetrospectiveSession } from "../../src/retrospective/retrospective-plan.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const timestamp = "2026-01-01T00:00:00.000Z";
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "tree-clone-command-"));
	directories.push(directory);
	const sourcePath = join(directory, "source session.jsonl");
	const planPath = join(directory, "plan with spaces.json");
	const source = [
		{
			type: "session",
			version: 3,
			id: "original",
			cwd: directory,
			timestamp,
		},
		{
			type: "session_info",
			id: "name",
			parentId: null,
			timestamp,
			name: "Original",
		},
		{
			type: "message",
			id: "one",
			parentId: "name",
			timestamp,
			message: { role: "user", content: "Question", timestamp: 1 },
		},
	];
	await writeFile(sourcePath, `${source.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	const inspected = await inspectRetrospectiveSession(sourcePath);
	await writeFile(
		planPath,
		JSON.stringify({
			version: 1,
			source: "source session.jsonl",
			sourceSha256: inspected.sourceSha256,
			nameSuffix: " (clone)",
			groups: [
				{
					name: "phase",
					firstEntryId: "one",
					lastEntryId: "one",
					summary: "The phase is complete.",
					children: [],
				},
			],
		}),
	);
	return { directory, sourcePath, planPath };
}

interface SideEffects {
	appends: number;
	messages: number;
	userMessages: number;
	sessionChanges: number;
	waits: number;
}

const ENTER = "\r";
const ESC = "\x1b";

interface TestContextOptions {
	/** Keys sent to each `ui.custom` screen, in order; a screen the script leaves open fails the test. */
	screens?: string[][];
	columns?: number;
	cwd: string;
	hasUI?: boolean;
	idle?: boolean;
	sessionFile?: string;
	inputResult?: string;
	editorResult?: string;
	confirmResult?: boolean;
}

function setup(options: TestContextOptions) {
	const sideEffects: SideEffects = {
		appends: 0,
		messages: 0,
		userMessages: 0,
		sessionChanges: 0,
		waits: 0,
	};
	const pi = {
		appendEntry() {
			sideEffects.appends++;
		},
		sendMessage() {
			sideEffects.messages++;
		},
		sendUserMessage() {
			sideEffects.userMessages++;
		},
	} as unknown as ExtensionAPI;

	const notifications: { message: string; type?: string }[] = [];
	const editors: { title: string; text: string }[] = [];
	const confirmations: { title: string; message: string }[] = [];
	const inputs: { title: string; placeholder?: string }[] = [];
	const screens = [...(options.screens ?? [])];
	const frames: string[][] = [];
	const columns = options.columns ?? 80;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
	};
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		isIdle: () => options.idle ?? true,
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionId: () => options.sessionFile ?? "test-session",
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, ...(type === undefined ? {} : { type }) });
			},
			async editor(title: string, text: string) {
				editors.push({ title, text });
				return options.editorResult;
			},
			async confirm(title: string, message: string) {
				confirmations.push({ title, message });
				return options.confirmResult ?? false;
			},
			async input(title: string, placeholder?: string) {
				inputs.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
				return options.inputResult;
			},
			custom(
				factory: (...args: unknown[]) => {
					handleInput(data: string): void;
					render(width: number): string[];
				},
			) {
				const keys = screens.shift();
				assert.ok(keys, "unexpected extra screen");
				return new Promise((resolve, reject) => {
					let closed = false;
					const tui = { terminal: { rows: 40, columns }, requestRender() {} };
					const screen = factory(tui, theme, undefined, (value: unknown) => {
						closed = true;
						resolve(value);
					});
					frames.push(screen.render(columns));
					for (const key of keys) {
						if (closed) break;
						screen.handleInput(key);
					}
					if (!closed) reject(new Error("screen left open by its script"));
				});
			},
		},
		async switchSession() {
			sideEffects.sessionChanges++;
		},
		async newSession() {
			sideEffects.sessionChanges++;
		},
		async fork() {
			sideEffects.sessionChanges++;
		},
		async navigateTree() {
			sideEffects.sessionChanges++;
		},
		async waitForIdle() {
			sideEffects.waits++;
		},
	} as unknown as ExtensionCommandContext;

	return {
		run: (args: string) => runCloneSubcommand(args, ctx, pi),
		ctx,
		notifications,
		editors,
		confirmations,
		inputs,
		frames,
		sideEffects,
	};
}

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	assert.ok(value !== undefined, `Expected an element at index ${index}`);
	return value;
}

describe("retrospective clone command", () => {
	it("names /anchor clone and every propose flag in its usage and errors", async () => {
		for (const flag of [
			"--llm",
			"--model",
			"--output",
			"--omit-tool",
			"--calls-only-tool",
			"--full-tool",
		]) {
			assert.ok(CLONE_USAGE.includes(flag), flag);
		}
		assert.ok(CLONE_USAGE.startsWith("Usage: /anchor clone ["));
		const command = setup({ cwd: tmpdir() });
		await command.run("");
		await command.run("bogus");
		await command.run('inspect "unbalanced');
		assert.deepEqual(
			command.notifications.map(({ message }) => message.includes("/anchor clone")),
			[true, true, true],
		);
		assert.ok(command.notifications.every(({ message }) => !message.includes("/tree-clone")));
	});

	it("keeps inspect/preview read-only and shows readable text, not JSON", async () => {
		const files = await fixture();
		const before = await readFile(files.sourcePath);
		const command = setup({
			cwd: files.directory,
			sessionFile: files.sourcePath,
			screens: [[ESC], [ESC]],
		});

		await command.run("inspect");
		await command.run('preview "plan with spaces.json"');

		assert.equal(command.editors.length, 0);
		for (const frame of command.frames) {
			const text = frame.join("\n");
			assert.doesNotMatch(text, /[{}]|sourceSha256|previewToken/);
			assert.ok(frame.every((line) => visibleWidth(line) <= 80));
		}
		const [inspect, preview] = command.frames.map((frame) => frame.join("\n"));
		assert.ok(inspect !== undefined);
		assert.ok(preview !== undefined);
		assert.match(inspect, /Anchor\/Clone\/Inspect/);
		assert.match(inspect, /Session\s+Original/);
		assert.match(inspect, /source session\.jsonl/);
		assert.match(preview, /Anchor\/Clone\/Preview/);
		assert.match(preview, /\[folded\] phase \(1 entry\)/);
		assert.match(preview, /The phase is complete\./);
		assert.ok(command.notifications.some(({ message }) => message.includes("1 user turns")));
		assert.deepEqual(await readFile(files.sourcePath), before);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);
		assert.deepEqual(command.sideEffects, {
			appends: 0,
			messages: 0,
			userMessages: 0,
			sessionChanges: 0,
			waits: 0,
		});
	});

	it("fits every line of both screens in 60 columns", async () => {
		const files = await fixture();
		const command = setup({
			cwd: files.directory,
			sessionFile: files.sourcePath,
			columns: 60,
			screens: [[ESC], [ESC]],
		});
		await command.run("inspect");
		await command.run('preview "plan with spaces.json"');
		assert.equal(command.frames.length, 2);
		for (const frame of command.frames) {
			assert.ok(frame.every((line) => visibleWidth(line) <= 60));
		}
	});

	it("opens the raw JSON on j and returns to the screen", async () => {
		const files = await fixture();
		const command = setup({
			cwd: files.directory,
			sessionFile: files.sourcePath,
			screens: [["j"], [ESC], ["j"], [ESC]],
		});

		await command.run("inspect");
		await command.run('preview "plan with spaces.json"');

		assert.equal(command.frames.length, 4);
		assert.match(at(command.frames, 0).join("\n"), /j raw JSON/);
		assert.equal(command.editors.length, 2);
		assert.match(at(command.editors, 0).title, /read-only/);
		assert.match(at(command.editors, 0).text, /"sourceSha256"/);
		assert.match(at(command.editors, 0).text, /source session\.jsonl/);
		assert.match(at(command.editors, 1).text, /"previewToken"/);
		assert.match(at(command.editors, 1).text, /The phase is complete\./);
	});

	it("prompts for a missing preview path when UI is available", async () => {
		const files = await fixture();
		const command = setup({
			cwd: files.directory,
			inputResult: '"plan with spaces.json"',
			screens: [[ESC]],
		});

		await command.run("preview");

		assert.equal(command.inputs.length, 1);
		assert.match(at(command.inputs, 0).title, /preview/);
		assert.equal(command.editors.length, 0);
		assert.match(command.notifications.at(-1)?.message ?? "", /Preview for/);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);
	});

	it("does not write a clone when confirmation is cancelled", async () => {
		const files = await fixture();
		const before = await readFile(files.sourcePath);
		const command = setup({
			cwd: files.directory,
			confirmResult: false,
			screens: [[ENTER]],
		});

		await command.run('create "plan with spaces.json"');

		assert.equal(command.editors.length, 0);
		assert.equal(command.confirmations.length, 1);
		assert.match(at(command.confirmations, 0).title, /Original \(clone\)/);
		assert.match(at(command.confirmations, 0).message, /original session will remain untouched/);
		assert.doesNotMatch(at(command.confirmations, 0).message, /[{}]|previewToken/);
		assert.match(command.notifications.at(-1)?.message ?? "", /cancelled; no files were written/);
		assert.deepEqual(await readFile(files.sourcePath), before);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);
		assert.deepEqual(command.sideEffects, {
			appends: 0,
			messages: 0,
			userMessages: 0,
			sessionChanges: 0,
			waits: 0,
		});
	});

	it("writes nothing and asks nothing when the create review is dismissed with Escape", async () => {
		const files = await fixture();
		const command = setup({
			cwd: files.directory,
			confirmResult: true,
			screens: [[ESC]],
		});

		await command.run('create "plan with spaces.json"');

		assert.equal(command.confirmations.length, 0);
		assert.match(command.notifications.at(-1)?.message ?? "", /cancelled; no files were written/);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);
	});

	it("creates from the fresh preview without changing the source or active session", async () => {
		const files = await fixture();
		const before = await readFile(files.sourcePath);
		const command = setup({
			cwd: files.directory,
			confirmResult: true,
			screens: [[ENTER]],
		});

		await command.run('create "plan with spaces.json"');

		const entries = (await readdir(files.directory)).sort();
		assert.equal(entries.length, 3);
		assert.ok(entries.includes("source session.jsonl"));
		const cloneFile = entries.find(
			(entry) => entry.endsWith(".jsonl") && entry !== "source session.jsonl",
		);
		assert.ok(cloneFile);
		const clone = SessionManager.open(join(files.directory, cloneFile));
		assert.equal(clone.getSessionName(), "Original (clone)");
		assert.deepEqual(await readFile(files.sourcePath), before);
		assert.match(command.notifications.at(-1)?.message ?? "", /left untouched/);
		assert.deepEqual(command.sideEffects, {
			appends: 0,
			messages: 0,
			userMessages: 0,
			sessionChanges: 0,
			waits: 0,
		});
	});

	it("refuses headless or busy create requests without creating a session", async () => {
		const files = await fixture();
		const headless = setup({ cwd: files.directory, hasUI: false });
		await headless.run("create plan.json");
		assert.match(headless.notifications.at(-1)?.message ?? "", /scripts\/restructure-session\.mjs/);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);

		const busy = setup({ cwd: files.directory, idle: false });
		await busy.run('create "plan with spaces.json"');
		assert.match(busy.notifications.at(-1)?.message ?? "", /session is idle/);
		assert.equal(busy.editors.length, 0);
		assert.equal(busy.confirmations.length, 0);
		assert.deepEqual((await readdir(files.directory)).sort(), [
			"plan with spaces.json",
			"source session.jsonl",
		]);
		assert.equal(busy.sideEffects.waits, 0);
		assert.equal(busy.sideEffects.sessionChanges, 0);
	});
});

const script = fileURLToPath(new URL("../../scripts/restructure-session.mjs", import.meta.url));
const cli = (...args: string[]) =>
	spawnSync(process.execPath, ["--no-warnings", script, ...args], {
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});

describe("offline restructure CLI", () => {
	it("prints the same help for --help, -h, help and no arguments, listing every subcommand and propose flag", () => {
		const help = cli("--help");
		assert.equal(help.status, 0);
		for (const word of [
			"inspect <session.jsonl>",
			"propose <session.jsonl>",
			"preview <plan.json>",
			"create <plan.json> <token>",
			"--llm",
			"--model",
			"--output",
			"--omit-tool",
			"--calls-only-tool",
			"--full-tool",
			"EXAMPLES",
			"EXIT CODES",
		]) {
			assert.ok(help.stdout.includes(word), word);
		}
		for (const args of [["-h"], ["help"], [], ["propose", "--help"]]) {
			const other = cli(...args);
			assert.equal(other.status, 0, args.join(" "));
			assert.equal(other.stdout, help.stdout, args.join(" "));
		}
	});

	it("names the valid subcommands in a one-line error and exits 2", () => {
		const result = cli("bogus");
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr.trim().split("\n").length, 1);
		assert.match(result.stderr, /Unknown subcommand "bogus"/);
		assert.match(result.stderr, /inspect, propose, preview, create/);
		assert.equal(cli("inspect").status, 2);
		assert.equal(cli("preview", "a", "b").status, 2);
	});

	it("still prints the inspection as JSON", async () => {
		const files = await fixture();
		const result = cli("inspect", files.sourcePath);
		assert.equal(result.status, 0);
		assert.deepEqual(
			JSON.parse(result.stdout),
			JSON.parse(JSON.stringify(await inspectRetrospectiveSession(files.sourcePath))),
		);
	});
});
