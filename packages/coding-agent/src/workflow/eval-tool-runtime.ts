import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { EvalToolDetails } from "../eval/types";
import type { ToolSession } from "../tools";
import { EvalTool, type EvalToolParams } from "../tools/eval";
import type { WorkflowScriptEvalResult, WorkflowScriptEvalRunner } from "./session-runtime";

export function createEvalToolScriptRunner(toolSession: ToolSession): WorkflowScriptEvalRunner {
	const evalTool = new EvalTool(toolSession);
	return async request => {
		const params: EvalToolParams = {
			cells: [
				{
					language: request.language,
					code: request.code,
					title: request.title,
				},
			],
		};
		const result = await evalTool.execute(`workflow-${request.activationId}`, params);
		return workflowScriptResultFromEvalTool(request.language, result);
	};
}

function workflowScriptResultFromEvalTool(
	language: WorkflowScriptEvalResult["language"],
	result: AgentToolResult<EvalToolDetails | undefined>,
): WorkflowScriptEvalResult {
	const details = result.details;
	const output = textContent(result.content);
	const exitCode = exitCodeFromEvalDetails(details);
	const scriptResult: WorkflowScriptEvalResult = {
		exitCode,
		output,
		language,
	};
	if (details?.isError) {
		scriptResult.error = output || "eval script failed";
	}
	const artifactId = details?.meta?.truncation?.artifactId;
	if (artifactId !== undefined) {
		scriptResult.artifactId = artifactId;
	}
	return scriptResult;
}

function exitCodeFromEvalDetails(details: EvalToolDetails | undefined): number {
	const firstCell = details?.cells?.[0];
	if (firstCell?.exitCode !== undefined) return firstCell.exitCode;
	return details?.isError ? 1 : 0;
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(item => item.type === "text" && typeof item.text === "string")
		.map(item => item.text)
		.join("\n")
		.trim();
}
