import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { executeWorkflowNode } from "../../src/workflow/node-runtime";
import type { WorkflowActivation } from "../../src/workflow/scheduler";
import {
	createSessionWorkflowRuntimeHost,
	type WorkflowAgentTaskRequest,
	type WorkflowHumanInputRequest,
	type WorkflowScriptEvalRequest,
} from "../../src/workflow/session-runtime";

const scriptWorkflow = `
name: session-runtime-demo
version: 1
nodes:
  shell:
    type: script
    prompt: return "workflow-ok";
  python:
    type: script
    script:
      language: py
      inline: print("workflow-ok")
  build:
    type: agent
    agent: task
    prompt: Implement the workflow feature.
  review:
    type: review
    agent: reviewer
    prompt: Review the workflow result.
    gates:
      - continue
      - finish
  approve:
    type: human
    prompt: Approve this workflow result?
edges: []
`;

function activation(nodeId: string): WorkflowActivation {
	return {
		id: `activation-${nodeId}`,
		nodeId,
		graphRevisionId: "test-graph",
		status: "running",
		parentActivationIds: [],
	};
}

describe("session workflow runtime host", () => {
	it("maps script nodes to an eval runner when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "shell");
		if (!node) throw new Error("expected shell node");
		let capturedRequest: WorkflowScriptEvalRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "workflow-ok",
					artifactId: "eval-output",
				};
			},
		});

		const output = await host.runScriptNode?.({
			node,
			activation: activation(node.id),
			script: node.prompt,
			model: node.model,
		});

		expect(capturedRequest).toEqual({
			activationId: "activation-shell",
			nodeId: "shell",
			code: 'return "workflow-ok";',
			language: "js",
			title: "shell",
		});
		expect(output).toEqual({
			summary: "workflow-ok",
			data: { exitCode: 0 },
			artifacts: ["artifact://eval-output"],
		});
	});

	it("maps explicit Python script nodes to an eval runner", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "python");
		if (!node) throw new Error("expected python node");
		let capturedRequest: WorkflowScriptEvalRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runEvalScript: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "workflow-ok",
				};
			},
		});

		const output = await executeWorkflowNode(node, activation(node.id), host);

		expect(capturedRequest).toEqual({
			activationId: "activation-python",
			nodeId: "python",
			code: 'print("workflow-ok")',
			language: "py",
			title: "python",
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

	it("maps agent nodes to a single task runner invocation when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "build");
		if (!node) throw new Error("expected build node");
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: "agent completed",
				};
			},
		});

		const output = await host.runAgentNode?.({
			node,
			activation: activation(node.id),
			agent: "task",
			prompt: node.prompt,
			model: node.model,
			modelOverride: "openai/gpt-4o",
		});

		expect(capturedRequest).toEqual({
			agent: "task",
			activationId: "activation-build",
			nodeId: "build",
			modelOverride: "openai/gpt-4o",
			task: {
				id: "build",
				description: "build",
				assignment: "Implement the workflow feature.",
			},
		});
		expect(output).toEqual({
			summary: "agent completed",
			data: { exitCode: 0 },
		});
	});

	it("maps review nodes to a reviewer task and extracts a structured verdict", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "review");
		if (!node) throw new Error("expected review node");
		let capturedRequest: WorkflowAgentTaskRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runAgentTask: async request => {
				capturedRequest = request;
				return {
					exitCode: 0,
					output: JSON.stringify({ verdict: "continue", summary: "review passed" }),
				};
			},
		});

		const output = await host.runReviewNode?.({
			node,
			activation: activation(node.id),
			agent: node.agent,
			prompt: node.prompt,
			model: node.model,
			modelOverride: "openai/gpt-4o",
			gates: node.gates,
		});

		expect(capturedRequest).toEqual({
			agent: "reviewer",
			activationId: "activation-review",
			nodeId: "review",
			modelOverride: "openai/gpt-4o",
			task: {
				id: "review",
				description: "review",
				assignment: "Review the workflow result.",
			},
		});
		expect(output).toEqual({
			summary: "review passed",
			verdict: "continue",
		});
	});

	it("maps human nodes to a human input runner when configured", async () => {
		const definition = parseWorkflowDefinition(scriptWorkflow, { sourcePath: "workflow.yml" });
		const node = definition.nodes.find(candidate => candidate.id === "approve");
		if (!node) throw new Error("expected approve node");
		let capturedRequest: WorkflowHumanInputRequest | undefined;
		const host = createSessionWorkflowRuntimeHost({
			cwd: process.cwd(),
			runHumanInput: async request => {
				capturedRequest = request;
				return {
					response: "approved",
					selectedOptions: ["Approve"],
				};
			},
		});

		const output = await host.runHumanNode?.({
			node,
			activation: activation(node.id),
			prompt: node.prompt,
		});

		expect(capturedRequest).toEqual({
			activationId: "activation-approve",
			nodeId: "approve",
			question: "Approve this workflow result?",
		});
		expect(output).toEqual({
			summary: "approved",
			data: {
				response: "approved",
				selectedOptions: ["Approve"],
			},
		});
	});
});
