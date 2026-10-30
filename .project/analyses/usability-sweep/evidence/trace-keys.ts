import { appendFileSync } from "node:fs";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const trace = (event: object) => {
	const path = process.env.ROUTING_TRACE;
	if (path) appendFileSync(path, `${JSON.stringify(event)}\n`);
};

export default function (pi: any) {
	const onData = (data: Buffer | string) => trace({ stage: "stdin", data: data.toString() });
	let restore: (() => void) | undefined;
	pi.on("session_start", () => {
		trace({ stage: "start" });
		process.stdin.prependListener("data", onData);
	});
	pi.on("session_shutdown", () => {
		restore?.();
		process.stdin.removeListener("data", onData);
	});
	pi.registerCommand("route-probe", {
		description: "Install temporary key-routing instrumentation",
		handler: async (_args: string, ctx: any) => {
			await ctx.ui.custom((tui: any, _theme: any, keys: any, done: (x: undefined) => void) => {
				const oldFocus = tui.setFocus;
				const wrapped = new WeakSet();
				const remove = tui.addInputListener((data: string) => {
					trace({ stage: "host-listener", data });
				});
				tui.setFocus = function (component: any) {
					if (component?.constructor?.name === "FrameList" && !wrapped.has(component)) {
						wrapped.add(component);
						const handle = component.handleInput;
						component.handleInput = function (data: string) {
							trace({ stage: "frame", panel: component.options.breadcrumbs.join("/"), data, cancel: keys.matches(data, "tui.select.cancel"), cancelKeys: keys.getKeys("tui.select.cancel"), altS: matchesKey(data, Key.alt("s")), altT: matchesKey(data, Key.alt("t")), cursor: component.cursor, query: component.search });
							return handle.call(component, data);
						};
					}
					return oldFocus.call(tui, component);
				};
				restore = () => { tui.setFocus = oldFocus; remove(); };
				trace({ stage: "probe-installed", cancelKeys: keys.getKeys("tui.select.cancel"), selectPageDown: keys.getKeys("tui.select.pageDown"), viewportPageDown: keys.getKeys("tui.altScreen.pageDown") });
				setTimeout(() => done(undefined), 0);
				return { render: () => [], invalidate() {}, handleInput() {} };
			});
		},
	});
	if (process.env.ROUTING_SHORTCUT === "1") {
		pi.registerShortcut("alt+s", { description: "Synthetic routing probe", handler: () => trace({ stage: "extension-shortcut", key: "alt+s" }) });
	}
}
