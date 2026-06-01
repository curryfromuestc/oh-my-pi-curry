import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { AgentSession } from "../../src/session/agent-session";
import type { SessionManager } from "../../src/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	startWorkflowRun,
	type WorkflowRunStoreHost,
} from "../../src/workflow/run-store";

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

function createHost(): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

function createRuntime(entries: CapturedEntry[]) {
	const output: string[] = [];
	const session = {} as AgentSession;
	const sessionManager = {
		getBranch: () => entries,
	} as unknown as SessionManager;
	return {
		output,
		runtime: {
			session,
			sessionManager,
			settings: Settings.isolated(),
			cwd: "/tmp/project",
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	};
}

describe("/workflow slash command", () => {
	it("reports when the current session has no workflow runs", async () => {
		const { output, runtime } = createRuntime([]);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["No workflow runs found."]);
	});

	it("prints a compact inspection summary for the latest workflow run", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(
			`
name: slash-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
`,
			{ sourcePath: "workflow.yml" },
		);
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: [],
		});
		appendWorkflowActivationCompleted(host, run.id, {
			activationId: "activation-1",
			output: { summary: "built", artifacts: ["artifact://workflow/run-1/build.txt"] },
			modelAudit: {
				nodeId: "build",
				source: "workflow-default",
				requestedPattern: "openai/gpt-4o",
				unavailablePolicy: "fallback-to-parent",
				resolvedModel: "openai/gpt-4o",
				explicitThinkingLevel: false,
				fallbackUsed: false,
			},
		});
		const { output, runtime } = createRuntime(host.entries);

		const result = await executeAcpBuiltinSlashCommand("/workflow inspect", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output[0]).toContain("Workflow run: run-1");
		expect(output[0]).toContain("Graph: 2 nodes, 1 edge");
		expect(output[0]).toContain("Activations: 1 completed");
		expect(output[0]).toContain("activation-1 build completed - built");
		expect(output[0]).toContain("activation-1 build openai/gpt-4o (workflow-default)");
	});
});
