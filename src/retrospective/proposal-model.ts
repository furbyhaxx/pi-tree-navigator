import { type Api, clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { ProposalRequestError } from "./proposal-engine.ts";
import { parseProposalModel } from "./proposal-options.ts";

/** Resolve a side-call model without changing the session's model or thinking level. */
export function resolveProposalModel(options: {
	registry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">;
	currentModel: Model<Api> | undefined;
	currentThinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	selector?: string;
}) {
	const selection = parseProposalModel(options.selector ?? "current");
	const model = selection
		? options.registry.find(selection.provider, selection.id)
		: options.currentModel;
	if (!model)
		throw new Error(
			`Proposal model not found: ${options.selector ?? "current"}. Select a model or use --model provider/model[:thinking].`,
		);
	if (!options.registry.hasConfiguredAuth(model))
		throw new Error(`No configured credentials for proposal model ${model.provider}/${model.id}`);
	const requestedThinking = selection?.thinking ?? options.currentThinking;
	const thinking = clampThinkingLevel(model, requestedThinking);
	if (selection?.thinking && thinking !== selection.thinking)
		throw new Error(
			`Proposal model ${model.provider}/${model.id} does not support thinking level ${selection.thinking}; its supported fallback is ${thinking}`,
		);
	return { model, thinking };
}

/** Build a provider-neutral proposal runner with registry-owned authentication. */
export function createProposalModelRunner(options: {
	registry: Pick<ModelRegistry, "streamSimple">;
	model: Model<Api>;
	thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}) {
	const { registry, model, thinking } = options;
	const maxOutputTokens = Math.min(model.maxTokens, Math.floor(model.contextWindow / 4));
	return {
		name: `${model.provider}/${model.id}:${thinking}`,
		contextWindow: model.contextWindow,
		maxOutputTokens,
		async complete(request: { systemPrompt: string; text: string; signal?: AbortSignal }) {
			request.signal?.throwIfAborted();
			const response = await registry
				.streamSimple(
					model,
					{
						systemPrompt: request.systemPrompt,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: request.text }],
								timestamp: Date.now(),
							},
						],
					},
					{
						signal: request.signal,
						reasoning: thinking === "off" ? undefined : thinking,
						maxTokens: maxOutputTokens,
						toolChoice: "none",
					},
				)
				.result();
			request.signal?.throwIfAborted();
			if (response.stopReason === "aborted")
				throw new DOMException("Tree proposal cancelled", "AbortError");
			if (response.stopReason === "error")
				throw new ProposalRequestError(
					`Proposal model request failed: ${response.errorMessage ?? "provider error"}`,
					response.usage,
				);
			if (response.stopReason === "length")
				throw new ProposalRequestError(
					"Proposal model reached its output limit; no incomplete plan will be accepted",
					response.usage,
				);
			return {
				text: response.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n"),
				usage: response.usage,
			};
		},
	};
}
