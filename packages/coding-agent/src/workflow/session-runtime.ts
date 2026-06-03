import type { WorkflowScriptLanguage } from "./definition";
import type { WorkflowNodeRuntimeHost, WorkflowReviewNodeOutput } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";
import type { WorkflowActivationOutput } from "./state";

export interface WorkflowSessionRuntimeOptions {
	cwd: string;
	runEvalScript?: WorkflowScriptEvalRunner;
	runAgentTask?: WorkflowAgentTaskRunner;
	runHumanInput?: WorkflowHumanInputRunner;
}

export interface WorkflowAgentTaskRequest {
	agent: string;
	activationId: string;
	nodeId: string;
	modelOverride?: string;
	task: WorkflowAgentTaskItem;
}

export interface WorkflowAgentTaskItem {
	id: string;
	description: string;
	assignment: string;
}

export interface WorkflowAgentTaskResult {
	exitCode: number;
	output: string;
	stderr?: string;
	error?: string;
	outputPath?: string;
}

export type WorkflowAgentTaskRunner = (request: WorkflowAgentTaskRequest) => Promise<WorkflowAgentTaskResult>;

export type WorkflowScriptEvalLanguage = WorkflowScriptLanguage;

export interface WorkflowScriptEvalRequest {
	activationId: string;
	nodeId: string;
	code: string;
	language: WorkflowScriptEvalLanguage;
	title: string;
}

export interface WorkflowScriptEvalResult {
	exitCode: number;
	output: string;
	error?: string;
	artifactId?: string;
	language?: WorkflowScriptEvalLanguage;
}

export type WorkflowScriptEvalRunner = (request: WorkflowScriptEvalRequest) => Promise<WorkflowScriptEvalResult>;

export interface WorkflowHumanInputRequest {
	activationId: string;
	nodeId: string;
	question: string;
}

export interface WorkflowHumanInputResult {
	response: string;
	selectedOptions?: string[];
	customInput?: string;
}

export type WorkflowHumanInputRunner = (request: WorkflowHumanInputRequest) => Promise<WorkflowHumanInputResult>;

export function createSessionWorkflowRuntimeHost(options: WorkflowSessionRuntimeOptions): WorkflowNodeRuntimeHost {
	return {
		runAgentNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow agent node "${input.node.id}" requires a subagent runtime adapter`,
				);
			}
			const task: WorkflowAgentTaskItem = {
				id: taskIdForNode(input.node.id),
				description: input.node.id,
				assignment: input.prompt?.trim() || `Run workflow node "${input.node.id}".`,
			};
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent,
				activationId: input.activation.id,
				nodeId: input.node.id,
				task,
			};
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
			}
			const result = await options.runAgentTask(request);
			return activationOutputFromTaskResult(input.node.id, result);
		},
		runScriptNode: async input => {
			if (!options.runEvalScript) {
				throw new WorkflowNodeRuntimeError(
					`workflow script node "${input.node.id}" requires an eval runtime adapter`,
				);
			}
			const code = input.script?.trim();
			if (!code) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" must define script code`);
			}
			const result = await options.runEvalScript({
				activationId: input.activation.id,
				nodeId: input.node.id,
				code,
				language: input.scriptLanguage ?? "js",
				title: input.scriptPath ?? input.node.id,
			});
			if (result.exitCode !== 0) {
				const reason = result.error || `exit code ${result.exitCode}`;
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" failed: ${reason}`);
			}
			const summary = result.output.trim() || `script node "${input.node.id}" completed`;
			const output: WorkflowActivationOutput = {
				summary,
				data: { exitCode: result.exitCode },
			};
			if (result.artifactId) {
				output.artifacts = [`artifact://${result.artifactId}`];
			}
			return output;
		},
		runHumanNode: async input => {
			if (!options.runHumanInput) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" requires a human input adapter`);
			}
			const question = input.prompt?.trim();
			if (!question) {
				throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" must define a question prompt`);
			}
			const result = await options.runHumanInput({
				activationId: input.activation.id,
				nodeId: input.node.id,
				question,
			});
			return activationOutputFromHumanInputResult(result);
		},
		runReviewNode: async input => {
			if (!options.runAgentTask) {
				throw new WorkflowNodeRuntimeError(
					`workflow review node "${input.node.id}" requires a review runtime adapter`,
				);
			}
			const assignment = input.prompt?.trim();
			if (!assignment) {
				throw new WorkflowNodeRuntimeError(`workflow review node "${input.node.id}" must define a review prompt`);
			}
			const request: WorkflowAgentTaskRequest = {
				agent: input.agent ?? "reviewer",
				activationId: input.activation.id,
				nodeId: input.node.id,
				task: {
					id: taskIdForNode(input.node.id),
					description: input.node.id,
					assignment,
				},
			};
			if (input.modelOverride !== undefined) {
				request.modelOverride = input.modelOverride;
			}
			const result = await options.runAgentTask(request);
			return reviewOutputFromTaskResult(input.node.id, result, input.gates);
		},
	};
}

function taskIdForNode(nodeId: string): string {
	const sanitized = nodeId.replaceAll(/[^A-Za-z0-9_]/g, "_").slice(0, 48);
	return sanitized || "workflow_node";
}

function activationOutputFromTaskResult(nodeId: string, result: WorkflowAgentTaskResult): WorkflowActivationOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow agent node "${nodeId}" failed: ${reason}`);
	}
	const output: WorkflowActivationOutput = {
		summary: result.output.trim() || `agent node "${nodeId}" completed`,
		data: { exitCode: result.exitCode },
	};
	if (result.outputPath) {
		output.artifacts = [`local://${result.outputPath}`];
	}
	return output;
}

function activationOutputFromHumanInputResult(result: WorkflowHumanInputResult): WorkflowActivationOutput {
	const data: Record<string, unknown> = {
		response: result.response,
	};
	if (result.selectedOptions !== undefined) data.selectedOptions = result.selectedOptions;
	if (result.customInput !== undefined) data.customInput = result.customInput;
	return {
		summary: result.response,
		data,
	};
}

function reviewOutputFromTaskResult(
	nodeId: string,
	result: WorkflowAgentTaskResult,
	gates: string[] | undefined,
): WorkflowReviewNodeOutput {
	if (result.exitCode !== 0) {
		const reason = result.error || result.stderr || `exit code ${result.exitCode}`;
		throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" failed: ${reason}`);
	}
	const parsed = parseReviewTaskOutput(nodeId, result.output, gates);
	const output: WorkflowReviewNodeOutput = {
		summary: parsed.summary,
		verdict: parsed.verdict,
	};
	if (result.outputPath) {
		output.artifacts = [`local://${result.outputPath}`];
	}
	return output;
}

function parseReviewTaskOutput(
	nodeId: string,
	output: string,
	gates: string[] | undefined,
): { verdict: string; summary: string } {
	const trimmed = output.trim();
	const parsed = parseJsonObject(trimmed);
	if (parsed) {
		const verdict = parsed.verdict;
		if (typeof verdict !== "string" || verdict.length === 0) {
			throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" must return a string verdict`);
		}
		const summary = typeof parsed.summary === "string" && parsed.summary.length > 0 ? parsed.summary : trimmed;
		return { verdict, summary };
	}
	if (gates?.includes(trimmed)) {
		return { verdict: trimmed, summary: trimmed };
	}
	throw new WorkflowNodeRuntimeError(`workflow review node "${nodeId}" must return a verdict`);
}

function parseJsonObject(source: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(source);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
