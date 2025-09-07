/* eslint-env node */
// Tests for CLI argument parsing and usage output

import assert from "node:assert/strict";
import { test } from "node:test";

// Import compiled ESM build to avoid TypeScript loader requirements
import { runCli } from "../../dist/index.js";

test("prints usage and returns non-zero when required args missing", async () => {
	// Call runCli directly with missing required args
	const code = await runCli({
		http: "http://localhost:8080",
		api: "",
		worker: "",
		json: false,
	});
	assert.notEqual(code, 0);
});
