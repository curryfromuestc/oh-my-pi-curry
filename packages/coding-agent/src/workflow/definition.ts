import { YAML } from "bun";
import { parseWorkflowCondition, WorkflowConditionError } from "./condition";

export type WorkflowNodeType = "agent" | "script" | "human" | "review";
export type WorkflowModelUnavailablePolicy = "fallback-to-parent" | "fail";
export type WorkflowScriptLanguage = "js" | "py";

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

export type WorkflowPromptActivationSelector = "parent" | "latest-completed";

export type WorkflowPromptSource =
	| WorkflowInlinePromptSource
	| WorkflowFilePromptSource
	| WorkflowStatePromptSource
	| WorkflowOutputPromptSource
	| WorkflowHumanPromptSource;

export interface WorkflowInlinePromptSource {
	kind: "inline";
	text: string;
}

export interface WorkflowFilePromptSource {
	kind: "file";
	path: string;
}

export interface WorkflowStatePromptSource {
	kind: "state";
	path: string;
}

export interface WorkflowOutputPromptSource {
	kind: "output";
	node: string;
	path: string;
	activation: WorkflowPromptActivationSelector;
}

export interface WorkflowHumanPromptSource {
	kind: "human";
	path: string;
}

export interface WorkflowScriptSource {
	language?: WorkflowScriptLanguage;
	code?: string;
	file?: string;
}

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	agent?: string;
	model?: WorkflowModelContext;
	prompt?: string;
	promptSource?: WorkflowPromptSource;
	script?: WorkflowScriptSource;
	gates?: string[];
	reads?: string[];
	writes?: string[];
	waitFor?: string[];
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
	validatePromptSourceReferences(nodes, options.sourcePath);
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
		const prompt = parsePromptSource(node.prompt, `${path}.prompt`, sourcePath);
		const script = parseScriptSource(node.script, `${path}.script`, sourcePath);
		const gates = parseOptionalStringList(node.gates, `${path}.gates`, sourcePath);
		const reads = parseOptionalStringList(node.reads, `${path}.reads`, sourcePath);
		const writes = parseOptionalStringList(node.writes, `${path}.writes`, sourcePath);
		const waitFor = parseOptionalStringList(node.waitFor, `${path}.waitFor`, sourcePath);
		return compactNode({ id, type, agent, model, ...prompt, script, gates, reads, writes, waitFor });
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

function validatePromptSourceReferences(nodes: WorkflowNode[], sourcePath?: string): void {
	const nodeIds = new Set(nodes.map(node => node.id));
	for (const node of nodes) {
		const source = node.promptSource;
		if (source?.kind === "output" && !nodeIds.has(source.node)) {
			throw new WorkflowDefinitionError(
				`node "${node.id}" prompt references unknown output node "${source.node}"`,
				sourcePath,
			);
		}
	}
}

function parsePromptSource(
	value: unknown,
	path: string,
	sourcePath?: string,
): { prompt?: string; promptSource?: WorkflowPromptSource } {
	if (value === undefined) return {};
	if (typeof value === "string") {
		const prompt = expectString(value, path, sourcePath);
		return {
			prompt,
			promptSource: prompt.startsWith("./") ? { kind: "file", path: prompt } : { kind: "inline", text: prompt },
		};
	}
	const raw = expectRecord(value, path, sourcePath);
	const sourceKeys = ["inline", "file", "state", "output", "human"].filter(key => raw[key] !== undefined);
	if (sourceKeys.length !== 1) {
		throw new WorkflowDefinitionError(
			`${path} must define exactly one of inline, file, state, output, or human`,
			sourcePath,
		);
	}
	const sourceKey = sourceKeys[0];
	if (sourceKey === "inline") {
		const text = expectString(raw.inline, `${path}.inline`, sourcePath);
		return { prompt: text, promptSource: { kind: "inline", text } };
	}
	if (sourceKey === "file") {
		const filePath = expectString(raw.file, `${path}.file`, sourcePath);
		return { prompt: filePath, promptSource: { kind: "file", path: filePath } };
	}
	if (sourceKey === "state") {
		const statePath = expectJsonPointer(raw.state, `${path}.state`, sourcePath);
		return { promptSource: { kind: "state", path: statePath } };
	}
	if (sourceKey === "human") {
		const humanPath = expectJsonPointer(raw.human, `${path}.human`, sourcePath);
		return { promptSource: { kind: "human", path: humanPath } };
	}
	const output = expectRecord(raw.output, `${path}.output`, sourcePath);
	const node = expectString(output.node, `${path}.output.node`, sourcePath);
	const outputPath = expectJsonPointer(output.path, `${path}.output.path`, sourcePath);
	const activation = parsePromptActivationSelector(output.activation, `${path}.output.activation`, sourcePath);
	return { promptSource: { kind: "output", node, path: outputPath, activation } };
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

function parseScriptSource(value: unknown, path: string, sourcePath?: string): WorkflowScriptSource | undefined {
	if (value === undefined) return undefined;
	const raw = expectRecord(value, path, sourcePath);
	const language = parseScriptLanguage(raw.language, `${path}.language`, sourcePath);
	const code = parseOptionalString(raw.inline, `${path}.inline`, sourcePath);
	const file = parseOptionalString(raw.file, `${path}.file`, sourcePath);
	const sourceCount = [code, file].filter(entry => entry !== undefined).length;
	if (sourceCount !== 1) {
		throw new WorkflowDefinitionError(`${path} must define exactly one of inline or file`, sourcePath);
	}
	if (file !== undefined && !file.startsWith("./")) {
		throw new WorkflowDefinitionError(`${path}.file must be package-relative`, sourcePath);
	}
	const script: WorkflowScriptSource = {};
	if (language !== undefined) script.language = language;
	if (code !== undefined) script.code = code;
	if (file !== undefined) script.file = file;
	return script;
}

function parseScriptLanguage(value: unknown, path: string, sourcePath?: string): WorkflowScriptLanguage | undefined {
	if (value === undefined) return undefined;
	if (value === "js" || value === "py") return value;
	throw new WorkflowDefinitionError(`${path} must be js or py`, sourcePath);
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

function parsePromptActivationSelector(
	value: unknown,
	path: string,
	sourcePath?: string,
): WorkflowPromptActivationSelector {
	if (value === "parent" || value === "latest-completed") return value;
	throw new WorkflowDefinitionError(`${path} must be parent or latest-completed`, sourcePath);
}

function compactNode(node: WorkflowNode): WorkflowNode {
	const result: WorkflowNode = { id: node.id, type: node.type };
	if (node.agent !== undefined) result.agent = node.agent;
	if (node.model !== undefined) result.model = node.model;
	if (node.prompt !== undefined) result.prompt = node.prompt;
	if (node.promptSource !== undefined) result.promptSource = node.promptSource;
	if (node.script !== undefined) result.script = node.script;
	if (node.gates !== undefined) result.gates = node.gates;
	if (node.reads !== undefined) result.reads = node.reads;
	if (node.writes !== undefined) result.writes = node.writes;
	if (node.waitFor !== undefined) result.waitFor = node.waitFor;
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

function expectJsonPointer(value: unknown, path: string, sourcePath?: string): string {
	const pointer = expectString(value, path, sourcePath);
	if (pointer.startsWith("/")) return pointer;
	throw new WorkflowDefinitionError(`${path} must be a JSON pointer`, sourcePath);
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
