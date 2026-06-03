import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import type { WorkflowNodeRuntimeHost, WorkflowScriptNodeInput } from "../../src/workflow/node-runtime";
import { reconstructWorkflowRuns, type WorkflowRunStoreHost } from "../../src/workflow/run-store";
import { runWorkflow } from "../../src/workflow/runner";

const openAiModel: Model<Api> = {
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://openai.example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

const source = `
name: runner-demo
version: 1
models:
  roles:
    builder: openai/gpt-4o
    reviewer: openai/gpt-4o
  defaults:
    agent: builder
nodes:
  build:
    type: agent
    agent: task
    writes:
      - /work
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
      unavailable: fail
    gates:
      - finish
    writes:
      - /verdict
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

describe("workflow runner", () => {
	it("persists activation lifecycle, state patches, artifacts, and model audit for a run", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => ({
				summary: "build completed",
				artifacts: ["artifact://workflow/run-1/build.txt"],
				statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
			}),
			runReviewNode: async () => ({
				summary: "review completed",
				verdict: "finish",
				artifacts: ["artifact://workflow/run-1/review.txt"],
			}),
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "build",
			runtimeHost,
			modelResolution: { availableModels: [openAiModel] },
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "completed"],
			["review", "completed"],
		]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.state).toEqual({ work: { summary: "built" }, verdict: "finish" });
		expect(reconstructed[0]?.activations.map(activation => activation.status)).toEqual(["completed", "completed"]);
		expect(reconstructed[0]?.activations[0]?.output).toEqual({
			summary: "build completed",
			artifacts: ["artifact://workflow/run-1/build.txt"],
			statePatch: [{ op: "set", path: "/work/summary", value: "built" }],
		});
		expect(reconstructed[0]?.activations[0]?.modelAudit?.resolvedModel).toBe("openai/gpt-4o");
		expect(reconstructed[0]?.activations[1]?.modelAudit).toMatchObject({
			nodeId: "review",
			source: "node",
			requestedRole: "reviewer",
			resolvedModel: "openai/gpt-4o",
			fallbackUsed: false,
		});
	});

	it("persists failed activations when node execution rejects", async () => {
		const host = createHost();
		const definition = parseWorkflowDefinition(source, { sourcePath: "workflow.yml" });
		const runtimeHost: WorkflowNodeRuntimeHost = {
			runAgentNode: async () => {
				throw new Error("build failed");
			},
		};

		const result = await runWorkflow({
			host,
			definition,
			runId: "run-1",
			startNodeId: "build",
			runtimeHost,
			modelResolution: { availableModels: [openAiModel] },
		});

		expect(result.scheduler.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["build", "failed"],
		]);
		const reconstructed = reconstructWorkflowRuns(host.getBranch());
		expect(reconstructed[0]?.activations).toMatchObject([
			{
				id: "activation-1",
				nodeId: "build",
				graphRevisionId: "run-1:graph-0",
				status: "failed",
				error: "build failed",
			},
		]);
	});

	it("loads package-local script files with their declared language", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-script-file-"));
		try {
			await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
			await Bun.write(path.join(dir, "scripts", "score.py"), 'print("scored")\n');
			const definition = parseWorkflowDefinition(
				`
name: script-file-workflow
version: 1
nodes:
  score:
    type: script
    script:
      language: py
      file: ./scripts/score.py
edges: []
`,
				{ sourcePath: path.join(dir, "workflow.yml") },
			);
			const host = createHost();
			let capturedInput: WorkflowScriptNodeInput | undefined;
			const runtimeHost: WorkflowNodeRuntimeHost = {
				runScriptNode: async input => {
					capturedInput = input;
					return {
						summary: "scored",
						data: { exitCode: 0 },
					};
				},
			};

			await runWorkflow({
				host,
				definition,
				runId: "run-script-file",
				startNodeId: "score",
				runtimeHost,
				packageRoot: dir,
			});

			expect(capturedInput?.script).toBe('print("scored")\n');
			expect(capturedInput?.scriptLanguage).toBe("py");
			expect(capturedInput?.scriptPath).toBe("./scripts/score.py");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
