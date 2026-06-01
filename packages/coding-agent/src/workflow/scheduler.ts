import { evaluateWorkflowCondition } from "./condition";
import type { WorkflowDefinition, WorkflowNode } from "./definition";
import { applyWorkflowStatePatch, validateWorkflowActivationOutput, type WorkflowActivationOutput } from "./state";

export type WorkflowActivationStatus = "queued" | "running" | "completed" | "failed";

export interface WorkflowActivation {
	id: string;
	nodeId: string;
	status: WorkflowActivationStatus;
	parentActivationIds: string[];
	output?: WorkflowActivationOutput;
	error?: string;
}

export interface WorkflowSchedulerOptions {
	startNodeId: string;
	initialState?: Record<string, unknown>;
	maxActivations?: number;
	maxNodeActivations?: number;
	executeNode: (activation: WorkflowActivation, node: WorkflowNode) => Promise<WorkflowActivationOutput>;
}

export interface WorkflowSchedulerResult {
	activations: WorkflowActivation[];
	limitReached: boolean;
	state: Record<string, unknown>;
}

export async function runWorkflowScheduler(
	definition: WorkflowDefinition,
	options: WorkflowSchedulerOptions,
): Promise<WorkflowSchedulerResult> {
	const nodesById = new Map(definition.nodes.map(node => [node.id, node]));
	const state = options.initialState ?? {};
	const activations: WorkflowActivation[] = [];
	const completedByNode = new Map<string, WorkflowActivation[]>();
	const outputsByNode: Record<string, unknown> = {};
	const queuedJoinKeys = new Set<string>();
	let nextActivationId = 1;
	const createNextActivation = (nodeId: string, parentActivationIds: string[]): WorkflowActivation => ({
		id: `activation-${nextActivationId++}`,
		nodeId,
		status: "queued",
		parentActivationIds,
	});
	const maxActivations = options.maxActivations ?? Number.POSITIVE_INFINITY;
	const maxNodeActivations = options.maxNodeActivations ?? Number.POSITIVE_INFINITY;
	const queue: WorkflowActivation[] = [createNextActivation(options.startNodeId, [])];
	let limitReached = false;

	while (queue.length > 0) {
		if (activations.length >= maxActivations) {
			limitReached = true;
			break;
		}
		const activation = queue.shift();
		if (!activation) break;
		if (countNodeActivations(activations, activation.nodeId) >= maxNodeActivations) {
			limitReached = true;
			break;
		}
		const node = nodesById.get(activation.nodeId);
		if (!node) {
			activation.status = "failed";
			activation.error = `unknown node "${activation.nodeId}"`;
			activations.push(activation);
			continue;
		}
		activation.status = "running";
		activations.push(activation);
		try {
			activation.output = validateWorkflowActivationOutput(await options.executeNode(activation, node), {
				allowedWritePaths: node.writes,
			});
			if (activation.output.statePatch) {
				applyWorkflowStatePatch(state, activation.output.statePatch, { allowedWritePaths: node.writes });
			}
			if (activation.output.data !== undefined) {
				outputsByNode[activation.nodeId] = activation.output.data;
			} else {
				delete outputsByNode[activation.nodeId];
			}
			activation.status = "completed";
			const completed = completedByNode.get(activation.nodeId) ?? [];
			completed.push(activation);
			completedByNode.set(activation.nodeId, completed);
		} catch (error) {
			activation.status = "failed";
			activation.error = error instanceof Error ? error.message : String(error);
			continue;
		}
		for (const edge of definition.edges.filter(edge => edge.from === activation.nodeId)) {
			if (edge.condition && !evaluateWorkflowCondition(edge.condition.source, { state, outputs: outputsByNode })) {
				continue;
			}
			const target = nodesById.get(edge.to);
			if (target?.waitFor?.length) {
				const parentActivationIds = collectJoinParentIds(target.waitFor, completedByNode);
				if (!parentActivationIds) continue;
				const joinKey = `${target.id}:${parentActivationIds.join(",")}`;
				if (queuedJoinKeys.has(joinKey)) continue;
				queuedJoinKeys.add(joinKey);
				queue.push(createNextActivation(edge.to, parentActivationIds));
				continue;
			}
			queue.push(createNextActivation(edge.to, [activation.id]));
		}
	}

	return { activations, limitReached, state };
}

function countNodeActivations(activations: WorkflowActivation[], nodeId: string): number {
	return activations.filter(activation => activation.nodeId === nodeId).length;
}

function collectJoinParentIds(
	waitFor: string[],
	completedByNode: Map<string, WorkflowActivation[]>,
): string[] | undefined {
	const parentIds: string[] = [];
	for (const nodeId of waitFor) {
		const completed = completedByNode.get(nodeId);
		const latest = completed?.at(-1);
		if (!latest) return undefined;
		parentIds.push(latest.id);
	}
	return parentIds;
}
