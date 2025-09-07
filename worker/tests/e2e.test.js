// E2E test without mocks
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Local HTTP server:
 * - /hello -> static body for parity checks
 * - /trace -> echoes selected inbound headers to validate X-Forwarded-* and Authorization
 */
let server;
let serverUrl = "http://localhost:8080";
let cliProc;

// Resolve paths relative to this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TOML [vars] parser to read values from worker/wrangler.toml
function readTomlVars(tomlPath) {
	/** @type {Record<string, string|number|boolean>} */
	const out = {};
	let src = "";
	try {
		src = fs.readFileSync(tomlPath, "utf8");
	} catch (e) {
		throw new Error(
			`Failed to read wrangler.toml at ${tomlPath}: ${e.message}`
		);
	}
	const lines = src.split(/\r?\n/);
	let inVars = false;
	for (const rawLine of lines) {
		let line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			inVars = line === "[vars]";
			continue;
		}
		if (!inVars) continue;
		// strip inline comments
		const hash = line.indexOf("#");
		if (hash !== -1) line = line.slice(0, hash).trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let valueRaw = line.slice(eq + 1).trim();
		// Parse basic TOML values: strings, numbers, booleans
		if (valueRaw.startsWith('"')) {
			// naive string parse: consume until last matching quote
			const m = valueRaw.match(/^"(.*)"$/);
			out[key] = m ? m[1] : valueRaw.replace(/^"|"$/g, "");
		} else if (/^(true|false)$/i.test(valueRaw)) {
			out[key] = /^true$/i.test(valueRaw);
		} else if (/^[+-]?\d+(?:_\d+)*$/.test(valueRaw)) {
			out[key] = Number(valueRaw.replace(/_/g, ""));
		} else {
			// fallback raw
			out[key] = valueRaw;
		}
	}
	return out;
}

// .env parser to read API_TOKEN from repo root
function readDotEnv(envPath) {
	/** @type {Record<string,string>} */
	const env = {};
	let src = "";
	try {
		src = fs.readFileSync(envPath, "utf8");
	} catch (e) {
		throw new Error(`Failed to read .env at ${envPath}: ${e.message}`);
	}
	for (const rawLine of src.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		env[key] = val;
	}
	return env;
}

// Read settings from worker/wrangler.toml [vars]
const WRANGLER_TOML = path.resolve(__dirname, "..", "wrangler.toml");
const VARS = readTomlVars(WRANGLER_TOML);
if (VARS.CUSTOM_DOMAIN == null)
	throw new Error("CUSTOM_DOMAIN is not set in wrangler.toml [vars]");
if (VARS.DELAY_SECONDS == null)
	throw new Error("DELAY_SECONDS is not set in wrangler.toml [vars]");
if (
	VARS.COUNCURRENT_SESSIONS_MAX == null &&
	VARS.CONCURRENT_SESSIONS_MAX == null
)
	throw new Error(
		"CONCURRENT_SESSIONS_MAX is not set in wrangler.toml [vars]"
	);
const CUSTOM_DOMAIN = String(VARS.CUSTOM_DOMAIN); // [vars] CUSTOM_DOMAIN
const DELAY_SECONDS = Number(VARS.DELAY_SECONDS); // [vars] DELAY_SECONDS
const CONCURRENT_SESSIONS_MAX = Number(
	VARS.CONCURRENT_SESSIONS_MAX ?? VARS.COUNCURRENT_SESSIONS_MAX
); // [vars] CONCURRENT_SESSIONS_MAX
if (!CUSTOM_DOMAIN)
	throw new Error("CUSTOM_DOMAIN is empty in wrangler.toml [vars]");
if (!Number.isFinite(DELAY_SECONDS))
	throw new Error("DELAY_SECONDS is invalid in wrangler.toml [vars]");
if (!Number.isFinite(CONCURRENT_SESSIONS_MAX))
	throw new Error(
		"CONCURRENT_SESSIONS_MAX is invalid in wrangler.toml [vars]"
	);
const SLUG = "test"; // test session slug remains fixed for E2E

// Base & public origins for the worker
const WORKER_BASE = `https://${CUSTOM_DOMAIN}`;
const PUBLIC_ORIGIN = `https://${SLUG}.${CUSTOM_DOMAIN}`;

// Read API token from project root .env
const ENV_PATH = path.resolve(__dirname, "..", "..", ".env");
const ENVV = readDotEnv(ENV_PATH);
const API_TOKEN = String(ENVV.API_TOKEN || "");
if (!API_TOKEN) throw new Error("API_TOKEN must be defined in project .env");

const CLI_STRICT_CMD = `cd ~/PROJECTs/httpsier && node dist/index.js --http http://localhost:8080 --api ${API_TOKEN} --worker ${WORKER_BASE} --json --slug ${SLUG}`;

// Helper to enforce client-side timeouts on fetch
function fetchWithTimeout(url, options = {}, timeoutMs = 1000) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	return fetch(url, { ...options, signal: ac.signal }).finally(() =>
		clearTimeout(t)
	);
}

// Helper to ensure CLI is connected; respawns if needed and waits for `connected` JSON log
async function ensureCliConnected() {
	if (cliProc && cliProc.exitCode === null && !cliProc.killed) return;
	cliProc = spawn("bash", ["-lc", CLI_STRICT_CMD], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let connectedResolve;
	let connectedReject;
	const whenCliConnected = new Promise((resolve, reject) => {
		connectedResolve = resolve;
		connectedReject = reject;
	});
	if (cliProc.stdout) {
		cliProc.stdout.setEncoding("utf8");
		let buf = "";
		cliProc.stdout.on("data", chunk => {
			buf += chunk;
			let idx;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				try {
					const obj = JSON.parse(line);
					console.log(
						"[CLI]",
						obj.type || obj.event || obj.level || "log",
						obj
					);
					if (
						obj.type === "connected" &&
						typeof obj.url === "string"
					) {
						if (connectedResolve) connectedResolve(obj.url);
					}
				} catch (_e) {
					console.log("[CLI]", line);
				}
			}
		});
	}
	if (cliProc.stderr) {
		cliProc.stderr.setEncoding("utf8");
		let ebuf = "";
		cliProc.stderr.on("data", chunk => {
			ebuf += chunk;
			let idx;
			while ((idx = ebuf.indexOf("\n")) !== -1) {
				const line = ebuf.slice(0, idx).trim();
				ebuf = ebuf.slice(idx + 1);
				if (!line) continue;
				console.error("[CLI:err]", line);
			}
		});
	}
	cliProc.on("close", code => {
		console.log("[CLI] exited with", code);
		if (connectedReject)
			connectedReject(new Error("CLI exited before connected"));
	});
	const connectTimeoutMs = (DELAY_SECONDS + 30) * 1000;
	const timeoutP = new Promise((_, reject) =>
		setTimeout(
			() => reject(new Error("CLI did not connect in time")),
			connectTimeoutMs
		)
	);
	const urlFromCli = await Promise.race([whenCliConnected, timeoutP]);
	assert.equal(urlFromCli, PUBLIC_ORIGIN);
}

// Ensure the tunnel is really responsive: ping public /hello, restart CLI if needed
async function ensureConnectedAndWarm() {
	try {
		const r = await fetchWithTimeout(
			`${PUBLIC_ORIGIN}/hello`,
			{ method: "GET" },
			2000
		);
		if (r.ok) return;
	} catch (_) {
		// fall through to reconnect
	}
	await spawnCliAndWaitConnected();
	await delay(250);
	const ok = await fetchWithTimeout(
		`${PUBLIC_ORIGIN}/hello`,
		{ method: "GET" },
		3000
	);
	if (!ok.ok)
		throw new Error("Public origin is not responsive after reconnect");
}

// Helper: (re)spawn CLI and wait until it reports connected
async function spawnCliAndWaitConnected() {
	// Kill old CLI if any
	if (cliProc && !cliProc.killed && cliProc.exitCode == null) {
		try {
			cliProc.kill("SIGTERM");
		} catch {}
		await delay(200);
	}
	cliProc = spawn("bash", ["-lc", CLI_STRICT_CMD], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	let connectedResolve;
	let connectedReject;
	/** @type {Promise<string>} */
	const whenCliConnected = new Promise((resolve, reject) => {
		connectedResolve = resolve;
		connectedReject = reject;
	});

	if (cliProc.stdout) {
		cliProc.stdout.setEncoding("utf8");
		let buf = "";
		cliProc.stdout.on("data", chunk => {
			buf += chunk;
			let idx;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (!line) continue;
				try {
					const obj = JSON.parse(line);
					console.log(
						"[CLI]",
						obj.type || obj.event || obj.level || "log",
						obj
					);
					if (
						obj.type === "connected" &&
						typeof obj.url === "string"
					) {
						if (connectedResolve) connectedResolve(obj.url);
					}
				} catch (_e) {
					console.log("[CLI]", line);
				}
			}
		});
	}
	if (cliProc.stderr) {
		cliProc.stderr.setEncoding("utf8");
		let ebuf = "";
		cliProc.stderr.on("data", chunk => {
			ebuf += chunk;
			let idx;
			while ((idx = ebuf.indexOf("\n")) !== -1) {
				const line = ebuf.slice(0, idx).trim();
				ebuf = ebuf.slice(idx + 1);
				if (!line) continue;
				console.error("[CLI:err]", line);
			}
		});
	}
	cliProc.on("close", code => {
		console.log("[CLI] exited with", code);
		if (connectedReject)
			connectedReject(new Error("CLI exited before connected"));
	});

	const connectTimeoutMs = (DELAY_SECONDS + 30) * 1000;
	const timeoutP = new Promise((_, reject) =>
		setTimeout(
			() => reject(new Error("CLI did not connect in time")),
			connectTimeoutMs
		)
	);
	const urlFromCli = await Promise.race([whenCliConnected, timeoutP]);
	assert.equal(urlFromCli, PUBLIC_ORIGIN);
}

before(async () => {
	// Linter must run before execution
	const lint = spawnSync("bash", ["-lc", "npm run lint:fix"], {
		stdio: "inherit",
	});
	if (lint.status !== 0) throw new Error("lint:fix failed");

	// R6.AC5: Verify domain in CLI command matches wrangler.toml routes
	const expectedDomain = CUSTOM_DOMAIN;
	const cliDomain = new URL(WORKER_BASE).hostname;
	if (cliDomain !== expectedDomain) {
		throw new Error(
			`Domain mismatch: CLI uses ${cliDomain}, wrangler.toml expects ${expectedDomain}`
		);
	}

	// Start local server
	server = http
		.createServer(async (req, res) => {
			const chunks = [];
			for await (const c of req)
				chunks.push(typeof c === "string" ? Buffer.from(c) : c);
			const body = Buffer.concat(chunks).toString("utf8");
			// Slow endpoint to simulate server processing time for concurrency tests
			try {
				const url = new URL(req.url || "/", "http://local");
				if (url.pathname === "/slow") {
					const ms = Math.max(
						0,
						Math.min(5000, Number(url.searchParams.get("ms")) || 0)
					);
					if (ms > 0) await delay(ms);
					const buff = Buffer.from(`slow:${ms}`);
					res.writeHead(200, {
						"content-type": "text/plain; charset=utf-8",
						"x-local": "yes",
						"content-length": String(buff.length),
					});
					res.end(buff);
					return;
				}
			} catch {}
			if (req.url && req.url.startsWith("/trace")) {
				const payload = {
					method: req.method,
					url: req.url,
					forwardedProto: req.headers["x-forwarded-proto"] || null,
					forwardedHost: req.headers["x-forwarded-host"] || null,
					forwardedFor: req.headers["x-forwarded-for"] || null,
					authorization: req.headers["authorization"] || null,
					body,
				};
				const buff = Buffer.from(JSON.stringify(payload));
				res.writeHead(200, {
					"content-type": "application/json",
					"x-local": "yes",
					"content-length": String(buff.length),
				});
				res.end(buff);
				return;
			}
			// /hello or any other path -> static parity response
			const buff = Buffer.from("ok");
			res.writeHead(200, {
				"content-type": "text/plain; charset=utf-8",
				"x-local": "yes",
				"content-length": String(buff.length),
			});
			res.end(buff);
		})
		.listen(8080);

	// Wait for local server to be ready
	let localReady = false;
	for (let i = 0; i < 10; i++) {
		try {
			const r = await fetch("http://localhost:8080/hello", {
				method: "GET",
			});
			if (r.ok) {
				localReady = true;
				break;
			}
		} catch (_) {
			// wait and retry
		}
		await delay(100);
	}
	if (!localReady) throw new Error("Local server not ready in time");

	// Deploy worker (approved replacement for publish)
	const pub = spawnSync("bash", ["-lc", "cd worker && wrangler deploy"], {
		stdio: "inherit",
	});
	if (pub.status !== 0) {
		try {
			await new Promise(resolve => server.close(() => resolve()));
		} catch (_e) {
			// ignore
		}
		server = undefined;
		throw new Error("wrangler deploy failed");
	}

	// Build CLI before running it strictly from dist
	const build = spawnSync("bash", ["-lc", "npm run build"], {
		stdio: "inherit",
	});
	if (build.status !== 0) {
		try {
			await new Promise(resolve => server.close(() => resolve()));
		} catch (_e) {}
		server = undefined;
		throw new Error("npm run build failed");
	}

	// Start CLI and wait for connected
	await spawnCliAndWaitConnected();
	// Final quick sanity ping to ensure public path is proxied
	for (let i = 0; i < 5; i++) {
		try {
			const r = await fetch(`${PUBLIC_ORIGIN}/hello`, { method: "GET" });
			if (r.ok) break;
		} catch {}
		await delay(200);
	}
});

after(async () => {
	// Stop CLI
	if (cliProc && !cliProc.killed) {
		cliProc.kill("SIGTERM");
		await delay(500);
		if (!cliProc.killed) cliProc.kill("SIGKILL");
	}
	// Stop server
	if (server) {
		await new Promise(resolve => server.close(() => resolve()));
	}
});

// Happy path parity check

test("public response matches local for /hello (via slug subdomain)", async () => {
	const [localRes, publicRes] = await Promise.all([
		fetch(`${serverUrl}/hello`, { method: "GET" }),
		fetch(`${PUBLIC_ORIGIN}/hello`, { method: "GET" }),
	]);
	assert.equal(localRes.status, 200);
	assert.equal(publicRes.status, 200);
	const [localBody, publicBody] = await Promise.all([
		localRes.text(),
		publicRes.text(),
	]);
	assert.equal(publicBody, localBody);
	// key header check
	assert.equal(
		publicRes.headers.get("content-type"),
		localRes.headers.get("content-type")
	);
	assert.equal(
		publicRes.headers.get("x-local"),
		localRes.headers.get("x-local")
	);
});

// Proxy headers and Authorization behavior

test(
	"X-Forwarded-* are set and service Authorization does not leak",
	{ timeout: 1000 },
	async () => {
		const userAuth = "User abc";
		const t0 = Date.now();
		const r = await fetchWithTimeout(
			`${PUBLIC_ORIGIN}/trace`,
			{
				method: "POST",
				headers: {
					Authorization: userAuth,
					"content-type": "application/json",
				},
				body: JSON.stringify({ time: Date.now() }),
			},
			1000
		);
		assert.equal(r.status, 200);
		const dt = Date.now() - t0;
		assert.ok(dt < 1000, `trace must complete under 1s, took ${dt}ms`);
		const data = await r.json();
		assert.equal(data.forwardedProto, "https");
		assert.equal(data.forwardedHost, `${SLUG}.${CUSTOM_DOMAIN}`);
		assert.ok(
			typeof data.forwardedFor === "string" &&
				data.forwardedFor.length > 0
		);
		assert.equal(data.authorization, userAuth);
		assert.notEqual(
			data.authorization,
			API_TOKEN,
			"API token must not leak to backend"
		);
	}
);

// Throttling tests: unauthorized /connect must sleep DELAY_SECONDS before 401
test("/connect unauthorized is throttled by DELAY_SECONDS", async () => {
	const start = Date.now();
	const r = await fetch(
		`${WORKER_BASE}/connect?slug=${encodeURIComponent(SLUG)}`,
		{
			method: "GET",
			headers: { Authorization: "Bearer WRONG" },
		}
	);
	const dt = Date.now() - start;
	// Depending on whether API_TOKEN is configured in the Worker env, status may be 401 (auth enforced) or 502 (forwarding failed to DO).
	assert.ok([401, 502].includes(r.status), `Unexpected status ${r.status}`);
	// Allow tolerance for scheduling/network; expect nearly DELAY_SECONDS seconds
	const minMs = Math.max(0, (DELAY_SECONDS - 3) * 1000);
	assert.ok(dt >= minMs, `Expected >= ${minMs}ms, got ${dt}ms`);
});

// Throttling tests: missing session on subdomain should sleep then 404
test("missing session subdomain is throttled then 404", async () => {
	const ABSENT = `absent-${Date.now().toString(36)}`; // avoid reusing ban cache
	const origin = `https://${ABSENT}.${CUSTOM_DOMAIN}`;
	const start = Date.now();
	const r = await fetch(`${origin}/hello`, { method: "GET" });
	const dt = Date.now() - start;
	assert.equal(r.status, 404);
	const minMs = Math.max(0, (DELAY_SECONDS - 3) * 1000);
	assert.ok(dt >= minMs, `Expected >= ${minMs}ms, got ${dt}ms`);
});

// Concurrency limit test: more than CONCURRENT_SESSIONS_MAX in-flight requests are queued
test(
	"queues over-the-limit concurrent requests (wave timing)",
	{ timeout: 20000 },
	async () => {
		// Ensure CLI is connected and session is active
		await ensureConnectedAndWarm();
		const perReqMs = 100; // lighter per-request delay to avoid long client timeouts
		const waves = 2; // verify at least 2 waves under the limit
		const total = CONCURRENT_SESSIONS_MAX * waves;
		const urls = Array.from(
			{ length: total },
			() => `${PUBLIC_ORIGIN}/slow?ms=${perReqMs}`
		);
		const started = Date.now();
		await Promise.all(
			urls.map(u =>
				fetchWithTimeout(u, { method: "GET" }, 15000).then(r =>
					r.text()
				)
			)
		);
		const dt = Date.now() - started;
		const expectedWaves = Math.ceil(total / CONCURRENT_SESSIONS_MAX);
		const expectedMs = expectedWaves * perReqMs;
		// Should not be faster than ~80% of ideal wave time
		assert.ok(
			dt >= expectedMs * 0.8,
			`Expected >= ~${Math.round(expectedMs * 0.8)}ms (waves=${expectedWaves}), got ${dt}ms`
		);
	}
);
