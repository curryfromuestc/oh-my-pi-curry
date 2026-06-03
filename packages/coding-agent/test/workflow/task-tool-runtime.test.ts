import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import type { TaskParams, TaskToolDetails } from "../../src/task";
import * as taskModule from "../../src/task";
import type { ToolSession } from "../../src/tools";
import type { WorkflowAgentTaskRequest } from "../../src/workflow/session-runtime";
import { createTaskToolAgentRunner } from "../../src/workflow/task-tool-runtime";

afterEach(() => {
	vi.restoreAllMocks();
});

function createToolSession(settings: Settings = Settings.isolated()): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

function createRequest(): WorkflowAgentTaskRequest {
	return {
		agent: "task",
		activationId: "activation-build",
		nodeId: "build",
		modelOverride: "openai/gpt-4o",
		task: {
			id: "build",
			description: "build",
			assignment: "Implement the workflow feature.",
		},
	};
}

describe("workflow task tool runtime adapter", () => {
	it("runs a workflow agent task through TaskTool and returns the first task result", async () => {
		let capturedParams: TaskParams | undefined;
		const taskTool = {
			execute: async (_toolCallId: string, params: unknown): Promise<AgentToolResult<TaskToolDetails>> => {
				capturedParams = params as TaskParams;
				return {
					content: [{ type: "text", text: "task tool completed" }],
					details: {
						projectAgentsDir: null,
						totalDurationMs: 12,
						results: [
							{
								index: 0,
								id: "build",
								agent: "task",
								agentSource: "project",
								task: "Implement the workflow feature.",
								assignment: "Implement the workflow feature.",
								description: "build",
								exitCode: 0,
								output: "agent completed",
								stderr: "",
								truncated: false,
								durationMs: 12,
								tokens: 0,
								outputPath: "/tmp/agent-output.md",
							},
						],
					},
				};
			},
		};
		vi.spyOn(taskModule.TaskTool, "create").mockResolvedValue(taskTool as unknown as taskModule.TaskTool);
		const runner = createTaskToolAgentRunner(createToolSession());

		const result = await runner(createRequest());

		expect(capturedParams).toEqual({
			agent: "task",
			modelOverride: "openai/gpt-4o",
			tasks: [
				{
					id: "build",
					description: "build",
					assignment: "Implement the workflow feature.",
				},
			],
		});
		expect(result).toEqual({
			exitCode: 0,
			output: "agent completed",
			stderr: "",
			outputPath: "/tmp/agent-output.md",
		});
	});

	it("keeps workflow task execution synchronous when parent async tasks are enabled", async () => {
		const parentSettings = Settings.isolated({ "async.enabled": true });
		let capturedSession: ToolSession | undefined;
		const taskTool = {
			execute: async (): Promise<AgentToolResult<TaskToolDetails>> => ({
				content: [{ type: "text", text: "task tool completed" }],
				details: {
					projectAgentsDir: null,
					totalDurationMs: 12,
					results: [
						{
							index: 0,
							id: "build",
							agent: "task",
							agentSource: "project",
							task: "Implement the workflow feature.",
							assignment: "Implement the workflow feature.",
							description: "build",
							exitCode: 0,
							output: "agent completed",
							stderr: "",
							truncated: false,
							durationMs: 12,
							tokens: 0,
						},
					],
				},
			}),
		};
		vi.spyOn(taskModule.TaskTool, "create").mockImplementation(async session => {
			capturedSession = session;
			return taskTool as unknown as taskModule.TaskTool;
		});
		const runner = createTaskToolAgentRunner(createToolSession(parentSettings));

		const result = await runner(createRequest());

		expect(result.exitCode).toBe(0);
		expect(capturedSession?.settings.get("async.enabled")).toBe(false);
		expect(parentSettings.get("async.enabled")).toBe(true);
	});
});
