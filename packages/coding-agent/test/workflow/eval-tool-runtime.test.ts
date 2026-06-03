import { afterAll, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import type { ToolSession } from "../../src/tools";
import { createEvalToolScriptRunner } from "../../src/workflow/eval-tool-runtime";

function createToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"eval.js": true,
			"eval.py": false,
		}),
		assertEvalExecutionAllowed: () => {},
	} as unknown as ToolSession;
}

afterAll(async () => {
	await disposeAllVmContexts();
});

describe("workflow eval tool runtime adapter", () => {
	it("runs workflow script requests through the existing eval tool", async () => {
		using tempDir = TempDir.createSync("@omp-workflow-eval-");
		const runner = createEvalToolScriptRunner(createToolSession(tempDir.path()));

		const result = await runner({
			activationId: "activation-script",
			nodeId: "script",
			code: 'return "workflow-ok";',
			language: "js",
			title: "script",
		});

		expect(result).toEqual({
			exitCode: 0,
			output: "workflow-ok",
			language: "js",
		});
	});
});
