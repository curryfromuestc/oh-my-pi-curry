import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { exportSessionToHtml } from "../../src/export/html";
import { TEMPLATE } from "../../src/export/html/template.generated";
import { SessionManager } from "../../src/session/session-manager";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowInspection } from "../../src/workflow/inspection";
import {
	appendWorkflowActivationCompleted,
	appendWorkflowActivationStarted,
	appendWorkflowStatePatch,
	startWorkflowRun,
} from "../../src/workflow/run-store";

const workflowSource = `
name: export-visible-workflow
version: 1
models:
  defaults:
    agent: openai/gpt-4o
nodes:
  build:
    type: agent
    agent: task
    prompt: Build the artifact.
edges: []
`;

interface ExportedSessionData {
	workflowInspections?: WorkflowInspection[];
}

describe("HTML export workflow inspection support", () => {
	it("exports compact workflow inspection data reconstructed from session events", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-html-workflow-export-"));
		const sm = SessionManager.create(dir, dir);
		const outputPath = path.join(dir, "session.html");
		const definition = parseWorkflowDefinition(workflowSource, { sourcePath: path.join(dir, "workflow.yml") });
		try {
			startWorkflowRun(sm, definition, { runId: "run-export", graphRevisionId: "graph-0" });
			appendWorkflowActivationStarted(sm, "run-export", {
				activationId: "activation-1",
				nodeId: "build",
				graphRevisionId: "graph-0",
				parentActivationIds: [],
				input: {
					prompt: {
						value: "Build the artifact.",
						byteLength: 19,
						contentHash: "sha256:export-prompt",
						source: { kind: "inline", text: "Build the artifact." },
					},
				},
			});
			appendWorkflowActivationCompleted(sm, "run-export", {
				activationId: "activation-1",
				output: {
					summary: "built package",
					artifacts: ["artifact://build-log"],
				},
				modelAudit: {
					nodeId: "build",
					source: "workflow-default",
					requestedPattern: "openai/gpt-4o",
					unavailablePolicy: "fallback-to-parent",
					resolvedModel: "openai/gpt-4o",
					explicitThinkingLevel: false,
					fallbackUsed: false,
				},
			});
			appendWorkflowStatePatch(sm, "run-export", {
				patch: [{ op: "set", path: "/score", value: 0.92 }],
				reason: "export fixture",
			});

			await exportSessionToHtml(sm, undefined, { outputPath });
			const exported = decodeSessionData(await Bun.file(outputPath).text());

			expect(exported.workflowInspections).toEqual([
				{
					runId: "run-export",
					currentGraphRevisionId: "graph-0",
					graph: {
						nodes: [{ id: "build", type: "agent" }],
						edges: [],
					},
					state: { score: 0.92 },
					graphRevisions: [{ id: "graph-0", nodeCount: 1, edgeCount: 0 }],
					pendingGraphPatchProposals: [],
					appliedGraphPatches: [],
					activations: [
						{
							id: "activation-1",
							nodeId: "build",
							graphRevisionId: "graph-0",
							parentActivationIds: [],
							status: "completed",
							prompt: {
								value: "Build the artifact.",
								byteLength: 19,
								contentHash: "sha256:export-prompt",
								source: { kind: "inline", text: "Build the artifact." },
							},
							summary: "built package",
							artifacts: ["artifact://build-log"],
						},
					],
					modelAssignments: [
						{
							activationId: "activation-1",
							nodeId: "build",
							source: "workflow-default",
							requestedPattern: "openai/gpt-4o",
							resolvedModel: "openai/gpt-4o",
							fallbackUsed: false,
						},
					],
				},
			]);
		} finally {
			await sm.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("includes a workflow overview renderer in the generated template", () => {
		expect(TEMPLATE).toContain("renderWorkflowOverview");
		expect(TEMPLATE).toContain("workflow-overview");
		expect(TEMPLATE).toContain("workflowInspections");
	});
});

function decodeSessionData(html: string): ExportedSessionData {
	const match = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/);
	if (!match) throw new Error("session data script not found");
	return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as ExportedSessionData;
}
