#!/usr/bin/env node
import { join, resolve } from "node:path";
import {
	buildSessionContext,
	getAgentDir,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { loadTreeNavigatorConfig, TREE_NAVIGATOR_CONFIG_FILENAME } from "../src/core/config.ts";
import {
	formatProposalOutline,
	parseProposalArguments,
	saveTreeProposal,
	validateTreeProposal,
} from "../src/retrospective/proposal-command.ts";
import { proposeTree } from "../src/retrospective/proposal-engine.ts";
import {
	createProposalModelRunner,
	resolveProposalModel,
} from "../src/retrospective/proposal-model.ts";
import { mergeProposalOptions } from "../src/retrospective/proposal-options.ts";
import {
	cloneRetrospectiveSession,
	previewRetrospectiveSession,
} from "../src/retrospective/retrospective.ts";
import {
	inspectRetrospectiveSession,
	readSessionSnapshot,
	validateCompleteToolCalls,
} from "../src/retrospective/retrospective-plan.ts";

const SUBCOMMANDS = ["inspect", "propose", "preview", "create"];
const COMMAND = "node scripts/restructure-session.mjs";

class UsageError extends Error {}

const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

const HELP = [
	[
		"DESCRIPTION",
		[
			"Restructure a Pi session into a reviewable chronological tree, offline.",
			"Source sessions are never modified; create publishes a new session family.",
		],
	],
	["USAGE", [`${COMMAND} <subcommand> [arguments]`, `${COMMAND} help | --help | -h`]],
	[
		"SUBCOMMANDS",
		[
			["inspect <session.jsonl>", "Print graph metadata, stable entry IDs and the source SHA-256."],
			[
				"propose <session.jsonl> [flags]",
				"Derive a tree plan locally; --llm asks a model to refine it.",
			],
			[
				"preview <plan.json>",
				"Validate the whole plan and print the review, including previewToken. Writes nothing.",
			],
			[
				"create <plan.json> <token>",
				"Publish the clone. <token> is the previewToken of a reviewed preview.",
			],
		],
	],
	[
		"PROPOSE FLAGS",
		[
			[
				"--llm",
				"Refine with a model. Sends the permitted textual history; long inputs need several requests.",
			],
			[
				"--model <provider/model:thinking>",
				"Model to use; implies --llm. Default: global treeProposal.model, then the source's recorded model.",
			],
			[
				"--output <plan.json>",
				"Save the plan as a NEW private file. Existing files are never overwritten.",
			],
			["--omit-tool <name>", "Leave this tool's calls and results out of model requests."],
			["--calls-only-tool <name>", "Send this tool's calls but not its results."],
			["--full-tool <name>", "Send this tool's calls and results in full."],
		],
	],
	[
		"NOTES",
		[
			"Inspect, heuristic proposals, preview and create make no model calls.",
			"Project config is not read by this offline CLI; use flags for project-specific model and disclosure rules.",
			"Descendant histories are copied unchanged unless the plan sets recurse and lists reviewed descendantPlans.",
			"Success prints JSON on stdout; progress and warnings go to stderr.",
		],
	],
	[
		"EXAMPLES",
		[
			`${COMMAND} inspect session.jsonl`,
			`${COMMAND} propose session.jsonl --output plan.json`,
			`${COMMAND} propose session.jsonl --llm --omit-tool read --output plan.json`,
			`${COMMAND} preview plan.json`,
			`${COMMAND} create plan.json <previewToken>`,
		],
	],
	[
		"EXIT CODES",
		[
			["0", "Success, or help shown."],
			["1", "Runtime failure: invalid plan, changed source, model error."],
			["2", "Usage error: unknown subcommand, missing or extra arguments."],
			["130", "Interrupted."],
		],
	],
];

function wrap(text, width) {
	const lines = [];
	let line = "";
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
		} else line = line ? `${line} ${word}` : word;
	}
	return [...lines, line];
}

function helpText() {
	const columns = Math.min(Math.max(process.stdout.columns ?? 80, 40), 100);
	const out = [];
	for (const [title, body] of HELP) {
		out.push(paint("1", title));
		const rows = body.filter(Array.isArray);
		const column = Math.min(36, Math.max(0, ...rows.map(([label]) => label.length)) + 4);
		for (const row of body) {
			if (!Array.isArray(row)) {
				const literal = title === "USAGE" || title === "EXAMPLES";
				out.push(...(literal ? [row] : wrap(row, columns - 2)).map((line) => `  ${line}`));
				continue;
			}
			const [label, text] = row;
			const style = title === "SUBCOMMANDS" ? "36" : title === "PROPOSE FLAGS" ? "32" : "1";
			const gap = " ".repeat(Math.max(2, column - label.length));
			const [first, ...rest] = wrap(text, Math.max(20, columns - 2 - column));
			out.push(`  ${paint(style, label)}${gap}${first}`);
			out.push(...rest.map((line) => `  ${" ".repeat(column)}${line}`));
		}
		out.push("");
	}
	return out.join("\n").trimEnd();
}

const ARGUMENTS = {
	inspect: ["<session.jsonl>"],
	preview: ["<plan.json>"],
	create: ["<plan.json>", "<token>"],
};
const usageError = (message) => new UsageError(`${message} Run with --help for usage.`);

const [action, ...args] = process.argv.slice(2);
const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
try {
	const wantsHelp =
		!action ||
		["help", "--help", "-h"].includes(action) ||
		(SUBCOMMANDS.includes(action) && args.some((arg) => arg === "--help" || arg === "-h"));
	if (wantsHelp) console.log(helpText());
	else if (!SUBCOMMANDS.includes(action))
		throw usageError(
			`Unknown subcommand "${action}". Valid subcommands: ${SUBCOMMANDS.join(", ")}.`,
		);
	else {
		let result;
		if (action === "propose") {
			let parsed;
			try {
				parsed = parseProposalArguments(args);
			} catch (error) {
				throw usageError(`${error instanceof Error ? error.message : String(error)}.`);
			}
			if (!parsed.source) throw usageError("propose requires <session.jsonl>.");
			const snapshot = await readSessionSnapshot(resolve(parsed.source));
			validateCompleteToolCalls(snapshot);
			const loaded = await loadTreeNavigatorConfig({
				agentDir: getAgentDir(),
				projectPath: join(process.cwd(), ".pi", TREE_NAVIGATOR_CONFIG_FILENAME),
				projectTrusted: false,
			});
			for (const warning of loaded.warnings) console.error(warning);
			if (parsed.llm && loaded.config.proposalError) throw new Error(loaded.config.proposalError);
			const input = mergeProposalOptions(loaded.config.proposal ?? { tools: {} }, parsed.input);
			let model;
			if (parsed.llm) {
				const registry = new ModelRegistry(
					await ModelRuntime.create({ allowModelNetwork: false, signal: controller.signal }),
				);
				const state = buildSessionContext(snapshot.entries);
				const currentModel = state.model
					? registry.find(state.model.provider, state.model.modelId)
					: undefined;
				model = createProposalModelRunner({
					registry,
					...resolveProposalModel({
						registry,
						currentModel,
						currentThinking: state.thinkingLevel,
						selector: input.model,
					}),
				});
				console.error(
					`Analyzing full permitted textual history with ${model.name}; provider charges may apply.`,
				);
			}
			const proposal = validateTreeProposal(
				snapshot,
				await proposeTree(snapshot, {
					input,
					model,
					signal: controller.signal,
					onProgress: (message) => console.error(message),
				}),
			);
			const planPath = parsed.output
				? await saveTreeProposal(snapshot, proposal.plan, resolve(parsed.output))
				: undefined;
			result = {
				...proposal,
				outline: formatProposalOutline(proposal.plan),
				...(planPath ? { planPath } : {}),
			};
		} else {
			const expected = ARGUMENTS[action];
			if (args.length < expected.length)
				throw usageError(`${action} requires ${expected.join(" ")}.`);
			if (args.length > expected.length)
				throw usageError(
					`${action} takes ${expected.join(" ")} only; unexpected "${args[expected.length]}".`,
				);
			const [path, token] = args;
			if (action === "inspect") result = await inspectRetrospectiveSession(resolve(path));
			else if (action === "preview") result = await previewRetrospectiveSession(resolve(path));
			else result = await cloneRetrospectiveSession(resolve(path), token);
		}
		console.log(JSON.stringify(result, null, 2));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = controller.signal.aborted ? 130 : error instanceof UsageError ? 2 : 1;
} finally {
	process.removeListener("SIGINT", abort);
}
