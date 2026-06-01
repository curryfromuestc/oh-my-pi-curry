import { buildWorkflowInspection, type WorkflowInspection } from "../../workflow/inspection";
import { reconstructWorkflowRuns } from "../../workflow/run-store";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand, usage } from "./parse";

export async function handleWorkflowAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb } = parseSubcommand(command.args);
	if (verb && verb !== "inspect") {
		return usage("Usage: /workflow inspect", runtime);
	}
	const runs = reconstructWorkflowRuns(runtime.sessionManager.getBranch());
	const run = runs.at(-1);
	if (!run) {
		await runtime.output("No workflow runs found.");
		return commandConsumed();
	}
	await runtime.output(formatWorkflowInspection(buildWorkflowInspection(run)));
	return commandConsumed();
}

function formatWorkflowInspection(inspection: WorkflowInspection): string {
	const completed = inspection.activations.filter(activation => activation.status === "completed").length;
	const failed = inspection.activations.filter(activation => activation.status === "failed").length;
	const running = inspection.activations.filter(activation => activation.status === "running").length;
	const lines = [
		`Workflow run: ${inspection.runId}`,
		`Graph: ${inspection.graph.nodes.length} ${plural("node", inspection.graph.nodes.length)}, ${inspection.graph.edges.length} ${plural("edge", inspection.graph.edges.length)}`,
		`Current graph revision: ${inspection.currentGraphRevisionId}`,
		`State keys: ${Object.keys(inspection.state).join(", ") || "none"}`,
		`Activations: ${formatActivationCounts({ completed, failed, running })}`,
	];
	if (inspection.activations.length > 0) {
		lines.push("Activation details:");
		for (const activation of inspection.activations) {
			const summary = activation.summary ? ` - ${activation.summary}` : "";
			lines.push(`- ${activation.id} ${activation.nodeId} ${activation.status}${summary}`);
		}
	}
	if (inspection.modelAssignments.length > 0) {
		lines.push("Model assignments:");
		for (const assignment of inspection.modelAssignments) {
			const model = assignment.resolvedModel ?? "unresolved";
			lines.push(`- ${assignment.activationId} ${assignment.nodeId} ${model} (${assignment.source})`);
		}
	}
	return lines.join("\n");
}

function formatActivationCounts(counts: { completed: number; failed: number; running: number }): string {
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed} completed`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed`);
	if (counts.running > 0) parts.push(`${counts.running} running`);
	return parts.length > 0 ? parts.join(", ") : "0";
}

function plural(word: string, count: number): string {
	return count === 1 ? word : `${word}s`;
}
