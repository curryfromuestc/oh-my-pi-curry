import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import type { WorkflowHumanInputResult, WorkflowHumanInputRunner } from "./session-runtime";

export function createAskToolHumanInputRunner(
	toolSession: ToolSession,
	getToolContext: () => AgentToolContext,
): WorkflowHumanInputRunner {
	return async request => {
		const askTool = AskTool.createIf(toolSession);
		if (!askTool) {
			throw new Error(`workflow human node "${request.nodeId}" requires interactive mode`);
		}
		const result = await askTool.execute(
			`workflow-${request.activationId}`,
			{
				questions: [
					{
						id: "response",
						question: request.question,
						options: [{ label: "Approve" }, { label: "Reject" }],
						recommended: 0,
					},
				],
			},
			undefined,
			undefined,
			getToolContext(),
		);
		const details = result.details;
		const response = responseFromAskDetails(details);
		const output: WorkflowHumanInputResult = {
			response,
		};
		if (details?.selectedOptions !== undefined) output.selectedOptions = details.selectedOptions;
		if (details?.customInput !== undefined) output.customInput = details.customInput;
		return output;
	};
}

function responseFromAskDetails(details: WorkflowAskDetails | undefined): string {
	if (details?.customInput !== undefined) return details.customInput;
	const selected = details?.selectedOptions?.[0];
	if (selected) return selected;
	return "User did not provide a response";
}

interface WorkflowAskDetails {
	selectedOptions?: string[];
	customInput?: string;
}
