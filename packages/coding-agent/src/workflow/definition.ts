import { YAML } from "bun";
import { parseWorkflowCondition, WorkflowConditionError } from "./condition";

export type WorkflowNodeType = "agent" | "script" | "human" | "review";
export type WorkflowModelUnavailablePolicy = "fallback-to-parent" | "fail";

export interface WorkflowModelContext {
	role?: string;
	selector?: string;
	candidates?: string[];
	unavailable?: WorkflowModelUnavailablePolicy;
}

export interface WorkflowModels {
	roles: Record<string, string>;
	defaults: Record<string, string>;
	unavailable?: WorkflowModelUnavailablePolicy;
}

export interface WorkflowCondition {
	source: string;
}

export interface WorkflowEdge {
	from: string;
	to: string;
	condition?: WorkflowCondition;
}

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	agent?: string;
	model?: WorkflowModelContext;
	prompt?: string;
	gates?: string[];
	writes?: string[];
}

export interface WorkflowDefinition {
	name: string;
	version: number;
	sourcePath?: string;
	models: WorkflowModels;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

export interface ParseWorkflowDefinitionOptions {
	sourcePath?: string;
}

export class WorkflowDefinitionError extends Error {
	constructor(
		message: string,
		readonly sourcePath?: string,
	) {
		super(sourcePath ? `${sourcePath}: ${message}` : message);
		this.name = "WorkflowDefinitionError";
	}
}

export function parseWorkflowDefinition(
	source: string,
	options: ParseWorkflowDefinitionOptions = {},
): WorkflowDefinition {
	const raw = parseYaml(source, options.sourcePath);
	const root = expectRecord(raw, "workflow definition", options.sourcePath);
	const name = expectString(root.name, "name", options.sourcePath);
	const version = expectNumber(root.version, "version", options.sourcePath);
	const models = parseModels(root.models, options.sourcePath);
	const nodes = parseNodes(root.nodes, options.sourcePath);
	const edges = parseEdges(root.edges, options.sourcePath);
	validateEdgeReferences(nodes, edges, options.sourcePath);
	return { name, version, sourcePath: options.sourcePath, models, nodes, edges };
}

function parseYaml(source: string, sourcePath?: string): unknown {
	try {
		return YAML.parse(source);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkflowDefinitionError(`failed to parse YAML: ${message}`, sourcePath);
	}
}

function parseModels(value: unknown, sourcePath?: string): WorkflowModels {
	if (value === undefined) {
		return { roles: {}, defaults: {} };
	}
	const raw = expectRecord(value, "models", sourcePath);
	const roles = parseStringRecord(raw.roles, "models.roles", sourcePath);
	const defaults = parseStringRecord(raw.defaults, "models.defaults", sourcePath);
	const unavailable = parseUnavailable(raw.unavailable, "models.unavailable", sourcePath);
	return unavailable ? { roles, defaults, unavailable } : { roles, defaults };
}

function parseNodes(value: unknown, sourcePath?: string): WorkflowNode[] {
	const entries = parseNodeEntries(value, sourcePath);
	const seen = new Set<string>();
	return entries.map(({ id, rawNode, path }) => {
		if (seen.has(id)) {
			throw new WorkflowDefinitionError(`duplicate node id "${id}"`, sourcePath);
		}
		seen.add(id);
		const node = expectRecord(rawNode, path, sourcePath);
		const type = parseNodeType(node.type, `${path}.type`, sourcePath);
		const agent = parseOptionalString(node.agent, `${path}.agent`, sourcePath);
		const model = parseModelContext(node.model, `${path}.model`, sourcePath);
		const prompt = parseOptionalString(node.prompt, `${path}.prompt`, sourcePath);
		const gates = parseOptionalStringList(node.gates, `${path}.gates`, sourcePath);
		const writes = parseOptionalStringList(node.writes, `${path}.writes`, sourcePath);
		return compactNode({ id, type, agent, model, prompt, gates, writes });
	});
}

function parseNodeEntries(value: unknown, sourcePath?: string): Array<{ id: string; rawNode: unknown; path: string }> {
	if (Array.isArray(value)) {
		return value.map((rawNode, index) => {
			const path = `nodes.${index}`;
			const node = expectRecord(rawNode, path, sourcePath);
			return {
				id: expectString(node.id, `${path}.id`, sourcePath),
				rawNode,
				path,
			};
		});
	}
	const rawNodes = expectRecord(value, "nodes", sourcePath);
	return Object.entries(rawNodes).map(([id, rawNode]) => ({ id, rawNode, path: `nodes.${id}` }));
}

function parseEdges(value: unknown, sourcePath?: string): WorkflowEdge[] {
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError("edges must be an array", sourcePath);
	}
	return value.map((rawEdge, index) => {
		const edge = expectRecord(rawEdge, `edges.${index}`, sourcePath);
		const from = expectString(edge.from, `edges.${index}.from`, sourcePath);
		const to = expectString(edge.to, `edges.${index}.to`, sourcePath);
		const when = parseOptionalString(edge.when, `edges.${index}.when`, sourcePath);
		return when
			? { from, to, condition: parseConditionSource(when, `edges.${index}.when`, sourcePath) }
			: { from, to };
	});
}

function parseConditionSource(source: string, path: string, sourcePath?: string): WorkflowCondition {
	const trimmed = source.trim();
	try {
		parseWorkflowCondition(trimmed);
	} catch (error) {
		if (error instanceof WorkflowConditionError) {
			throw new WorkflowDefinitionError(`${path} is not a valid workflow condition: ${error.message}`, sourcePath);
		}
		throw error;
	}
	return { source: trimmed };
}

function validateEdgeReferences(nodes: WorkflowNode[], edges: WorkflowEdge[], sourcePath?: string): void {
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const edge of edges) {
		if (!nodeIds.has(edge.from)) {
			throw new WorkflowDefinitionError(`edge references unknown source node "${edge.from}"`, sourcePath);
		}
		if (!nodeIds.has(edge.to)) {
			throw new WorkflowDefinitionError(`edge references unknown target node "${edge.to}"`, sourcePath);
		}
	}
}

function parseModelContext(value: unknown, path: string, sourcePath?: string): WorkflowModelContext | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return { selector: value };
	const raw = expectRecord(value, path, sourcePath);
	const role = parseOptionalString(raw.role, `${path}.role`, sourcePath);
	const selector = parseOptionalString(raw.selector, `${path}.selector`, sourcePath);
	const candidates = parseOptionalStringList(raw.candidates, `${path}.candidates`, sourcePath);
	const unavailable = parseUnavailable(raw.unavailable, `${path}.unavailable`, sourcePath);
	const sourceCount = [role, selector, candidates].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new WorkflowDefinitionError(`${path} must define exactly one of role, selector, or candidates`, sourcePath);
	}
	const context: WorkflowModelContext = {};
	if (role !== undefined) context.role = role;
	if (selector !== undefined) context.selector = selector;
	if (candidates !== undefined) context.candidates = candidates;
	if (unavailable !== undefined) context.unavailable = unavailable;
	return Object.keys(context).length > 0 ? context : undefined;
}

function parseUnavailable(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowModelUnavailablePolicy | undefined {
	if (value === undefined) return undefined;
	if (value === "fallback-to-parent" || value === "fail") return value;
	throw new WorkflowDefinitionError(`${path} must be "fallback-to-parent" or "fail"`, sourcePath);
}

function parseNodeType(value: unknown, path: string, sourcePath?: string): WorkflowNodeType {
	if (value === "agent" || value === "script" || value === "human" || value === "review") return value;
	throw new WorkflowDefinitionError(`${path} must be agent, script, human, or review`, sourcePath);
}

function compactNode(node: WorkflowNode): WorkflowNode {
	const result: WorkflowNode = { id: node.id, type: node.type };
	if (node.agent !== undefined) result.agent = node.agent;
	if (node.model !== undefined) result.model = node.model;
	if (node.prompt !== undefined) result.prompt = node.prompt;
	if (node.gates !== undefined) result.gates = node.gates;
	if (node.writes !== undefined) result.writes = node.writes;
	return result;
}

function parseStringRecord(value: unknown, path: string, sourcePath?: string): Record<string, string> {
	if (value === undefined) return {};
	const raw = expectRecord(value, path, sourcePath);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(raw)) {
		result[key] = expectString(entry, `${path}.${key}`, sourcePath);
	}
	return result;
}

function parseOptionalStringList(value: unknown, path: string, sourcePath?: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new WorkflowDefinitionError(`${path} must be an array of strings`, sourcePath);
	}
	return value.map((entry, index) => expectString(entry, `${path}.${index}`, sourcePath));
}

function parseOptionalString(value: unknown, path: string, sourcePath?: string): string | undefined {
	if (value === undefined) return undefined;
	return expectString(value, path, sourcePath);
}

function expectString(value: unknown, path: string, sourcePath?: string): string {
	if (typeof value === "string" && value.trim()) return value;
	throw new WorkflowDefinitionError(`${path} must be a non-empty string`, sourcePath);
}

function expectNumber(value: unknown, path: string, sourcePath?: string): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new WorkflowDefinitionError(`${path} must be a finite number`, sourcePath);
}

function expectRecord(value: unknown, path: string, sourcePath?: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new WorkflowDefinitionError(`${path} must be an object`, sourcePath);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
