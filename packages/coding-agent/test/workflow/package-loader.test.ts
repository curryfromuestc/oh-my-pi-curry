import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadWorkflowPackage } from "../../src/workflow/package-loader";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-package-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("workflow package loader", () => {
	it("loads workflow.yml from a package directory", async () => {
		const dir = await createTempDir();
		const workflowPath = path.join(dir, "workflow.yml");
		await Bun.write(
			workflowPath,
			`
name: package-demo
version: 1
nodes:
  build:
    type: agent
edges: []
`,
		);

		const pkg = await loadWorkflowPackage(dir);

		expect(pkg.rootPath).toBe(dir);
		expect(pkg.workflowPath).toBe(workflowPath);
		expect(pkg.definition.name).toBe("package-demo");
		expect(pkg.definition.sourcePath).toBe(workflowPath);
	});

	it("loads a direct workflow YAML file path", async () => {
		const dir = await createTempDir();
		const workflowPath = path.join(dir, "custom.yml");
		await Bun.write(
			workflowPath,
			`
name: file-demo
version: 1
nodes:
  review:
    type: review
edges: []
`,
		);

		const pkg = await loadWorkflowPackage(workflowPath);

		expect(pkg.rootPath).toBe(dir);
		expect(pkg.workflowPath).toBe(workflowPath);
		expect(pkg.definition.nodes.map(node => node.id)).toEqual(["review"]);
	});
});
