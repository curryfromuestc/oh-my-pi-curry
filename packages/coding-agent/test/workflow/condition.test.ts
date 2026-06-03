import { describe, expect, it } from "bun:test";
import { evaluateWorkflowCondition, WorkflowConditionError } from "../../src/workflow/condition";

describe("workflow condition DSL", () => {
	it("evaluates comparisons against state and activation outputs", () => {
		const context = {
			state: {
				verdict: "continue",
				score: 0.82,
				approved: true,
			},
			outputs: {
				review: {
					verdict: "continue",
				},
			},
		};

		expect(evaluateWorkflowCondition('state.verdict == "continue"', context)).toBe(true);
		expect(evaluateWorkflowCondition("state.score >= 0.8", context)).toBe(true);
		expect(evaluateWorkflowCondition("state.approved == true", context)).toBe(true);
		expect(evaluateWorkflowCondition('outputs.review.verdict != "finish"', context)).toBe(true);
	});

	it("evaluates boolean operators without executing JavaScript", () => {
		const context = {
			state: {
				verdict: "continue",
				score: 0.82,
				approved: true,
			},
			outputs: {
				review: {
					verdict: "continue",
				},
			},
		};

		expect(evaluateWorkflowCondition('state.score >= 0.8 && state.verdict == "continue"', context)).toBe(true);
		expect(
			evaluateWorkflowCondition('state.verdict == "finish" || outputs.review.verdict == "continue"', context),
		).toBe(true);
		expect(evaluateWorkflowCondition('!(state.verdict == "finish")', context)).toBe(true);
	});

	it("evaluates existence checks for state and output paths", () => {
		const context = {
			state: {
				round: 2,
			},
			outputs: {
				review: {
					verdict: "continue",
				},
			},
		};

		expect(evaluateWorkflowCondition("exists(state.round)", context)).toBe(true);
		expect(evaluateWorkflowCondition("exists(outputs.review.verdict)", context)).toBe(true);
		expect(evaluateWorkflowCondition("exists(state.missing)", context)).toBe(false);
		expect(evaluateWorkflowCondition("!exists(outputs.review.missing)", context)).toBe(true);
	});

	it("evaluates paths with kebab-case workflow ids", () => {
		const context = {
			state: {
				"review-phase": {
					status: "active",
				},
			},
			outputs: {
				"supervisor-policy": {
					route: "surface-audit",
				},
			},
		};

		expect(evaluateWorkflowCondition('outputs.supervisor-policy.route == "surface-audit"', context)).toBe(true);
		expect(evaluateWorkflowCondition("exists(state.review-phase.status)", context)).toBe(true);
	});

	it("rejects arbitrary function calls", () => {
		expect(() => evaluateWorkflowCondition('readFile("/tmp/secret") == true', {})).toThrow(WorkflowConditionError);
		expect(() => evaluateWorkflowCondition('readFile("/tmp/secret") == true', {})).toThrow(
			'arbitrary function calls are not allowed in workflow conditions: "readFile"',
		);
	});
});
