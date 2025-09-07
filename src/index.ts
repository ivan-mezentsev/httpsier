import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import { ReadableStream } from "node:stream/web";
import { WebSocket, type RawData } from "ws"; // bundled by esbuild
import tls from "node:tls";
import type { IncomingMessage, ClientRequest } from "node:http";

let __httpsierEmitWarningPatched = false;

type StrMap = Record<string, string>;

export interface CliOptions {
	readonly argv: readonly string[];
}

type ParsedArgs = {
	http: string;
	api: string;
	worker: string;
	json: boolean;
	slug?: string;
};

function printUsage(): void {
	console.error(
		"Usage: npx httpsier --http http://localhost:8080 --api [token] --worker https://<worker-host> [--json] [--slug name]"
	);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const out: Partial<ParsedArgs> & { json: boolean } = { json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined);
		if (a === "--json") {
			out.json = true;
			continue;
		}
		if (a === "--http") {
			out.http = next();
			i++;
			continue;
		}
		if (a === "--api") {
			out.api = next();
			i++;
			continue;
		}
		if (a === "--worker") {
			out.worker = next();
			i++;
			continue;
		}
		if (a === "--slug") {
			out.slug = next();
			i++;
			continue;
		}
	}
	return out as ParsedArgs;
}

function ensureUrl(u: string): URL {
	try {
		const withScheme = /^https?:\/\//i.test(u) ? u : `https://${u}`;
		return new URL(withScheme);
	} catch {
		throw new Error(`Invalid URL: ${u}`);
	}
}

function makeSlug(seed?: string): string {
	// Allow DNS-safe label: 1-63 chars, letters/digits/hyphens, no leading/trailing hyphen
	const isValid = (s: string) =>
		/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s);
	if (seed && isValid(seed)) return seed.toLowerCase();
	const rand = randomBytes(6).toString("hex");
	return rand;
}

function buildPublicUrl(worker: URL, slug: string): string {
	// wildcard subdomain style
	return `${worker.protocol}//${slug}.${worker.host}`;
}

function pickForwardHeaders(h: StrMap): StrMap {
	// Avoid forwarding hop-by-hop or security-sensitive headers from worker to local
	const blocked = new Set([
		"connection",
		"upgrade",
		"host",
		"content-length",
		"transfer-encoding",
	]);
	const out: StrMap = {};
	for (const k of Object.keys(h)) {
		if (blocked.has(k.toLowerCase())) continue;
		out[k] = h[k];
	}
	return out;
}

type DispatchHandle = {
	onReqBody: (chunkB64: string) => void;
	onReqEnd: () => void;
	done: Promise<{ ms: number; status: number; method: string; path: string }>;
};

function dispatchToLocal(
	base: URL,
	head: {
		id: string;
		method: string;
		url: string;
		headers: [string, string][];
		hasBody: boolean;
	},
	send: (msg: unknown) => void
): DispatchHandle {
	// Always disable TLS verification for local prefetch and suppress warnings
	// This affects only the current Node process and is intended for local development.
	try {
		if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0")
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		// Suppress only the specific warning about NODE_TLS_REJECT_UNAUTHORIZED
		if (!__httpsierEmitWarningPatched) {
			type EmitWarning = (
				warning: string | Error,
				name?: string,
				ctor?: { (...args: unknown[]): unknown }
			) => void;
			const orig: EmitWarning = (
				process.emitWarning as unknown as EmitWarning
			).bind(process);
			const wrapped: EmitWarning = (warning, name, ctor) => {
				const msg =
					typeof warning === "string"
						? warning
						: warning &&
							  typeof warning === "object" &&
							  "message" in warning
							? String((warning as Error).message)
							: String(warning);
				if (/NODE_TLS_REJECT_UNAUTHORIZED/i.test(msg)) return;
				orig(warning, name, ctor);
			};
			(process as unknown as { emitWarning: EmitWarning }).emitWarning =
				wrapped;
			__httpsierEmitWarningPatched = true;
		}
		// Ensure Node's TLS default also honors this even if env var is read earlier
		const tlsCfg = tls as unknown as {
			DEFAULT_REJECT_UNAUTHORIZED?: boolean;
		};
		tlsCfg.DEFAULT_REJECT_UNAUTHORIZED = false;
	} catch {
		// best-effort; ignore if not permitted in this runtime
	}

	const reqUrl = new URL(head.url, base);
	const hdrs: StrMap = {};
	for (const [k, v] of head.headers) hdrs[String(k)] = String(v);
	const headers = pickForwardHeaders(hdrs);

	// Prepare body pipe
	let bodyController: {
		enqueue: (c: Uint8Array) => void;
		close: () => void;
	} | null = null;
	let bodyStream: ReadableStream<Uint8Array> | undefined;
	if (head.hasBody) {
		bodyStream = new ReadableStream<Uint8Array>({
			start(controller) {
				bodyController = controller as unknown as {
					enqueue: (c: Uint8Array) => void;
					close: () => void;
				};
			},
		});
	}

	// Local fetch via global fetch (Node 18+)
	const aborter: globalThis.AbortController =
		new globalThis.AbortController();
	// Hard timeout to avoid hanging the Worker if local server is too slow/unavailable
	const TIMEOUT_MS = 10000; // 10s timeout for end-to-end local fetch
	const timeout = setTimeout(() => aborter.abort(), TIMEOUT_MS);
	const startedAt = Date.now();
	const resP: Promise<globalThis.Response> = globalThis
		.fetch(reqUrl, {
			method: head.method,
			headers,
			body: head.hasBody ? bodyStream : undefined,
			signal: aborter.signal,
			duplex: head.hasBody ? "half" : undefined,
		})
		.catch(async err => {
			// Classify timeout vs immediate connection failure
			const sig = (aborter as globalThis.AbortController).signal;
			const aborted = sig.aborted === true;
			try {
				send({
					type: "res-head",
					id: head.id,
					status: aborted ? 504 : 502,
					headers: [],
				});
				send({ type: "res-end", id: head.id });
			} finally {
				// ensure the controller is aborted to free resources
				aborter.abort();
			}
			throw err;
		});

	const onReqBody = (chunkB64: string) => {
		if (!bodyController) return;
		const u8 = Buffer.from(String(chunkB64), "base64");
		bodyController.enqueue(u8);
	};
	const onReqEnd = () => {
		bodyController?.close();
	};

	const done = (async () => {
		const res = await resP;
		const rh: [string, string][] = [];
		for (const [k, v] of res.headers) rh.push([k, v]);
		send({
			type: "res-head",
			id: head.id,
			status: res.status,
			headers: rh,
		});

		const reader = res.body?.getReader ? res.body.getReader() : null;
		if (!reader) {
			send({ type: "res-end", id: head.id });
		} else {
			while (true) {
				const { value, done: bodyDone } = await reader.read();
				if (bodyDone) break;
				const u8 =
					value instanceof Uint8Array
						? value
						: new TextEncoder().encode(String(value));
				const b64 = Buffer.from(u8).toString("base64");
				send({ type: "res-body", id: head.id, chunk: b64 });
			}
			send({ type: "res-end", id: head.id });
		}

		// Clean the timeout after response headers are produced
		try {
			globalThis.clearTimeout(timeout);
		} catch {
			// ignore cleanup errors
		}
		const dt = Date.now() - startedAt;
		let path = head.url;
		try {
			const u = new URL(head.url, "http://x");
			path = u.pathname + u.search;
		} catch {
			// ignore parse error, keep original path
			path = head.url;
		}
		return { ms: dt, status: res.status, method: head.method, path };
	})();

	return { onReqBody, onReqEnd, done };
}

type ConnectedEvt = { type: "connected"; url: string };
type RequestEvt = {
	type: "request";
	method: string;
	path: string;
	status: number;
	ms?: number;
};
type InfoEvt = { type: "info"; message: string };
type ErrorEvt = { type: "error"; message: string };
type LogEvt = ConnectedEvt | RequestEvt | InfoEvt | ErrorEvt;

function logEvent(json: boolean, evt: LogEvt): void {
	if (json) {
		process.stdout.write(JSON.stringify(evt) + "\n");
	} else {
		if (evt.type === "connected") {
			console.log(`Public URL: ${evt.url}`);
		} else if (evt.type === "request") {
			const ms = evt.ms != null ? `${evt.ms}ms` : "";
			console.log(
				`[${new Date().toISOString()}] ${evt.status} ${evt.method} ${evt.path} ${ms}`
			);
		} else if (evt.type === "info") {
			console.log(evt.message);
		} else if (evt.type === "error") {
			console.error(evt.message);
		}
	}
}

export let WebSocketCtor: typeof WebSocket = WebSocket;
export function setWebSocketCtor(ctor: typeof WebSocket) {
	WebSocketCtor = ctor;
}

async function run(opts: ParsedArgs): Promise<number> {
	// Validate required args
	if (!opts.http || !opts.api || !opts.worker) {
		printUsage();
		return 2;
	}
	const httpBase = ensureUrl(opts.http);
	const worker = ensureUrl(opts.worker);
	const slug = makeSlug(opts.slug);
	const publicUrl = buildPublicUrl(worker, slug);

	let attempts = 0;
	const maxAttempts = 3;
	let waitingTimer: ReturnType<typeof setTimeout> | null = null;
	const authHeader = `Bearer ${opts.api}`;

	while (attempts < maxAttempts) {
		attempts++;
		// Signal waiting if handshake takes long (queue on worker)
		waitingTimer = setTimeout(() => {
			logEvent(opts.json, {
				type: "info",
				message: "Waiting for a free slot on worker...",
			});
		}, 1000);

		// Build WS URL
		const wsProto = worker.protocol === "https:" ? "wss:" : "ws:";
		// Connect WS to the same host where public traffic will arrive to keep the same isolate
		const wsHost = `${slug}.${worker.host}`;
		const wsUrl = `${wsProto}//${wsHost}/connect?slug=${encodeURIComponent(
			slug
		)}`;

		const ws = new WebSocketCtor(wsUrl, {
			headers: { Authorization: authHeader },
		});

		const exitCode = await new Promise<number>(resolve => {
			let opened = false;
			const dispatchers = new Map<string, DispatchHandle>();

			const send = (msg: object) => {
				try {
					ws.send(JSON.stringify(msg));
				} catch {
					// ignore send errors (likely closed socket)
				}
			};

			ws.on("open", () => {
				opened = true;
				if (waitingTimer) globalThis.clearTimeout(waitingTimer);
				logEvent(opts.json, { type: "connected", url: publicUrl });
			});

			ws.on("message", async (data: RawData) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(data));
				} catch {
					// ignore invalid JSON frames
					return;
				}
				if (!parsed || typeof parsed !== "object") return;
				const msg = parsed as {
					type: string;
					id?: string;
					method?: string;
					url?: string;
					headers?: [string, string][];
					hasBody?: boolean;
					chunk?: string;
				};
				if (msg.type === "hello") return;
				if (msg.type === "req-head") {
					// Dispatch to local
					const head = {
						id: String(msg.id),
						method: String(msg.method || "GET"),
						url: String(msg.url || "/"),
						headers: Array.isArray(msg.headers) ? msg.headers : [],
						hasBody: !!msg.hasBody,
					};
					const d = dispatchToLocal(httpBase, head, send);
					dispatchers.set(head.id, d);
					d.done
						.then(({ ms, method, path, status }) => {
							logEvent(opts.json, {
								type: "request",
								method,
								path,
								status,
								ms,
							});
						})
						.catch(() => {
							// ignore per-request log errors
						});
				} else if (msg.type === "req-body") {
					const d = dispatchers.get(String(msg.id));
					if (d) d.onReqBody(String(msg.chunk || ""));
				} else if (msg.type === "req-end") {
					const d = dispatchers.get(String(msg.id));
					if (d) d.onReqEnd();
				}
			});

			// no secondary message handler

			ws.on(
				"unexpected-response",
				(_req: ClientRequest, res: IncomingMessage) => {
					if (waitingTimer) globalThis.clearTimeout(waitingTimer);
					if (res && res.statusCode === 401) {
						logEvent(opts.json, {
							type: "error",
							message: "Unauthorized (check --api token)",
						});
						resolve(1);
					} else {
						resolve(1);
					}
					ws.close();
				}
			);

			ws.on("close", () => {
				if (waitingTimer) globalThis.clearTimeout(waitingTimer);
				if (!opened) {
					resolve(1);
				} else {
					// Try reconnect
					resolve(9);
				}
			});
			ws.on("error", () => {
				if (waitingTimer) globalThis.clearTimeout(waitingTimer);
				resolve(1);
			});
		});

		if (exitCode === 0) return 0;
		if (exitCode === 1) return 1;
		// reconnect path
		const backoffMs = 500 * 2 ** (attempts - 1);
		await sleep(backoffMs);
		continue;
	}
	logEvent(opts.json, {
		type: "error",
		message: "Failed to maintain connection after retries",
	});
	return 1;
}

export function main(input: CliOptions): number {
	// Synchronous wrapper around async run
	const opts = parseArgs(input.argv);
	let code = 0;
	run(opts)
		.then(c => {
			code = c;
		})
		.catch(err => {
			console.error(err?.message || String(err));
			code = 1;
		})
		.finally(() => {
			process.exit(code);
		});
	// Keep Node alive until process.exit in finally
	return 0;
}

if (import.meta.main) {
	main({ argv: process.argv.slice(2) });
}

export { run as runCli };
