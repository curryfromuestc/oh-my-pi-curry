import { type BashResult, executeBash } from "../exec/bash-executor";
import type { WorkflowNodeRuntimeHost } from "./node-runtime";
import { WorkflowNodeRuntimeError } from "./node-runtime";

export interface WorkflowSessionRuntimeOptions {
	cwd: string;
	runShellCommand?: (command: string, options: WorkflowShellCommandOptions) => Promise<BashResult>;
}

export interface WorkflowShellCommandOptions {
	cwd: string;
	timeout: number;
}

const DEFAULT_WORKFLOW_SCRIPT_TIMEOUT_MS = 300_000;

export function createSessionWorkflowRuntimeHost(options: WorkflowSessionRuntimeOptions): WorkflowNodeRuntimeHost {
	const runShellCommand = options.runShellCommand ?? executeBash;
	return {
		runAgentNode: async input => {
			throw new WorkflowNodeRuntimeError(
				`workflow agent node "${input.node.id}" requires a subagent runtime adapter`,
			);
		},
		runScriptNode: async input => {
			const command = input.script?.trim();
			if (!command) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" must define a script command`);
			}
			const result = await runShellCommand(command, {
				cwd: options.cwd,
				timeout: DEFAULT_WORKFLOW_SCRIPT_TIMEOUT_MS,
			});
			if (result.cancelled) {
				throw new WorkflowNodeRuntimeError(`workflow script node "${input.node.id}" was cancelled`);
			}
			if (result.exitCode !== 0) {
				throw new WorkflowNodeRuntimeError(
					`workflow script node "${input.node.id}" exited with code ${result.exitCode ?? "unknown"}`,
				);
			}
			const summary = result.output.trim() || `script node "${input.node.id}" completed`;
			return {
				summary,
				data: { exitCode: result.exitCode },
			};
		},
		runHumanNode: async input => {
			throw new WorkflowNodeRuntimeError(`workflow human node "${input.node.id}" requires a human input adapter`);
		},
		runReviewNode: async input => {
			throw new WorkflowNodeRuntimeError(
				`workflow review node "${input.node.id}" requires a review runtime adapter`,
			);
		},
	};
}
