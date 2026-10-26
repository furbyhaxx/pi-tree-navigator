/**
 * Model and classifier picker for `/anchor settings`.
 *
 * A fuzzy `FrameList` over the registry's available models, a thinking-level
 * step for chat models and one row that takes a hand-typed selector for a
 * provider that is not available here. It only reads the registry and returns
 * the chosen text: it saves nothing and never switches the session's model.
 */
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	parseClassifierModel,
	RECOMMENDED_INTENT_CLASSIFIER,
	RECOMMENDED_POLICY,
} from "../continuity/intent-policy.ts";
import { parseProposalModel } from "../retrospective/proposal-options.ts";
import { type FrameRow, sanitizeTerminalText, selectFrame } from "./frame.ts";

/** A chat model with thinking, a classifier, or either model type for a policy stage. */
export interface SettingsModelPickerOptions {
	kind: "model" | "classifier" | "stage";
	/** The configured value: a selector, `current`, `recommended` (classifier), or null for a disabled classifier. */
	current: string | null;
}

const BREADCRUMBS = ["Anchor", "Settings"] as const;
const SELECTED = "● selected";
const DEFAULT_THINKING: ModelThinkingLevel = "medium";

interface Choice {
	row: FrameRow;
	selected: boolean;
	/** The final value, or undefined to return to the list. */
	pick(): Promise<string | null | undefined>;
}

interface Listed {
	provider: string;
	id: string;
	name: string;
	levels: readonly ModelThinkingLevel[];
	model?: Model<Api>;
}

interface Configured {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

function isSafe(text: string): boolean {
	return sanitizeTerminalText(text) === text;
}

function llmSelector(provider: string, id: string, level: ModelThinkingLevel): string | undefined {
	const text = `${provider}/${id}:${level}`;
	if (!isSafe(text)) return undefined;
	try {
		const parsed = parseProposalModel(text);
		return parsed?.provider === provider && parsed.id === id && parsed.thinking === level
			? text
			: undefined;
	} catch {
		return undefined;
	}
}

function classifierSelector(provider: string, id: string): string | undefined {
	const text = `${provider}/${id}`;
	const parsed = parseClassifierModel(text);
	return isSafe(text) && parsed?.provider === provider && parsed.id === id ? text : undefined;
}

/** An object policy arrives as its canonical JSON text. */
const isObjectPolicy = (current: string | null): current is string =>
	current?.startsWith("{") === true;

function configuredModel(
	kind: SettingsModelPickerOptions["kind"],
	current: string | null,
): Configured | undefined {
	if (current === null || current === "current") return undefined;
	if (kind !== "model") {
		return isObjectPolicy(current) ? undefined : parseClassifierModel(current);
	}
	try {
		return parseProposalModel(current);
	} catch {
		return undefined;
	}
}

function byName(a: Listed, b: Listed): number {
	return (
		a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
	);
}

async function listModels(
	ctx: ExtensionCommandContext,
	kind: SettingsModelPickerOptions["kind"],
): Promise<Listed[]> {
	const registry = ctx.modelRegistry;
	try {
		if (kind !== "model") {
			const models = [
				...(await registry.getAvailableOfType("classifier")),
				...(kind === "stage" ? registry.getAvailable() : []),
			];
			return [
				...new Map(
					models.map((model) => [
						`${model.provider}/${model.id}`,
						{
							provider: model.provider,
							id: model.id,
							name: model.name || model.id,
							levels: [],
						},
					]),
				).values(),
			];
		}
		return registry.getAvailable().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			levels: getSupportedThinkingLevels(model),
			model,
		}));
	} catch (error) {
		ctx.ui.notify(
			`Could not list available models: ${error instanceof Error ? error.message : String(error)}. Type one with the custom row.`,
			"warning",
		);
		return [];
	}
}

/** Entries whose selector would not round-trip through the real parsers are not offered. */
function usable(kind: SettingsModelPickerOptions["kind"], entry: Listed): boolean {
	return kind !== "model"
		? classifierSelector(entry.provider, entry.id) !== undefined
		: entry.levels.length > 0 &&
				llmSelector(entry.provider, entry.id, entry.levels[0]) !== undefined;
}

async function pickThinking(
	ctx: ExtensionCommandContext,
	entry: Listed,
	configured: Configured | undefined,
): Promise<string | undefined> {
	const { provider, id, levels } = entry;
	if (levels.length === 1) return llmSelector(provider, id, levels[0]);
	const sameModel = configured?.provider === provider && configured.id === id;
	const wanted = entry.model
		? clampThinkingLevel(entry.model, configured?.thinking ?? DEFAULT_THINKING)
		: levels[0];
	const rows: FrameRow[] = levels.map((level) => ({
		label: level,
		...(sameModel && configured.thinking === level && { value: SELECTED, tone: "success" }),
	}));
	const choice = await selectFrame(ctx, {
		breadcrumbs: [...BREADCRUMBS, "Model", "Thinking"],
		rows,
		cursor: Math.max(0, levels.indexOf(wanted)),
		placeholder: `Thinking level for ${provider}/${id}`,
		cancelAction: "back",
	});
	return choice ? llmSelector(provider, id, levels[choice.index]) : undefined;
}

function customError(kind: SettingsModelPickerOptions["kind"], text: string): string | undefined {
	if (!isSafe(text)) return "it contains control characters";
	if (kind !== "model") {
		return parseClassifierModel(text) ? undefined : "expected provider/id";
	}
	try {
		parseProposalModel(text);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

async function promptCustom(
	ctx: ExtensionCommandContext,
	kind: SettingsModelPickerOptions["kind"],
): Promise<string | undefined> {
	const expects = kind === "model" ? "current or provider/id[:thinking]" : "provider/id";
	while (true) {
		const text = (
			await ctx.ui.input(kind === "classifier" ? "Custom classifier" : "Custom model", expects)
		)?.trim();
		if (!text) return undefined;
		const error = customError(kind, text);
		if (!error) return text;
		ctx.ui.notify(`${JSON.stringify(text)} is not valid: ${error}. Use ${expects}.`, "warning");
	}
}

function buildChoices(
	ctx: ExtensionCommandContext,
	options: SettingsModelPickerOptions,
	listed: readonly Listed[],
): Choice[] {
	const { kind, current } = options;
	const configured = configuredModel(kind, current);
	const isConfigured = (entry: Listed) =>
		configured?.provider === entry.provider && configured.id === entry.id;
	const sorted = listed.filter((entry) => usable(kind, entry)).sort(byName);
	const ordered = [
		...sorted.filter(isConfigured),
		...sorted.filter((entry) => !isConfigured(entry)),
	];

	const sentinel: Choice =
		kind === "model"
			? {
					row: { label: "current", labelHint: "follow the session model" },
					selected: current === "current",
					pick: async () => "current",
				}
			: {
					row: {
						label: "off",
						labelHint: kind === "stage" ? "disable this stage" : "heuristics only",
					},
					selected: current === null,
					pick: async () => null,
				};

	const recommended: Choice[] =
		kind === "classifier"
			? [
					{
						row: {
							label: RECOMMENDED_INTENT_CLASSIFIER,
							labelHint: `${RECOMMENDED_POLICY.classifier}, then ${RECOMMENDED_POLICY.escalation} for replacements`,
						},
						selected: current === RECOMMENDED_INTENT_CLASSIFIER,
						pick: async () => RECOMMENDED_INTENT_CLASSIFIER,
					},
				]
			: [];

	const objectPolicy: Choice[] =
		kind === "classifier" && isObjectPolicy(current)
			? [
					{
						row: {
							label: "object policy",
							labelHint: "configured; edit the settings file to change it",
							value: SELECTED,
							tone: "success",
						},
						selected: true,
						pick: async () => {
							ctx.ui.notify(
								"continuity.intentClassifier is an object policy; edit it in the settings file.",
								"warning",
							);
							return undefined;
						},
					},
				]
			: [];

	const models = ordered.map((entry): Choice => {
		const selected = isConfigured(entry);
		return {
			selected,
			row: {
				label: entry.name,
				labelHint: entry.provider,
				detail: `${entry.provider}/${entry.id}`,
				...(selected && { value: SELECTED, tone: "success" }),
			},
			pick: async () =>
				kind !== "model"
					? classifierSelector(entry.provider, entry.id)
					: pickThinking(ctx, entry, configured),
		};
	});

	const unlisted: Choice[] =
		configured && current !== null && !ordered.some(isConfigured)
			? [
					{
						selected: true,
						row: {
							label: current,
							labelHint: "configured, not available",
							value: SELECTED,
							tone: "success",
						},
						pick: async () => current,
					},
				]
			: [];

	const custom: Choice = {
		row: {
			label: "custom",
			labelHint: kind === "model" ? "type provider/id[:thinking]" : "type provider/id",
		},
		selected: false,
		pick: () => promptCustom(ctx, kind),
	};
	return [sentinel, ...recommended, ...objectPolicy, ...unlisted, ...models, custom];
}

/**
 * Let the user choose a model for a setting. Resolves with `current` to follow
 * the session model, null for a disabled classifier, `recommended` for the
 * benchmarked classifier policy, an exact
 * `provider/id:thinking` selector (model) or `provider/id` (classifier), and
 * undefined when the user cancels. The session's model and thinking level are
 * never changed and no provider is called.
 */
export async function pickSettingsModel(
	ctx: ExtensionCommandContext,
	options: SettingsModelPickerOptions,
): Promise<string | null | undefined> {
	const { kind } = options;
	const choices = buildChoices(ctx, options, await listModels(ctx, kind));
	const rows = choices.map((choice) => choice.row);
	let cursor = Math.max(
		0,
		choices.findIndex((choice) => choice.selected),
	);
	while (true) {
		const chosen = await selectFrame(ctx, {
			breadcrumbs: [...BREADCRUMBS, kind === "classifier" ? "Classifier" : "Model"],
			rows,
			cursor,
			placeholder:
				kind !== "classifier"
					? "Type to search models, ids, or providers…"
					: "Type to search classifiers, ids, or providers…",
			cancelAction: "back",
		});
		if (!chosen) return undefined;
		cursor = chosen.index;
		const result = await choices[cursor].pick();
		if (result !== undefined) return result;
	}
}
