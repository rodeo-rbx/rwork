import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";
import { buildDir, placeFile, syncDir } from "./paths";
import { prepareOut } from "./prepare";

// `rwork sync` stages a build once, and from then on rojo serve serves that directory and the
// watchers keep it current. A build or publish of the same build while that sync runs has to leave
// the directory alone: emptying its tree removes every synced script from Studio, and rewriting
// its project swaps what the sync serves for a build's project, Workspace and all.

const rworkBuild = { name: "dev", project: "default.project.json", src: "src" };
const SYNC_FLAGS = { includeWorkspace: false, includeServerStorage: true, includeAssets: true };

let originalCwd: string;
let originalPath: string | undefined;
let originalRevision: string | undefined;
let fixture: string;
let toolPath: string;
let rojoCalls: string;

/** Stand-ins for the two tools staging runs, so the tests need neither installed and publish
 *  nothing. rojo records how it was called and writes the file `-o` names; darklua copies src's
 *  .luau files into dest, where the real one writes its output. */
function fakeTools(bin: string) {
	mkdirSync(bin);
	writeFileSync(
		join(bin, "rojo"),
		`#!/bin/bash
echo "$PWD|$*" >> "${rojoCalls}"
while [ $# -gt 0 ]; do
	if [ "$1" = "-o" ]; then echo "{}" > "$2"; fi
	shift
done
`,
	);
	writeFileSync(
		join(bin, "darklua"),
		`#!/bin/bash
(cd "$2" && find . -name '*.luau') | while read -r file; do
	mkdir -p "$3/$(dirname "$file")"
	cp "$2/$file" "$3/$file"
done
echo "successfully processed files"
`,
	);
	chmodSync(join(bin, "rojo"), 0o755);
	chmodSync(join(bin, "darklua"), 0o755);
}

/** Runs the rwork CLI in the fixture. Its PATH holds the stand-ins and the system's tools and
 *  nothing else, so no real rojo is reachable; with no RWORK_API_KEY either, publish uploads
 *  through `rojo upload`, which is the stand-in. */
function rwork(...args: string[]) {
	const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
		cwd: fixture,
		env: { PATH: toolPath, RWORK_REVISION: "test@0000000" },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, output: `${proc.stdout}${proc.stderr}` };
}

const lastRojoCall = () => readFileSync(rojoCalls, "utf8").trim().split("\n").at(-1)!;

/** Every entry under the sync's stage except what a build is meant to add there (its own stage
 *  and the place file), as `kind inode mtime size`. */
function syncStage(): Record<string, string> {
	const root = syncDir(rworkBuild);
	const skip = new Set([resolve(buildDir(rworkBuild)), resolve(placeFile(rworkBuild))]);
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (skip.has(resolve(full))) continue;
			const stat = statSync(full);
			out[relative(root, full)] = `${entry.isDirectory() ? "dir" : "file"} ${stat.ino} ${stat.mtimeMs} ${stat.size}`;
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
	return out;
}

/** Dates everything the sync staged in the past, so that any later write shows: even one that
 *  puts the same bytes back, or lands within the clock tick the file was created in. */
function ageSyncStage() {
	const past = new Date("2001-01-01T00:00:00Z");
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			utimesSync(full, past, past);
		}
	};
	walk(syncDir(rworkBuild));
}

beforeEach(() => {
	originalCwd = process.cwd();
	originalPath = process.env.PATH;
	originalRevision = process.env.RWORK_REVISION;
	// realpath: rojo's stand-in reports $PWD, which has no symlinks in it.
	fixture = resolve(mkdtempSync(join(tmpdir(), "rwork-stage-test-")));
	process.chdir(fixture);
	fixture = process.cwd();

	rojoCalls = join(fixture, "rojo-calls");
	toolPath = `${join(fixture, "bin")}:/usr/bin:/bin`;
	fakeTools(join(fixture, "bin"));

	writeFileSync("rwork.toml", '[build.dev]\nproject = "default.project.json"\nsrc = "src"\n');
	writeFileSync(
		"default.project.json",
		JSON.stringify({
			name: "stage-test",
			tree: {
				$className: "DataModel",
				ReplicatedStorage: { $path: "src/ReplicatedStorage" },
				Workspace: { $path: "src/Workspace" },
			},
		}),
	);
	mkdirSync("src/ReplicatedStorage/shared", { recursive: true });
	mkdirSync("src/Workspace");
	writeFileSync("src/ReplicatedStorage/shared/module.luau", "return 1\n");
	writeFileSync("src/ReplicatedStorage/shared/data.txt", "data\n");
	writeFileSync("src/Workspace/Map.rbxm", "a map\n");

	// What `rwork sync` does when it starts, then what darklua --watch's first build leaves.
	// prepareOut finds rojo through a shell, which reads PATH from process.env.
	process.env.PATH = toolPath;
	process.env.RWORK_REVISION = "test@0000000";
	prepareOut(rworkBuild, SYNC_FLAGS, syncDir(rworkBuild));
	writeFileSync(join(syncDir(rworkBuild), "src/ReplicatedStorage/shared/module.luau"), "return 1\n");
	ageSyncStage();
});

afterEach(() => {
	process.chdir(originalCwd);
	process.env.PATH = originalPath;
	if (originalRevision === undefined) delete process.env.RWORK_REVISION;
	else process.env.RWORK_REVISION = originalRevision;
	rmSync(fixture, { recursive: true, force: true });
});

test.each([
	["build", ["build"]],
	["publish", ["publish", "--place", "1"]],
] as const)("%s leaves the stage a running sync serves untouched", (_, args) => {
	const served = syncStage();
	expect(Object.keys(served).sort()).toEqual([
		"darklua.json",
		"default.project.json",
		"sourcemap.json",
		"sourcemap.project.json",
		"src",
		"src/ReplicatedStorage",
		"src/ReplicatedStorage/shared",
		"src/ReplicatedStorage/shared/data.txt",
		"src/ReplicatedStorage/shared/module.luau",
		"src/Workspace",
		"src/Workspace/Map.rbxm",
	]);

	const { code, output } = rwork(...args);
	expect(output).not.toContain("Failed");
	expect(code).toBe(0);

	expect(syncStage()).toEqual(served);
	const servedProject = JSON.parse(readFileSync(join(syncDir(rworkBuild), "default.project.json"), "utf8"));
	expect(servedProject.tree.Workspace).toBeUndefined();

	// The command staged a project and a tree of its own, with what a place file needs.
	const stage = buildDir(rworkBuild);
	const staged = JSON.parse(readFileSync(join(stage, "default.project.json"), "utf8"));
	expect(staged.tree.Workspace).toEqual({ $path: "src/Workspace" });
	expect(readFileSync(join(stage, "src/ReplicatedStorage/shared/module.luau"), "utf8")).toBe("return 1\n");
	expect(readFileSync(join(stage, "src/ReplicatedStorage/shared/data.txt"), "utf8")).toBe("data\n");
	expect(statSync(join(stage, "src/Workspace/Map.rbxm")).ino).toBe(statSync("src/Workspace/Map.rbxm").ino);

	// rojo's last step, building or uploading, ran in that stage.
	expect(lastRojoCall().split("|")[0]).toBe(resolve(stage));
});

test("build writes the place file where it always has", () => {
	expect(rwork("build").code).toBe(0);

	expect(placeFile(rworkBuild)).toBe(join(".rwork", "dev", "build.rbxl"));
	expect(existsSync(placeFile(rworkBuild))).toBe(true);
	expect(lastRojoCall()).toBe(`${resolve(buildDir(rworkBuild))}|build -o ${resolve(placeFile(rworkBuild))}`);
});
