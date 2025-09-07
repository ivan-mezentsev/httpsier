function renderHTML(csrfToken) {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="google" content="notranslate" />
    <title>Sign in</title>
    <style>
      :root {
        --bg: #0b0f17;
        --surface: #111626;
        --surface-2: #0e1422;
        --border: #1d2333;
        --text: #e7eaf0;
        --muted: #9aa3b2;
        --accent: #39d98a; /* calm green */
        --accent-600: #25c179;
        --ring: rgba(57, 217, 138, 0.35);
        --shadow: 0 12px 40px rgba(0,0,0,.45);
        --radius: 14px;
        color-scheme: dark;
      }

      *, *::before, *::after { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu,
          Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        line-height: 1.5;
        background: radial-gradient(900px 600px at 85% -10%, rgba(57,217,138,0.06), transparent),
                    radial-gradient(700px 500px at -10% 110%, rgba(57,217,138,0.05), transparent),
                    var(--bg);
        color: var(--text);
      }

      .wrap {
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: clamp(16px, 3vw, 48px);
      }

      .card {
        width: min(420px, 100%);
        background: linear-gradient(180deg, var(--surface), var(--surface-2));
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: clamp(18px, 4vw, 28px);
      }

      .title {
        margin: 0 0 6px;
        font-size: clamp(18px, 2.2vw, 20px);
        font-weight: 700;
        letter-spacing: 0.2px;
      }

      .form { display: grid; gap: 14px; margin-top: 6px; }
      .field { display: grid; gap: 6px; }
      .label { font-weight: 600; font-size: 13px; color: var(--muted); }
      .input {
        appearance: none;
        width: 100%;
        border: 1px solid var(--border);
        background: #0f1524;
        color: var(--text);
        border-radius: 12px;
        padding: 12px 14px;
        font-size: 14px;
        transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
      }
      .input::placeholder { color: #7b8597; }
      .input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--ring); }

      .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .checkbox { display: inline-flex; align-items: center; gap: 10px; user-select: none; }
      .checkbox input { accent-color: var(--accent); width: 18px; height: 18px; }
      .checkbox label { font-size: 13px; color: var(--muted); cursor: pointer; }
      .muted-link { font-size: 12px; color: var(--muted); text-decoration: none; }
      .muted-link:hover { color: #b7bfcc; }

      .actions { margin-top: 4px; }
      .btn {
        appearance: none;
        display: inline-flex; align-items: center; justify-content: center;
        gap: 8px; width: 100%; border: 0;
        padding: 12px 16px;
        border-radius: 12px;
        background: linear-gradient(180deg, var(--accent), var(--accent-600));
        color: #0b0f17; /* slightly darker text for better on-green readability */
        font-weight: 800;
        letter-spacing: .2px;
        cursor: pointer;
        transition: transform .06s ease, filter .15s ease;
      }
      .btn:hover { filter: brightness(1.06); }
      .btn:active { transform: translateY(1px); }
      .btn:focus { outline: none; box-shadow: 0 0 0 3px var(--ring); }

      @media (max-width: 420px) {
        .checkbox label { font-size: 12px; }
      }
    </style>
  </head>
  <body>
  </body>
</html>`;
}

// Settings helpers
function getNumber(val, fallback) {
	const n = Number(val);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getSettings(env) {
	// Env names per spec
	const delaySeconds = getNumber(env?.DELAY_SECONDS, 2);
	const concurrentSessionsMax = getNumber(env?.CONCURRENT_SESSIONS_MAX, 1);
	const customDomain = env?.CUSTOM_DOMAIN || undefined;
	const apiToken = env?.API_TOKEN || undefined;
	return { delaySeconds, concurrentSessionsMax, customDomain, apiToken };
}

// Per-isolate polling-based semaphore: extra requests WAIT until a slot frees.
// This is not global across POPs/isolates. It only limits within one isolate.
let ACTIVE_CONCURRENCY = 0;

async function acquireSlotByPolling(request, limit) {
	const signal = request && request.signal;
	// Fast path
	if (ACTIVE_CONCURRENCY < limit) {
		ACTIVE_CONCURRENCY++;
		return;
	}
	// Wait until a slot is available
	while (true) {
		if (signal && signal.aborted) {
			// Client went away; stop waiting
			throw new Error("client-aborted");
		}
		if (ACTIVE_CONCURRENCY < limit) {
			ACTIVE_CONCURRENCY++;
			return;
		}
		// Short sleep to yield; low CPU impact
		await sleep(50);
	}
}

async function withConcurrencyLimit(request, env) {
	const { concurrentSessionsMax } = getSettings(env);
	try {
		await acquireSlotByPolling(request, concurrentSessionsMax);
	} catch (e) {
		// If client aborted while waiting, return early
		return new Response(null, { status: 499 });
	}
	try {
		return await handle(request, env);
	} finally {
		ACTIVE_CONCURRENCY = Math.max(0, ACTIVE_CONCURRENCY - 1);
	}
}

export default {
	async fetch(request, env, _ctx) {
		return withConcurrencyLimit(request, env);
	},
	// Cloudflare Durable Object class registration (runtime discovers this class)
	// The class is exported as a named export below.
};

// Helper: server-side sleep to simulate processing delay
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Throttle window based on env-configured delaySeconds
function getBanWindowSeconds(env) {
	return getSettings(env).delaySeconds;
}

// Helpers for IP-based blocking via Cache API
function getClientIP(request) {
	// Prefer CF-Connecting-IP; fallback to first X-Forwarded-For hop
	return (
		request.headers.get("CF-Connecting-IP") ||
		(request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
		"unknown"
	);
}

function makeBanKey(request, ip) {
	const host = new URL(request.url).hostname;
	// Synthetic GET key scoped to zone hostname
	return new Request(`https://${host}/__ban/${encodeURIComponent(ip)}`, {
		method: "GET",
	});
}

async function getBanRemainingSeconds(request) {
	const ip = getClientIP(request);
	const key = makeBanKey(request, ip);
	const hit = await caches.default.match(key);
	if (!hit) return 0;
	const exp = hit.headers.get("Expires");
	if (!exp) return 0;
	const ms = new Date(exp).getTime() - Date.now();
	if (!Number.isFinite(ms)) return 0;
	return Math.max(0, Math.ceil(ms / 1000));
}

async function setBan(request, seconds) {
	const ip = getClientIP(request);
	const key = makeBanKey(request, ip);
	const expires = new Date(Date.now() + seconds * 1000).toUTCString();
	const resp = new Response("blocked", {
		headers: {
			// Cache TTL defines ban duration
			"Cache-Control": `max-age=${seconds}`,
			Expires: expires,
		},
	});
	await caches.default.put(key, resp);
}

// CSRF helpers
function randomToken(bytes = 32) {
	const arr = new Uint8Array(bytes);
	// crypto.getRandomValues is available in Workers runtime
	crypto.getRandomValues(arr);
	return [...arr].map(b => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header) {
	const out = {};
	if (!header) return out;
	header.split(";").forEach(part => {
		const [k, ...rest] = part.split("=");
		if (!k) return;
		const key = k.trim();
		const val = rest.join("=").trim();
		if (key && val) out[key] = decodeURIComponent(val);
	});
	return out;
}

async function handle(request, env) {
	const url = new URL(request.url);
	const delayWindow = getBanWindowSeconds(env);

	// In-memory connections registry (per isolate) keyed by slug
	// Each entry: { ws, pending: Map<id, {resolveHead, controller, headers:[], status:number}> }
	if (!globalThis.__HTTPSIER_SESSIONS__) {
		// Using a plain object attached to globalThis keeps it per-isolate
		globalThis.__HTTPSIER_SESSIONS__ = new Map();
	}
	const SESSIONS = /** @type {Map<string, any>} */ (
		globalThis.__HTTPSIER_SESSIONS__
	);

	// Base64 helpers that work in both Workers (btoa/atob) and Node (Buffer)
	function b64encode(u8) {
		if (typeof btoa === "function") {
			let binary = "";
			for (let i = 0; i < u8.length; i++)
				binary += String.fromCharCode(u8[i]);
			return btoa(binary);
		}
		// Node fallback
		return Buffer.from(u8).toString("base64");
	}

	function b64decode(b64) {
		if (typeof atob === "function") {
			const bin = atob(b64);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
			return out;
		}
		// Node fallback
		return new Uint8Array(Buffer.from(b64, "base64"));
	}

	// Helper: generate simple id
	const genId = () =>
		crypto.getRandomValues(new Uint32Array(1))[0].toString(16) +
		Date.now().toString(16);

	// Helper: read request body as Uint8Array stream and emit frames via ws
	async function forwardRequestBody(ws, id, req) {
		const reader = req.body?.getReader ? req.body.getReader() : null;
		if (!reader) {
			ws.send(JSON.stringify({ type: "req-end", id }));
			return;
		}
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			const u8 =
				value instanceof Uint8Array
					? value
					: new TextEncoder().encode(String(value));
			const chunk = b64encode(u8);
			ws.send(JSON.stringify({ type: "req-body", id, chunk }));
		}
		ws.send(JSON.stringify({ type: "req-end", id }));
	}

	// Auth-only endpoint for establishing a service connection
	if (url.pathname === "/connect") {
		// Validate Bearer token from Authorization header
		const auth = request.headers.get("authorization") || "";
		const expected = getSettings(env).apiToken;
		const provided = auth.toLowerCase().startsWith("bearer ")
			? auth.slice(7).trim()
			: null;

		if (expected && !(provided && provided === expected)) {
			// Apply throttling window before responding 401
			let remaining = await getBanRemainingSeconds(request);
			if (remaining === 0) {
				await setBan(request, delayWindow);
				await sleep(delayWindow * 1000);
			} else {
				await setBan(request, remaining + delayWindow);
				await sleep((remaining + delayWindow) * 1000);
			}
			return new Response("Unauthorized", { status: 401 });
		}
		// Successful auth (or not required): forward to Durable Object by slug for sticky WS
		const slug = url.searchParams.get("slug") || "default";
		try {
			const id = env.SESSION_REGISTRY.idFromName(slug);
			const stub = env.SESSION_REGISTRY.get(id);
			return await stub.fetch(request);
		} catch {
			// Apply throttling window before responding 502 to avoid tight error loops
			let remaining = await getBanRemainingSeconds(request);
			if (remaining === 0) {
				await setBan(request, delayWindow);
				await sleep(delayWindow * 1000);
			} else {
				await setBan(request, remaining + delayWindow);
				await sleep((remaining + delayWindow) * 1000);
			}
			return new Response("Failed to connect", { status: 502 });
		}
	}

	// Helper to apply X-Forwarded-* headers for proxied requests
	function buildForwardedHeaders(req, env) {
		const headers = new Headers(req.headers);
		const proto = new URL(req.url).protocol === "https:" ? "https" : "http";
		const host = req.headers.get("host") || new URL(req.url).host;
		const clientIP = getClientIP(req);
		const priorXff = headers.get("x-forwarded-for");
		headers.set("x-forwarded-proto", proto);
		headers.set("x-forwarded-host", host);
		headers.set(
			"x-forwarded-for",
			priorXff ? `${priorXff}, ${clientIP}` : clientIP
		);
		// Remove service Authorization used for /connect from user traffic; keep user Authorization untouched
		const expected = getSettings(env).apiToken;
		if (expected) {
			const auth = headers.get("authorization");
			if (auth) {
				const m = /^\s*bearer\s+(.+)$/i.exec(auth);
				if (m && m[1].trim() === String(expected)) {
					headers.delete("authorization");
				}
			}
		}
		return headers;
	}

	// Public routing via custom domain host: <slug>.<CUSTOM_DOMAIN> -> proxy via DO
	const { customDomain } = getSettings(env);
	if (customDomain) {
		const host = url.hostname.toLowerCase();
		const domain = customDomain.toLowerCase();
		if (host.endsWith(`.${domain}`)) {
			const left = host.slice(0, host.length - (domain.length + 1));
			if (left && !left.includes(".")) {
				const slug = left;
				const pathRemainder = url.pathname + url.search;
				try {
					const id = env.SESSION_REGISTRY.idFromName(slug);
					const stub = env.SESSION_REGISTRY.get(id);
					const fwdHeaders = buildForwardedHeaders(request, env);
					const doUrl = new URL("https://do/proxy");
					doUrl.searchParams.set("path", pathRemainder);
					return await stub.fetch(
						new Request(doUrl, {
							method: request.method,
							headers: fwdHeaders,
							body:
								request.body &&
								request.method !== "GET" &&
								request.method !== "HEAD"
									? request.body
									: null,
						})
					);
				} catch {
					// Apply throttling window before responding 404
					let remaining = await getBanRemainingSeconds(request);
					if (remaining === 0) {
						await setBan(request, delayWindow);
						await sleep(delayWindow * 1000);
					} else {
						await setBan(request, remaining + delayWindow);
						await sleep((remaining + delayWindow) * 1000);
					}
					return new Response("No session", { status: 404 });
				}
			}
		}
	}

	// Rotate CSRF token on every page view; use double-submit cookie pattern
	if (request.method === "GET" && url.pathname === "/") {
		// If there's an active ban for this IP, wait it out before serving the form
		const remaining = await getBanRemainingSeconds(request);
		if (remaining > 0) {
			await sleep(remaining * 1000);
		}
		const csrf = randomToken(32);
		const html = renderHTML(csrf);
		const headers = new Headers({
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache",
			"Referrer-Policy": "same-origin",
		});
		// HttpOnly cookie prevents JS access; SameSite=Strict blocks cross-site sends
		headers.append(
			"Set-Cookie",
			`csrf=${encodeURIComponent(csrf)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`
		);
		return new Response(html, { headers });
	}

	if (request.method === "POST" && url.pathname === "/") {
		// Read and (if possible) parse form, but do not alter observable behavior based on CSRF validity
		const contentType = request.headers.get("content-type") || "";
		let formToken = null;
		if (contentType.includes("application/x-www-form-urlencoded")) {
			try {
				// Prefer native form parsing to avoid Wrangler warning
				const form = await request.formData();
				formToken = form.get("csrf");
			} catch {}
		}

		// Compare with cookie (for internal realism only)
		const cookies = parseCookies(request.headers.get("Cookie"));
		const cookieToken = cookies["csrf"];
		const valid = !!formToken && !!cookieToken && formToken === cookieToken;
		// Always rotate token to a fresh one to avoid replay hints
		const nextCsrf = randomToken(32);

		// Throttling logic: serialize attempts per IP via Cache API
		// If there is no current ban, reserve this 10/15s slot and wait it out.
		// If a ban exists, extend it by another window and wait (remaining + window) to queue behind.
		let remaining = await getBanRemainingSeconds(request);
		if (remaining === 0) {
			await setBan(request, delayWindow);
			await sleep(delayWindow * 1000);
		} else {
			await setBan(request, remaining + delayWindow);
			await sleep((remaining + delayWindow) * 1000);
		}

		const headers = new Headers({
			"Set-Cookie": `csrf=${encodeURIComponent(nextCsrf)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`,
			Location: url.origin + "/",
		});
		return new Response(null, { status: 303, headers });
	}

	return new Response("Not found", { status: 404 });
}

// Durable Object: SessionRegistry
// Stores mappings of subdomain|slug -> session metadata
export class SessionRegistry {
	/** @param {import("cloudflare:workers").DurableObjectState} state */
	constructor(state, env) {
		this.state = state; // internal storage access
		this.env = env;
		// Use map-like storage via this.state.storage
	}

	// Utility to make a consistent map key
	makeKey(kind, key) {
		return `${kind}:${key}`.toLowerCase();
	}

	// Register a session mapping to an id (opaque or generated)
	async register(kind, key, value) {
		const id = this.makeKey(kind, key);
		await this.state.storage.put(id, { value, ts: Date.now() });
		return { ok: true };
	}

	// Resolve returns stored value or null
	async resolve(kind, key) {
		const id = this.makeKey(kind, key);
		const rec = await this.state.storage.get(id);
		return rec ? rec.value : null;
	}

	// Cleanup removes a mapping
	async cleanup(kind, key) {
		const id = this.makeKey(kind, key);
		await this.state.storage.delete(id);
		return { ok: true };
	}

	// Expose minimal HTTP API for tests and worker integration
	async fetch(request) {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const seg = url.pathname.split("/").filter(Boolean);
		// Handle httpsier tunnel
		if (seg[0] === "connect" && method === "GET") {
			// Accept WS upgrade and store ws + pending map in this DO instance
			if (typeof WebSocketPair !== "function") {
				// Respect configured delay window before returning 400
				const delayWindow = getBanWindowSeconds(this.env);
				await sleep(delayWindow * 1000);
				return new Response("WebSocket required", { status: 400 });
			}
			const pair = new WebSocketPair();
			const server = pair[1];
			server.accept();
			// Save on this state
			this.ws = server;
			this.pending = new Map();
			try {
				server.send(
					JSON.stringify({ type: "hello", proto: "httpsier/1" })
				);
			} catch {}
			server.addEventListener?.("message", evt => {
				let msg;
				try {
					msg =
						typeof evt.data === "string"
							? JSON.parse(evt.data)
							: JSON.parse(String(evt.data));
				} catch {
					return;
				}
				if (!msg || !msg.type || !msg.id) return;
				const p = this.pending?.get(msg.id);
				if (!p) return;
				if (msg.type === "res-head") {
					p.status = Number(msg.status) || 200;
					const headers = new Headers();
					if (Array.isArray(msg.headers)) {
						for (const [k, v] of msg.headers)
							headers.append(String(k), String(v));
					}
					p.headers = headers;
					p.resolveHead({ status: p.status, headers });
					return;
				}
				if (msg.type === "res-body") {
					try {
						const bin =
							typeof atob === "function"
								? new Uint8Array(
										atob(String(msg.chunk) || "")
											.split("")
											.map(c => c.charCodeAt(0))
									)
								: new Uint8Array(
										Buffer.from(
											String(msg.chunk || ""),
											"base64"
										)
									);
						p.controller.enqueue(bin);
					} catch {}
					return;
				}
				if (msg.type === "res-end") {
					p.controller.close();
					this.pending?.delete(msg.id);
					return;
				}
			});
			server.addEventListener?.("close", () => {
				this.ws = null;
				this.pending = null;
			});
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		if (seg[0] === "proxy") {
			if (!this.ws) {
				// Apply throttling window before responding 404 when no active session
				const delayWindow = getBanWindowSeconds(this.env);
				let remaining = await getBanRemainingSeconds(request);
				if (remaining === 0) {
					await setBan(request, delayWindow);
					await sleep(delayWindow * 1000);
				} else {
					await setBan(request, remaining + delayWindow);
					await sleep((remaining + delayWindow) * 1000);
				}
				return new Response("No session", { status: 404 });
			}
			let resolveHead;
			const headP = new Promise(r => (resolveHead = r));
			const stream = new ReadableStream({
				start: controller => {
					const id =
						Math.random().toString(16).slice(2) +
						Date.now().toString(16);
					this.pending.set(id, { controller, resolveHead });
					const path = url.searchParams.get("path") || "/";
					const headersArr = [];
					for (const [k, v] of request.headers)
						headersArr.push([k, v]);
					const hasBody =
						request.body != null &&
						request.method !== "GET" &&
						request.method !== "HEAD";
					try {
						this.ws.send(
							JSON.stringify({
								type: "req-head",
								id,
								method: request.method,
								url: path,
								headers: headersArr,
								hasBody,
							})
						);
					} catch {}
					if (hasBody) {
						(async () => {
							try {
								const reader = request.body.getReader();
								while (true) {
									const { value, done } = await reader.read();
									if (done) break;
									const bin =
										value instanceof Uint8Array
											? value
											: new TextEncoder().encode(
													String(value)
												);
									const chunk =
										typeof btoa === "function"
											? btoa(String.fromCharCode(...bin))
											: Buffer.from(bin).toString(
													"base64"
												);
									this.ws.send(
										JSON.stringify({
											type: "req-body",
											id,
											chunk,
										})
									);
								}
							} catch {}
							try {
								this.ws.send(
									JSON.stringify({ type: "req-end", id })
								);
							} catch {}
						})();
					} else {
						try {
							this.ws.send(
								JSON.stringify({ type: "req-end", id })
							);
						} catch {}
					}
				},
			});
			const head = await headP;
			const code = Number(head.status) || 200;
			const noBody =
				(code >= 100 && code < 200) ||
				code === 204 ||
				code === 205 ||
				code === 304;
			return new Response(noBody ? null : stream, {
				status: code,
				headers: head.headers,
			});
		}
		// Routes:
		// POST /register/:kind/:key   body: { value }
		// GET  /resolve/:kind/:key
		// DELETE /cleanup/:kind/:key
		if (seg[0] === "register" && seg.length >= 3 && method === "POST") {
			const kind = seg[1];
			const key = decodeURIComponent(seg[2]);
			const body = await request.json().catch(() => ({}));
			await this.register(kind, key, body.value ?? true);
			return new Response(null, { status: 204 });
		}
		if (seg[0] === "resolve" && seg.length >= 3 && method === "GET") {
			const kind = seg[1];
			const key = decodeURIComponent(seg[2]);
			const value = await this.resolve(kind, key);
			return new Response(JSON.stringify({ value }), {
				headers: { "Content-Type": "application/json" },
			});
		}
		if (
			seg[0] === "cleanup" &&
			seg.length >= 3 &&
			(method === "DELETE" || method === "POST")
		) {
			const kind = seg[1];
			const key = decodeURIComponent(seg[2]);
			await this.cleanup(kind, key);
			return new Response(null, { status: 204 });
		}
		// Respect configured delay window before default 404 to avoid tight loops
		const delayWindow = getBanWindowSeconds(this.env);
		await sleep(delayWindow * 1000);
		return new Response("SessionRegistry: not found", { status: 404 });
	}
}
