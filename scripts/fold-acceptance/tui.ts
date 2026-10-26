import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildCorpus, corpusManifest, FACTS } from "./fixture.ts";

/** Disposable native-terminal controls; the ledger must be shared with other acceptance runs. */
export interface TuiOptions {
	out: string;
	ledger: string;
	authDir: string;
	model: string;
	target: string;
	width: 60 | 130;
	mode: "fullscreen" | "regular";
	theme: "dark" | "light";
	dryRun: boolean;
}

/** Parse without loading credentials, models or provider runtimes. */
export function parseTuiOptions(args: string[]): TuiOptions {
	const { values } = parseArgs({
		args,
		options: {
			out: { type: "string" },
			ledger: { type: "string" },
			"auth-dir": {
				type: "string",
				default: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
			},
			model: { type: "string", default: "openai/gpt-6-luna" },
			target: { type: "string", default: "fold-native-acceptance" },
			width: { type: "string", default: "130" },
			mode: { type: "string", default: "fullscreen" },
			theme: { type: "string", default: "dark" },
			"dry-run": { type: "boolean", default: false },
		},
	});
	if (!values.out) throw new Error("--out must name a new evidence directory");
	if (!values.ledger || !isAbsolute(values.ledger))
		throw new Error("--ledger must be the absolute shared budget ledger path");
	if (!/^[a-zA-Z0-9_-]+$/u.test(values.target))
		throw new Error("--target must contain only letters, digits, _ or -");
	if (values.width !== "60" && values.width !== "130") throw new Error("--width must be 60 or 130");
	if (values.mode !== "fullscreen" && values.mode !== "regular")
		throw new Error("--mode must be fullscreen or regular");
	if (values.theme !== "dark" && values.theme !== "light")
		throw new Error("--theme must be dark or light");
	return {
		out: resolve(values.out),
		ledger: values.ledger,
		authDir: resolve(values["auth-dir"]),
		model: values.model,
		target: values.target,
		width: Number(values.width) as 60 | 130,
		mode: values.mode,
		theme: values.theme,
		dryRun: values["dry-run"],
	};
}

/** Write an exclusive plan; only a non-dry invocation launches the native Pi-Bolt CLI. */
export async function launchTui(
	options: TuiOptions,
	launch: (args: string[]) => void = (args) => {
		execFileSync("tmux", args, { stdio: "inherit" });
	},
): Promise<void> {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const corpus = buildCorpus(15);
	const fixtureTokens = Math.ceil(corpus.reduce((sum, text) => sum + text.length, 0) / 3.5) + 4096;
	if (fixtureTokens + 16384 >= 96000)
		throw new Error("Synthetic fixture cannot fit the controlled 96k window with headroom");
	const settings = {
		compaction: { enabled: false },
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		cacheWarming: "off",
		defaultThinkingLevel: "off",
		quietStartup: true,
		enableInstallTelemetry: false,
		enableAnalytics: false,
		theme: options.theme,
		tuiMode: options.mode,
	};
	const navigator = {
		continuity: { capture: false, intentClassifier: null },
		auto_navigate: { enabled: false },
		rewindHintReserveTokens: false,
	};
	const scratch = join(options.out, "scratch");
	const agentDir = join(scratch, "agent");
	const cwd = join(scratch, "workspace");
	const prompt = "Reply READY only; do not fold or call tools";
	const command = [
		"env",
		`PI_CODING_AGENT_DIR=${agentDir}`,
		"PI_OFFLINE=1",
		"PI_TELEMETRY=0",
		`PI_TUI_WRITE_LOG=${join(options.out, "terminal.ansi")}`,
		`FOLD_TUI_OUT=${options.out}`,
		`FOLD_TUI_LEDGER=${options.ledger}`,
		`FOLD_TUI_TARGET=${options.target}`,
		`FOLD_TUI_MODEL=${options.model}`,
		"pi-bolt",
		"--offline",
		"--no-extensions",
		"--no-context-files",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		join(root, "src/index.ts"),
		"-e",
		join(root, "scripts/fold-acceptance/tui-observer.ts"),
		"--model",
		`openrouter/${options.model}`,
		"--thinking",
		"off",
		"--tools",
		"navigate_tree",
		"--session-dir",
		join(options.out, "sessions"),
		"--system-prompt",
		"You are evaluating a synthetic service audit. Preserve explicit constraints and remaining work. Do not modify files. Only fold when explicitly requested by the user.",
		"--tui-mode",
		options.mode,
	];
	mkdirSync(dirname(options.out), { recursive: true });
	mkdirSync(options.out);
	const save = (name: string, data: unknown) =>
		writeFileSync(join(options.out, name), `${JSON.stringify(data, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	save("fixture.json", {
		facts: FACTS,
		corpus,
		manifest: corpusManifest(corpus),
	});
	save("launch.json", {
		dryRun: options.dryRun,
		bootstrapPrompt: prompt,
		startedAt: new Date().toISOString(),
		sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
		dirtyPaths: execFileSync(
			"git",
			["status", "--porcelain", "--", "src", "scripts", "package.json", "tsconfig.json"],
			{ cwd: root, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.filter(Boolean),
		scratch,
		cwd,
		command,
		settings,
		navigator,
		contextWindow: 96000,
		maxTokens: 8192,
		capUsd: 25,
		fixtureTokensWithOverhead: fixtureTokens,
		ledger: options.ledger,
		manual: [
			`tmux attach -t ${options.target}`,
			`tmux send-keys -t ${options.target} -l '/anchor fold'`,
			`tmux send-keys -t ${options.target} Enter`,
			"Select audit-start, use a fresh label audit-folded and a focus preserving all five audit facts and remaining comparison work; confirm in the real panel.",
			`tmux capture-pane -p -J -t ${options.target} > '${options.out}/fold-panel.txt'`,
			"Wait for summary completion, inspect progress captures and the persisted branch_summary, then send /acceptance-stop (Enter).",
			"Wait for stopped.json and process exit before killing the tmux session. Keep evidence, including any failed run; remove only its scratch directory after shutdown.",
		],
	});
	if (options.dryRun) {
		console.log(
			`Dry run: zero runtime/provider calls; no CLI, tmux, auth reads or ledger changes. Plan: ${join(options.out, "launch.json")}`,
		);
		return;
	}
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd);
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const source = join(options.authDir, file);
		if (existsSync(source)) symlinkSync(source, join(agentDir, file));
	}
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	writeFileSync(join(agentDir, "tree-navigator.json"), JSON.stringify(navigator));
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	launch([
		"new-session",
		"-d",
		"-s",
		options.target,
		"-x",
		String(options.width),
		"-y",
		"42",
		"-c",
		cwd,
		command.map(quote).join(" "),
	]);
	await new Promise<void>((accept, reject) => {
		const ready = join(options.out, "observer-ready.json");
		const watcher = watch(options.out, () => {
			if (existsSync(ready)) {
				clearTimeout(timer);
				watcher.close();
				accept();
			}
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(
				new Error(
					"Observer did not become ready; no bootstrap prompt sent. Retain failed evidence and inspect the native terminal.",
				),
			);
		}, 30000);
		if (existsSync(ready)) {
			clearTimeout(timer);
			watcher.close();
			accept();
		}
	});
	launch(["send-keys", "-t", options.target, "-l", prompt]);
	launch(["send-keys", "-t", options.target, "Enter"]);
	console.log(
		`Native terminal launched: ${options.target}; evidence: ${options.out}. Wait for settled-1.json, drive /anchor fold manually; finish with /acceptance-stop.`,
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await launchTui(parseTuiOptions(process.argv.slice(2)));
