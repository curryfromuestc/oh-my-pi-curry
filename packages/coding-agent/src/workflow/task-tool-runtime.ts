import { type TaskParams, TaskTool } from "../task";
import type { ToolSession } from "../tools";
import type { WorkflowAgentTaskResult, WorkflowAgentTaskRunner } from "./session-runtime";

export function createTaskToolAgentRunner(toolSession: ToolSession): WorkflowAgentTaskRunner {
	return async request => {
		const taskTool = await TaskTool.create(await synchronousTaskToolSession(toolSession));
		const params: TaskParams = {
			agent: request.agent,
			tasks: [request.task],
		};
		if (request.modelOverride !== undefined) {
			params.modelOverride = request.modelOverride;
		}
		const result = await taskTool.execute(`workflow-${request.activationId}`, params);
		const taskResult = result.details?.results[0];
		if (!taskResult) {
			return {
				exitCode: 1,
				output: textContent(result.content),
				error: `workflow agent node "${request.nodeId}" did not return a task result`,
			};
		}
		const output: WorkflowAgentTaskResult = {
			exitCode: taskResult.exitCode,
			output: taskResult.output,
			stderr: taskResult.stderr,
		};
		if (taskResult.error !== undefined) output.error = taskResult.error;
		if (taskResult.outputPath !== undefined) output.outputPath = taskResult.outputPath;
		return output;
	};
}

async function synchronousTaskToolSession(toolSession: ToolSession): Promise<ToolSession> {
	if (!toolSession.settings.get("async.enabled")) return toolSession;
	const settings = await toolSession.settings.cloneForCwd(toolSession.cwd);
	settings.override("async.enabled", false);
	return { ...toolSession, settings };
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
}
