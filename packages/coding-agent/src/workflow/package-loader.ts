import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseWorkflowDefinition, type WorkflowDefinition } from "./definition";

export interface WorkflowPackage {
	rootPath: string;
	workflowPath: string;
	definition: WorkflowDefinition;
}

export class WorkflowPackageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkflowPackageError";
	}
}

export async function loadWorkflowPackage(inputPath: string): Promise<WorkflowPackage> {
	const stat = await statWorkflowPath(inputPath);
	const rootPath = stat.isDirectory() ? inputPath : path.dirname(inputPath);
	const workflowPath = stat.isDirectory() ? path.join(inputPath, "workflow.yml") : inputPath;
	const source = await readWorkflowSource(workflowPath);
	return {
		rootPath,
		workflowPath,
		definition: parseWorkflowDefinition(source, { sourcePath: workflowPath }),
	};
}

async function statWorkflowPath(inputPath: string) {
	try {
		return await fs.stat(inputPath);
	} catch (error) {
		throw new WorkflowPackageError(`workflow package path is not readable: ${formatError(error)}`);
	}
}

async function readWorkflowSource(workflowPath: string): Promise<string> {
	try {
		return await Bun.file(workflowPath).text();
	} catch (error) {
		throw new WorkflowPackageError(`workflow file is not readable: ${formatError(error)}`);
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
