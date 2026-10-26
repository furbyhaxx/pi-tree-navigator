import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRuntime,
	type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { estimateAdmissionTokens } from "../../extensions/navigate-tree/index.ts";
import { safeMessage } from "../classifier-eval/adapters.ts";
import { createBilling, loadRouteTable, ROUTE_PRICES_URL } from "../classifier-eval/billing.ts";
import { BudgetLedger } from "../classifier-eval/budget.ts";
import { buildCorpus, seedCorpus } from "./fixture.ts";
import { createBudgetedTransport } from "./transport.ts";

/** Disposable native-CLI observer. All provider bodies are captured by the budget transport. */
export default function tuiObserver(pi: ExtensionAPI): void {
	let session: AgentSession | undefined;
	let ledger: BudgetLedger | undefined;
	let transport: ReturnType<typeof createBudgetedTransport> | undefined;
	let restoreRuntime: (() => void) | undefined;
	let originalPrompt: typeof AgentSession.prototype.prompt | undefined;
	let stopped = false;
	let initialized = false;
	let settled = 0;
	let calls = 0;
	let sideCalls = 0;
	let out = "";
	let target = "";
	let sm: SessionManager | undefined;
	let finishing: Promise<void> | undefined;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const save = (name: string, value: unknown) =>
		writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	const capture = (name: string) => {
		try {
			writeFileSync(
				join(out, `${name}.txt`),
				execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", target]),
				{ flag: "wx", mode: 0o600 },
			);
		} catch {
			appendFileSync(
				join(out, "capture-errors.jsonl"),
				`${JSON.stringify({ name, at: new Date().toISOString() })}\n`,
			);
		}
	};
	const captureSoon = (name: string) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			capture(name);
		}, 250);
		timers.add(timer);
		timer.unref();
	};
	const finish = (reason: string): Promise<void> => {
		finishing ??= (async () => {
			stopped = true;
			try {
				await transport?.drain();
				for (const timer of timers) clearTimeout(timer);
				timers.clear();
				capture("terminal-stop");
				save("stopped.json", {
					reason,
					session: sm?.getSessionFile(),
					calls,
					sideCalls,
					budget: ledger?.snapshot(),
					branch: sm?.getBranch().map((entry) => ({ id: entry.id, type: entry.type })),
				});
			} finally {
				restoreRuntime?.();
				if (originalPrompt) AgentSession.prototype.prompt = originalPrompt;
				ledger?.close();
			}
		})();
		return finishing;
	};
	const installRuntime = (actual: AgentSession) => {
		if (!initialized || stopped)
			throw new Error("Acceptance observer is not ready; dispatch refused");
		if (session && session !== actual)
			throw new Error("Acceptance allows only one disposable session");
		if (session) return;
		session = actual;
		if (actual.sessionManager !== sm) throw new Error("Acceptance session ownership mismatch");
		const runtime = actual.modelRuntime;
		const model = actual.model;
		if (
			!runtime ||
			typeof runtime.streamSimple !== "function" ||
			typeof runtime.classify !== "function"
		)
			throw new Error("Installed runtime lacks the metering seam; dispatch refused");
		if (model?.provider !== "openrouter" || model.id !== process.env.FOLD_TUI_MODEL)
			throw new Error("Selected route differs from the requested registry route");
		if (model.contextWindow < 96000 || model.maxTokens < 8192)
			throw new Error("Registry route cannot support the controlled 96k/8192 window");
		Object.assign(model, { contextWindow: 96000, maxTokens: 8192 });
		const initialTokens = estimateAdmissionTokens(actual.sessionManager);
		if (initialTokens + 16384 >= 96000)
			throw new Error("Synthetic corpus does not fit with output/headroom; dispatch refused");
		actual.agent.state.messages = actual.sessionManager.buildSessionContext().messages;
		ledger = BudgetLedger.open(process.env.FOLD_TUI_LEDGER ?? "", 25);
		const beforeBudget = ledger.snapshot();
		transport = createBudgetedTransport({
			fetch: globalThis.fetch,
			ledger,
			models: {
				routes: loadRouteTable(ROUTE_PRICES_URL),
				models: [{ id: model.id, kind: "chat", cost: model.cost }],
			},
			billing: createBilling({
				getApiKey: async () => (await runtime.getAuth("openrouter"))?.auth.apiKey,
			}),
			record: (record) => {
				appendFileSync(join(out, "wire.jsonl"), `${JSON.stringify(record)}\n`, {
					mode: 0o600,
				});
				captureSoon(`response-${record.reservationId}`);
			},
		});
		const fetch = transport.fetch;
		const stream = runtime.streamSimple;
		const classify = runtime.classify;
		const blocked = new Map<string, unknown>();
		const runtimeMethods = runtime as unknown as Record<string, unknown>;
		for (const key of [
			"stream",
			"streamDeferred",
			"completeDeferred",
			"cancelDeferred",
			"generateImages",
		]) {
			blocked.set(key, runtimeMethods[key]);
			runtimeMethods[key] = () => {
				throw new Error(`Acceptance refuses unsupported runtime method ${key}`);
			};
		}
		runtime.streamSimple = ((selected, context, options) => {
			if (stopped || selected.provider !== "openrouter" || selected.id !== model.id)
				throw new Error("Acceptance refuses stopped or unpriced model dispatch");
			const side = options?.toolChoice === "none";
			calls++;
			if (side) sideCalls++;
			appendFileSync(
				join(out, "calls.jsonl"),
				`${JSON.stringify({ call: calls, side, model: selected.id, messages: context.messages.length, at: new Date().toISOString() })}\n`,
			);
			captureSoon(`request-${calls}-${side ? "summarizing" : "main"}`);
			return stream.call(runtime, { ...selected, contextWindow: 96000, maxTokens: 8192 }, context, {
				...options,
				fetch,
				maxRetries: 0,
				maxTokens: Math.min(options?.maxTokens ?? 8192, 8192),
			});
		}) as ModelRuntime["streamSimple"];
		runtime.classify = ((selected, context, options) => {
			if (stopped) throw new Error("Acceptance is stopped");
			// Unpriced classifier routes are rejected by the transport before dispatch.
			return classify.call(runtime, selected, context, {
				...options,
				fetch,
				maxRetries: 0,
			});
		}) as ModelRuntime["classify"];
		restoreRuntime = () => {
			runtime.streamSimple = stream;
			runtime.classify = classify;
			for (const [key, value] of blocked) runtimeMethods[key] = value;
		};
		save("runtime.json", {
			model: `${model.provider}/${model.id}`,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			initialTokens,
			beforeBudget,
			session: sm?.getSessionFile(),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (originalPrompt) throw new Error("Acceptance observer cannot reload or replace sessions");
		originalPrompt = AgentSession.prototype.prompt;
		const previous = originalPrompt;
		AgentSession.prototype.prompt = async function (...args) {
			if (args[0].trim() === "/acceptance-stop") return previous.apply(this, args);
			try {
				installRuntime(this);
			} catch (error) {
				stopped = true;
				if (isAbsolute(out))
					save("initialization-error.json", {
						error: safeMessage(error),
						dispatched: false,
					});
				throw new Error(
					"Acceptance initialization failed; no provider dispatch permitted. Inspect initialization-error.json.",
				);
			}
			return previous.apply(this, args);
		};
		out = process.env.FOLD_TUI_OUT ?? "";
		target = process.env.FOLD_TUI_TARGET ?? "";
		if (!isAbsolute(out) || !isAbsolute(process.env.FOLD_TUI_LEDGER ?? ""))
			throw new Error("Acceptance requires absolute evidence and shared-ledger paths");
		sm = ctx.sessionManager as SessionManager;
		if (
			sm.getEntries().some((entry) => entry.type === "message" || entry.type === "branch_summary")
		)
			throw new Error("Acceptance requires a new disposable session");
		const fixture = JSON.parse(readFileSync(join(out, "fixture.json"), "utf8")) as {
			corpus: string[];
		};
		const corpus = buildCorpus(15);
		if (JSON.stringify(fixture.corpus) !== JSON.stringify(corpus))
			throw new Error("Acceptance fixture mismatch");
		seedCorpus(sm, corpus);
		initialized = true;
		captureSoon("terminal-launch");
		save("observer-ready.json", {
			session: sm.getSessionFile(),
			seededBlocks: corpus.length,
			promptWrapped: true,
		});
	});
	pi.on("agent_settled", (_event, ctx) => {
		settled++;
		save(`settled-${settled}.json`, {
			session: ctx.sessionManager.getSessionFile(),
			calls,
			sideCalls,
			budget: ledger?.snapshot(),
			summaries: ctx.sessionManager.getBranch().filter((entry) => entry.type === "branch_summary"),
		});
		captureSoon(`settled-${settled}`);
	});
	pi.registerCommand("acceptance-stop", {
		description: "Drain disposable acceptance transport, record budget/session, and exit",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			await finish("acceptance-stop");
			ctx.shutdown();
		},
	});
	pi.on("session_before_switch", async () => ({ cancel: true }));
	pi.on("session_before_fork", async () => ({ cancel: true }));
	pi.on("session_shutdown", async (event, ctx: ExtensionContext) => {
		if (out) await finish(`session_shutdown:${event.reason}`);
		if (event.reason !== "quit") ctx.shutdown();
	});
}
