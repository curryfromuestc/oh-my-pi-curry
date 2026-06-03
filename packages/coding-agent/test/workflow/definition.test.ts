import { describe, expect, it } from "bun:test";
import { parseWorkflowDefinition, WorkflowDefinitionError } from "../../src/workflow/definition";

const cyclicWorkflow = `
name: humanize-loop
version: 1
models:
  roles:
    builder: pi/task:medium
    reviewer: pi/slow:high
  defaults:
    agent: builder
    review: reviewer
nodes:
  build:
    type: agent
    agent: task
    model:
      role: builder
  review:
    type: review
    agent: reviewer
    model:
      role: reviewer
      unavailable: fail
edges:
  - from: build
    to: review
  - from: review
    to: build
    when: state.verdict == "continue"
`;

describe("workflow definition parsing", () => {
	it("parses a cyclic workflow and preserves model context", () => {
		const definition = parseWorkflowDefinition(cyclicWorkflow, { sourcePath: "workflow.yml" });

		expect(definition.name).toBe("humanize-loop");
		expect(definition.version).toBe(1);
		expect(definition.nodes.map(node => node.id)).toEqual(["build", "review"]);
		expect(definition.edges.map(edge => [edge.from, edge.to])).toEqual([
			["build", "review"],
			["review", "build"],
		]);
		expect(definition.edges[1]?.condition?.source).toBe('state.verdict == "continue"');
		expect(definition.models.roles).toEqual({
			builder: "pi/task:medium",
			reviewer: "pi/slow:high",
		});
		expect(definition.nodes[1]?.model).toEqual({ role: "reviewer", unavailable: "fail" });
	});

	it("rejects edges that reference unknown nodes", () => {
		const source = `
name: invalid-workflow
version: 1
nodes:
  build:
    type: agent
edges:
  - from: build
    to: missing
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "invalid.yml" })).toThrow(WorkflowDefinitionError);
		expect(() => parseWorkflowDefinition(source, { sourcePath: "invalid.yml" })).toThrow(
			'invalid.yml: edge references unknown target node "missing"',
		);
	});

	it("rejects malformed edge conditions before execution", () => {
		const source = `
name: invalid-condition
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
    when: state.verdict = "continue"
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "condition.yml" })).toThrow(
			'condition.yml: edges.0.when is not a valid workflow condition: unexpected token "="',
		);
	});

	it("accepts boolean edge conditions from the workflow DSL", () => {
		const source = `
name: boolean-condition
version: 1
nodes:
  build:
    type: agent
  review:
    type: review
edges:
  - from: build
    to: review
    when: state.score >= 0.8 && exists(outputs.review.verdict)
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "condition.yml" });

		expect(definition.edges[0]?.condition?.source).toBe("state.score >= 0.8 && exists(outputs.review.verdict)");
	});

	it("preserves node state read and write scopes", () => {
		const source = `
name: scoped-state
version: 1
nodes:
  review:
    type: review
    reads:
      - /draft
    writes:
      - /review
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "state.yml" });

		expect(definition.nodes[0]?.reads).toEqual(["/draft"]);
		expect(definition.nodes[0]?.writes).toEqual(["/review"]);
	});

	it("preserves explicit script language and package file selection", () => {
		const source = `
name: script-source
version: 1
nodes:
  score:
    type: script
    script:
      language: py
      file: ./scripts/score.py
edges: []
`;

		const definition = parseWorkflowDefinition(source, { sourcePath: "script.yml" });

		expect(definition.nodes[0]?.script).toEqual({
			language: "py",
			file: "./scripts/score.py",
		});
	});

	it("rejects unsupported script languages", () => {
		const source = `
name: invalid-script-language
version: 1
nodes:
  score:
    type: script
    script:
      language: rb
      inline: puts "no"
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "script.yml" })).toThrow(
			"script.yml: nodes.score.script.language must be js or py",
		);
	});

	it("rejects duplicate node ids in list-form definitions", () => {
		const source = `
name: duplicate-nodes
version: 1
nodes:
  - id: build
    type: agent
  - id: build
    type: review
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "duplicate.yml" })).toThrow(
			'duplicate.yml: duplicate node id "build"',
		);
	});

	it("rejects model contexts with multiple model sources", () => {
		const source = `
name: invalid-model
version: 1
nodes:
  build:
    type: agent
    model:
      role: builder
      selector: provider/model:high
edges: []
`;

		expect(() => parseWorkflowDefinition(source, { sourcePath: "model.yml" })).toThrow(
			"model.yml: nodes.build.model must define exactly one of role, selector, or candidates",
		);
	});
});
