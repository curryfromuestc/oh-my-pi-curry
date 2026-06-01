import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition } from "../../src/workflow/definition";
import { runWorkflowScheduler } from "../../src/workflow/scheduler";

const linearWorkflow = `
name: linear-demo
version: 1
nodes:
  start:
    type: script
  review:
    type: review
edges:
  - from: start
    to: review
`;

const conditionalWorkflow = `
name: conditional-demo
version: 1
nodes:
  review:
    type: review
    writes:
      - /verdict
  build:
    type: agent
  finish:
    type: script
edges:
  - from: review
    to: build
    when: state.verdict == "continue"
  - from: review
    to: finish
    when: state.verdict == "finish"
`;

const outputConditionalWorkflow = `
name: output-conditional-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
  finish:
    type: script
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: outputs.review.verdict == "continue"
  - from: review
    to: finish
    when: outputs.review.verdict == "finish"
`;

const loopWorkflow = `
name: loop-demo
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
  - from: review
    to: build
`;

const joinWorkflow = `
name: join-demo
version: 1
nodes:
  start:
    type: script
  left:
    type: script
  right:
    type: script
  join:
    type: script
    waitFor:
      - left
      - right
edges:
  - from: start
    to: left
  - from: start
    to: right
  - from: left
    to: join
  - from: right
    to: join
`;

describe("workflow activation scheduler", () => {
	it("runs a linear graph in edge order", async () => {
		const definition = parseWorkflowDefinition(linearWorkflow, { sourcePath: "workflow.yml" });
		const executed: string[] = [];

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => {
				executed.push(activation.nodeId);
				return { summary: `ran ${activation.nodeId}` };
			},
		});

		expect(executed).toEqual(["start", "review"]);
		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["start", "completed"],
			["review", "completed"],
		]);
		expect(result.activations[1]?.parentActivationIds).toEqual([result.activations[0]?.id]);
	});

	it("follows only true conditional edges", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			initialState: { verdict: "continue" },
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["review", "build"]);
	});

	it("applies activation state patches before evaluating outgoing edges", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			executeNode: async activation => ({
				summary: `ran ${activation.nodeId}`,
				statePatch:
					activation.nodeId === "review" ? [{ op: "set", path: "/verdict", value: "continue" }] : undefined,
			}),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["review", "build"]);
		expect(result.state).toEqual({ verdict: "continue" });
	});

	it("evaluates outgoing edge conditions against the latest structured node outputs", async () => {
		const definition = parseWorkflowDefinition(outputConditionalWorkflow, { sourcePath: "workflow.yml" });
		let reviewCount = 0;

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			executeNode: async activation => {
				if (activation.nodeId !== "review") {
					return { summary: `ran ${activation.nodeId}` };
				}
				reviewCount += 1;
				return {
					summary: `review ${reviewCount}`,
					data: { verdict: reviewCount === 1 ? "continue" : "finish" },
				};
			},
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual([
			"build",
			"review",
			"build",
			"review",
			"finish",
		]);
		expect(result.activations.findLast(activation => activation.nodeId === "review")?.output?.data).toEqual({
			verdict: "finish",
		});
	});

	it("fails activations that write outside declared state scopes", async () => {
		const definition = parseWorkflowDefinition(conditionalWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "review",
			executeNode: async () => ({
				summary: "attempted private write",
				statePatch: [{ op: "set", path: "/private/token", value: "secret" }],
			}),
		});

		expect(result.activations.map(activation => [activation.nodeId, activation.status])).toEqual([
			["review", "failed"],
		]);
		expect(result.activations[0]?.error).toBe('workflow state write to "/private/token" is not allowed');
		expect(result.state).toEqual({});
	});

	it("creates separate activations for loops and stops at the activation limit", async () => {
		const definition = parseWorkflowDefinition(loopWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			maxActivations: 3,
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["build", "review", "build"]);
		expect(new Set(result.activations.map(activation => activation.id)).size).toBe(3);
		expect(result.limitReached).toBe(true);
	});

	it("stops before exceeding the per-node activation limit", async () => {
		const definition = parseWorkflowDefinition(loopWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "build",
			maxActivations: 5,
			maxNodeActivations: 1,
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["build", "review"]);
		expect(result.limitReached).toBe(true);
	});

	it("activates explicit joins after all declared parents complete", async () => {
		const definition = parseWorkflowDefinition(joinWorkflow, { sourcePath: "workflow.yml" });

		const result = await runWorkflowScheduler(definition, {
			startNodeId: "start",
			executeNode: async activation => ({ summary: `ran ${activation.nodeId}` }),
		});

		expect(result.activations.map(activation => activation.nodeId)).toEqual(["start", "left", "right", "join"]);
		const join = result.activations.find(activation => activation.nodeId === "join");
		const left = result.activations.find(activation => activation.nodeId === "left");
		const right = result.activations.find(activation => activation.nodeId === "right");
		if (!join || !left || !right) {
			throw new Error("expected join, left, and right activations");
		}
		expect(join.parentActivationIds).toEqual([left.id, right.id]);
	});
});
