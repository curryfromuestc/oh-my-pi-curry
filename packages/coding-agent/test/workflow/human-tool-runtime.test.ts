import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { ExtensionUIContext, ExtensionUISelectItem } from "../../src/extensibility/extensions";
import { initTheme } from "../../src/modes/theme/theme";
import type { ToolSession } from "../../src/tools";
import { createAskToolHumanInputRunner } from "../../src/workflow/human-tool-runtime";

function createToolSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"ask.notify": "off",
			"ask.timeout": 0,
		}),
	};
}

function createToolContext(ui: ExtensionUIContext): AgentToolContext {
	return {
		hasUI: true,
		ui,
		abort: () => {},
	} as unknown as AgentToolContext;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("workflow human input ask tool runtime adapter", () => {
	it("asks through the existing ask tool and returns the selected response", async () => {
		let capturedTitle: string | undefined;
		let capturedOptions: ExtensionUISelectItem[] | undefined;
		const ui = {
			select: async (title: string, options: ExtensionUISelectItem[]) => {
				capturedTitle = title;
				capturedOptions = options;
				return "Approve (Recommended)";
			},
			editor: async () => undefined,
		} as unknown as ExtensionUIContext;
		const runner = createAskToolHumanInputRunner(createToolSession(), () => createToolContext(ui));

		const result = await runner({
			activationId: "activation-approve",
			nodeId: "approve",
			question: "Approve this workflow result?",
		});

		expect(capturedTitle).toBe("Approve this workflow result?");
		expect(capturedOptions?.map(option => (typeof option === "string" ? option : option.label))).toEqual([
			"Approve (Recommended)",
			"Reject",
			"Other (type your own)",
		]);
		expect(result).toEqual({
			response: "Approve",
			selectedOptions: ["Approve"],
		});
	});
});
