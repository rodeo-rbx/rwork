import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareOut, writeProjects } from "./prepare";

let originalCwd: string;
let originalRevision: string | undefined;
let fixture: string;

beforeEach(() => {
	originalCwd = process.cwd();
	originalRevision = process.env.RWORK_REVISION;
	fixture = mkdtempSync(join(tmpdir(), "rwork-stamp-test-"));
	process.chdir(fixture);
	process.env.RWORK_REVISION = "feature@1234567-dirty";
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalRevision === undefined) delete process.env.RWORK_REVISION;
	else process.env.RWORK_REVISION = originalRevision;
	rmSync(fixture, { recursive: true, force: true });
});

test.each([
	["build/publish", true],
	["sync", false],
] as const)("%s stamps the shared output while preserving authored storage", (_, includeWorkspace) => {
	const project = {
		name: "stamp-test",
		tree: {
			$className: "DataModel",
			Workspace: { $className: "Workspace" },
			ServerStorage: { $className: "ServerStorage" },
			ReplicatedStorage: {
				$path: "storage",
				$ignoreUnknownInstances: false,
				$attributes: { Custom: 42, RWORK_REVISION: "old", RWORK_BUILD: "old" },
				Shared: { $className: "Folder" },
			},
		},
	};
	writeFileSync("default.project.json", JSON.stringify(project));
	prepareOut({ name: "preview", project: "default.project.json" }, {
		includeWorkspace,
		includeServerStorage: includeWorkspace,
		includeAssets: true,
	});

	const output = JSON.parse(readFileSync(".rwork/preview/default.project.json", "utf8"));
	expect(output.tree.ReplicatedStorage).toEqual({
		...project.tree.ReplicatedStorage,
		$path: join("..", "..", "storage"),
		$attributes: { Custom: 42, RWORK_REVISION: "feature@1234567-dirty", RWORK_BUILD: "preview" },
	});
	expect(output.tree.Workspace).toEqual(includeWorkspace ? project.tree.Workspace : undefined);
	expect(output.tree.ServerStorage).toEqual(includeWorkspace ? project.tree.ServerStorage : undefined);
	expect(JSON.parse(readFileSync("default.project.json", "utf8"))).toEqual(project);
});

test("a project without ReplicatedStorage gets a stamp without owning unknown children", () => {
	writeFileSync("default.project.json", JSON.stringify({
		name: "stamp-test",
		tree: { $className: "DataModel" },
	}));
	prepareOut({ name: "dev", project: "default.project.json" }, {
		includeWorkspace: false,
		includeServerStorage: false,
		includeAssets: false,
	});

	const output = JSON.parse(readFileSync(".rwork/dev/default.project.json", "utf8"));
	expect(output.tree).toEqual({
		$className: "DataModel",
		ReplicatedStorage: {
			$className: "ReplicatedStorage",
			$ignoreUnknownInstances: true,
			$attributes: { RWORK_BUILD: "dev", RWORK_REVISION: "feature@1234567-dirty" },
		},
	});
	expect(output.globIgnorePaths).toEqual(["**/*.rbxm", "**/*.rbxmx"]);
});

test("writeProjects rewrites the copies only when the project changed", () => {
	const build = { name: "watch", project: "default.project.json" };
	const flags = { includeWorkspace: false, includeServerStorage: false, includeAssets: true };
	const project = {
		name: "watch-test",
		tree: { $className: "DataModel", ReplicatedFirst: { $path: "old" } },
	};
	writeFileSync("default.project.json", JSON.stringify(project));
	prepareOut(build, flags);
	expect(writeProjects(build, flags)).toBe(false);

	project.tree.ReplicatedFirst = { first: { $path: "src/first" } } as never;
	writeFileSync("default.project.json", JSON.stringify(project));
	expect(writeProjects(build, flags)).toBe(true);
	const output = JSON.parse(readFileSync(".rwork/watch/default.project.json", "utf8"));
	expect(output.tree.ReplicatedFirst).toEqual({ first: { $path: join("..", "..", "src", "first") } });
});
