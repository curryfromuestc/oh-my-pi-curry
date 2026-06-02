import type { WorkflowNodeType } from "./definition";
import type { WorkflowResolvedPrompt } from "./prompt-source";
import type { WorkflowActivationRecord, WorkflowRunSnapshot } from "./run-store";

export interface WorkflowInspection {
	runId: string;
	currentGraphRevisionId: string;
	graph: WorkflowInspectionGraph;
	state: Record<string, unknown>;
	graphRevisions: WorkflowInspectionGraphRevision[];
	activations: WorkflowInspectionActivation[];
	modelAssignments: WorkflowInspectionModelAssignment[];
}

export interface WorkflowInspectionGraph {
	nodes: WorkflowInspectionNode[];
	edges: WorkflowInspectionEdge[];
}

export interface WorkflowInspectionNode {
	id: string;
	type: WorkflowNodeType;
}

export interface WorkflowInspectionEdge {
	from: string;
	to: string;
	condition?: string;
}

export interface WorkflowInspectionGraphRevision {
	id: string;
	nodeCount: number;
	edgeCount: number;
}

export interface WorkflowInspectionActivation {
	id: string;
	nodeId: string;
	graphRevisionId: string;
	parentActivationIds: string[];
	status: WorkflowActivationRecord["status"];
	prompt?: WorkflowResolvedPrompt;
	summary?: string;
	artifacts?: string[];
	error?: string;
}

export interface WorkflowInspectionModelAssignment {
	activationId: string;
	nodeId: string;
	source: string;
	requestedRole?: string;
	requestedPattern?: string;
	resolvedModel?: string;
	thinkingLevel?: string;
	fallbackUsed: boolean;
	fallbackReason?: string;
	error?: string;
}

export function buildWorkflowInspection(run: WorkflowRunSnapshot): WorkflowInspection {
	return {
		runId: run.id,
		currentGraphRevisionId: run.currentGraphRevisionId,
		graph: {
			nodes: run.definition.nodes.map(node => ({ id: node.id, type: node.type })),
			edges: run.definition.edges.map(edge => compactEdge(edge.from, edge.to, edge.condition?.source)),
		},
		state: run.state,
		graphRevisions: run.graphRevisions.map(revision => ({
			id: revision.id,
			nodeCount: revision.definition.nodes.length,
			edgeCount: revision.definition.edges.length,
		})),
		activations: run.activations.map(activation => ({
			id: activation.id,
			nodeId: activation.nodeId,
			graphRevisionId: activation.graphRevisionId,
			parentActivationIds: activation.parentActivationIds,
			status: activation.status,
			prompt: activation.input?.prompt,
			summary: activation.output?.summary,
			artifacts: activation.output?.artifacts,
			error: activation.error,
		})),
		modelAssignments: run.activations.flatMap(activation => {
			const audit = activation.modelAudit;
			if (!audit) return [];
			return [
				{
					activationId: activation.id,
					nodeId: activation.nodeId,
					source: audit.source,
					requestedRole: audit.requestedRole,
					requestedPattern: audit.requestedPattern,
					resolvedModel: audit.resolvedModel,
					thinkingLevel: audit.thinkingLevel,
					fallbackUsed: audit.fallbackUsed,
					fallbackReason: audit.fallbackReason,
					error: audit.error,
				},
			];
		}),
	};
}

function compactEdge(from: string, to: string, condition: string | undefined): WorkflowInspectionEdge {
	const edge: WorkflowInspectionEdge = { from, to };
	if (condition !== undefined) edge.condition = condition;
	return edge;
}
