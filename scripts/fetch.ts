/** Shared fetch type and Bun-compatible adapter for test transports. */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function asFetch(fn: FetchFn): typeof fetch {
	return Object.assign(fn, { preconnect: () => {} });
}
