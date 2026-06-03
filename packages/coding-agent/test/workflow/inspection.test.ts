import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { buildWorkflowInspection } from "../../src/workflow/inspection";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	appendWorkflowGraphPatchApplied,
	appendWorkflowGraphPatchProposed,
	reconstructWorkflowRuns,
	startWorkflowRun,
	type WorkflowRunStoreHost,
} from "../../src/workflow/run-store";

const source = `
name: inspect-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
`;

interface CapturedEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

function createHost(): WorkflowRunStoreHost & { entries: CapturedEntry[] } {
	const entries: CapturedEntry[] = [];
	return {
		entries,
		appendCustomEntry: (customType, data) => {
			entries.push({ type: "custom", customType, data });
			return `entry-${entries.length}`;
		},
		getBranch: () => entries,
	};
}

function graphPatchPreview() {
	return {
		addedNodes: ["scoreboard"],
		removedNodes: [],
		changedNodes: ["review"],
		addedEdges: [{ from: "review", to: "scoreboard" }],
		removedEdges: [],
		changedEdges: [],
		promptSourceChanges: [],
		modelChanges: [{ nodeId: "review", before: { role: "reviewer" }, after: { selector: "openai/gpt-4o" } }],
		permissionChanges: [],
		modelRoleChanges: [],
		warnings: ["review model changed"],
	};
}

describe("workflow inspection model", () => {
	it("summarizes graph, state, activations, revisions, and model assignments", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		appendWorkflowActivationStarted(host, run.id, {
			activationId: "activation-1",
			nodeId: "build",
			graphRevisionId: run.currentGraphRevisionId,
			parentActivationIds: [],
		});
		appendWorkflowActivationCompleted(host, run.id, {
			activationId: "activation-1",
			output: { summary: "built", artifacts: ["artifact://workflow/run-1/build.txt"] },
			modelAudit: {
				nodeId: "build",
				source: "workflow-default",
				requestedRole: "builder",
				requestedPattern: "openai/gpt-4o",
				unavailablePolicy: "fallback-to-parent",
				resolvedModel: "openai/gpt-4o",
				explicitThinkingLevel: false,
				fallbackUsed: false,
			},
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch())[0]!;
		const inspection = buildWorkflowInspection(reconstructed);

		expect(inspection).toEqual({
			runId: "run-1",
			currentGraphRevisionId: "run-1:graph-0",
			graph: {
				nodes: [
					{ id: "build", type: "agent" },
					{ id: "review", type: "review" },
				],
				edges: [{ from: "build", to: "review" }],
			},
			state: {},
			graphRevisions: [{ id: "run-1:graph-0", nodeCount: 2, edgeCount: 1 }],
			pendingGraphPatchProposals: [],
			appliedGraphPatches: [],
			activations: [
				{
					id: "activation-1",
					nodeId: "build",
					graphRevisionId: "run-1:graph-0",
					parentActivationIds: [],
					status: "completed",
					prompt: undefined,
					summary: "built",
					artifacts: ["artifact://workflow/run-1/build.txt"],
					error: undefined,
				},
			],
			modelAssignments: [
				{
					activationId: "activation-1",
					nodeId: "build",
					source: "workflow-default",
					requestedRole: "builder",
					requestedPattern: "openai/gpt-4o",
					resolvedModel: "openai/gpt-4o",
					thinkingLevel: undefined,
					fallbackUsed: false,
					fallbackReason: undefined,
					error: undefined,
				},
			],
		});
	});

	it("summarizes graph patch proposal and application audit records", () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const run = startWorkflowRun(host, definition, { runId: "run-1" });
		const pendingPatch = [{ op: "add_node" as const, node: { id: "human-review", type: "human" as const } }];
		const appliedPatch = [{ op: "add_node" as const, node: { id: "scoreboard", type: "script" as const } }];
		const preview = graphPatchPreview();

		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-pending",
			actor: "agent",
			patch: pendingPatch,
			preview,
			reason: "request human gate",
		});
		appendWorkflowGraphPatchProposed(host, run.id, {
			proposalId: "proposal-applied",
			actor: "agent",
			patch: appliedPatch,
			preview,
			reason: "request scoreboard",
		});
		appendWorkflowGraphPatchApplied(host, run.id, {
			proposalId: "proposal-applied",
			actor: "supervisor",
			patch: appliedPatch,
			preview,
			graphRevisionId: "run-1:graph-1",
			parentGraphRevisionId: run.currentGraphRevisionId,
			reason: "approved scoreboard",
		});

		const reconstructed = reconstructWorkflowRuns(host.getBranch())[0]!;
		const inspection = buildWorkflowInspection(reconstructed);

		expect(inspection.pendingGraphPatchProposals).toEqual([
			{
				id: "proposal-pending",
				actor: "agent",
				reason: "request human gate",
				impact: {
					addedNodes: 1,
					removedNodes: 0,
					changedNodes: 1,
					addedEdges: 1,
					removedEdges: 0,
					changedEdges: 0,
					promptSourceChanges: 0,
					modelChanges: 1,
					permissionChanges: 0,
					modelRoleChanges: 0,
					warnings: 1,
				},
			},
		]);
		expect(inspection.appliedGraphPatches).toEqual([
			{
				proposalId: "proposal-applied",
				actor: "supervisor",
				reason: "approved scoreboard",
				graphRevisionId: "run-1:graph-1",
				parentGraphRevisionId: "run-1:graph-0",
				impact: {
					addedNodes: 1,
					removedNodes: 0,
					changedNodes: 1,
					addedEdges: 1,
					removedEdges: 0,
					changedEdges: 0,
					promptSourceChanges: 0,
					modelChanges: 1,
					permissionChanges: 0,
					modelRoleChanges: 0,
					warnings: 1,
				},
			},
		]);
	});
});
