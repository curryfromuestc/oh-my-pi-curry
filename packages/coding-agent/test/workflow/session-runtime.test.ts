import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowActivation } from "../../src/workflow/scheduler";
import { createSessionWorkflowRuntimeHost } from "../../src/workflow/session-runtime";

const scriptWorkflow = `
name: session-runtime-demo
version: 1
nodes:
  shell:
    type: script
    prompt: printf workflow-ok
  build:
    type: agent
    agent: task
edges: []
`;

function activation(nodeId: string): WorkflowActivation {
	return {
		id: `activation-${nodeId}`,
		nodeId,
		status: "running",
		parentActivationIds: [],
	};
}

describe("session workflow runtime host", () => {
	it("executes script nodes through the shell executor", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		const host = createSessionWorkflowRuntimeHost({ cwd: process.cwd() });

		const output = await host.runScriptNode?.({
			node,
			activation: activation(node.id),
			script: node.prompt,
			model: node.model,
		});

		expect(output).toEqual({
			summary: "workflow-ok",
			data: { exitCode: 0 },
		});
	});

	it("fails agent nodes until a real subagent adapter is configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		const host = createSessionWorkflowRuntimeHost({ cwd: process.cwd() });

		await expect(
			host.runAgentNode?.({
				node,
				activation: activation(node.id),
				agent: "task",
				prompt: node.prompt,
				model: node.model,
			}),
		).rejects.toThrow('workflow agent node "build" requires a subagent runtime adapter');
	});
});
