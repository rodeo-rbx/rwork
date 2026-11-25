import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	defaultBuildName,
	defaultPlace,
	localTomlIgnored,
	lookupPlace,
	mergeToml,
	parseRworkConfig,
	syncSettings,
} from "./config";

// rwork.local.toml is one developer's own settings, git-ignored and merged over rwork.toml.
// Command-line flags win, then environment variables, then rwork.local.toml, then rwork.toml.

const SHARED = `
default_build = "dev"

[places.dev]
id = 111

[build.dev]
project = "default.project.json"
src = "src"

[build.dev.globals]
__BUILD__ = "dev"
__DEBUG__ = false

[build.prod]
project = "default.project.json"
src = "src"

[sync]
include_assets = false
`;

const ENV = ["RWORK_PLACE_ID", "RWORK_SYNC_PORT", "RWORK_INCLUDE_ASSETS_WHEN_SYNCING", "RWORK_INCLUDE_SERVER_STORAGE_WHEN_SYNCING", "RWORK_INCLUDE_WORKSPACE_WHEN_SYNCING"];
let originalCwd: string;
let savedEnv: Record<string, string | undefined>;
let dir: string;
let output: string;

beforeEach(() => {
	originalCwd = process.cwd();
	savedEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
	for (const name of ENV) delete process.env[name];
	dir = mkdtempSync(join(tmpdir(), "rwork-config-"));
	process.chdir(dir);
	writeFileSync("rwork.toml", SHARED);
	output = "";
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		output += String(chunk);
		return true;
	});
});

afterEach(() => {
	(process.stdout.write as unknown as { mockRestore: () => void }).mockRestore();
	process.chdir(originalCwd);
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

test("tables merge key by key and anything else replaces", () => {
	expect(
		mergeToml(
			{ build: { dev: { project: "a", globals: { X: 1, Y: 2 } } }, list: [1, 2], keep: true },
			{ build: { dev: { globals: { Y: 3 } }, mine: { project: "b" } }, list: [9] },
		),
	).toEqual({ build: { dev: { project: "a", globals: { X: 1, Y: 3 } }, mine: { project: "b" } }, list: [9], keep: true });
});

test("without rwork.local.toml, rwork.toml is read as before", () => {
	expect(parseRworkConfig("dev").globals).toEqual({ __BUILD__: "dev", __DEBUG__: false });
	expect(defaultBuildName()).toBe("dev");
	expect(defaultPlace()).toBeUndefined();
	expect(syncSettings()).toEqual({ includeAssets: false, includeServerStorage: true, includeWorkspace: false, port: undefined });
});

test("rwork.local.toml adds places and builds, overrides globals, and the summary says which came from it", () => {
	writeFileSync(
		"rwork.local.toml",
		`
default_build = "prod"
default_place = "mine"

[places.mine]
id = 222
build = "dev"

[build.dev.globals]
__DEBUG__ = true
`,
	);
	expect(defaultBuildName()).toBe("prod");
	expect(defaultPlace()).toBe("mine");
	expect(lookupPlace("mine")).toEqual({ name: "mine", id: "222", build: "dev" });
	expect(lookupPlace("dev")).toEqual({ name: "dev", id: "111", build: undefined });

	output = "";
	const build = parseRworkConfig("dev", { globals: { __BUILD__: "custom" } });
	expect(build.globals).toEqual({ __BUILD__: "custom", __DEBUG__: true });
	expect(output).toContain("__DEBUG__ = true (rwork.local.toml)");
	expect(output).toContain("__BUILD__ = custom (-G)");
	expect(output).not.toContain("project: default.project.json (rwork.local.toml)");
});

test("sync settings: an environment variable, else rwork.local.toml, else rwork.toml, else the default", () => {
	writeFileSync("rwork.local.toml", `[sync]\nport = 34900\ninclude_server_storage = false\ninclude_workspace = true\n`);
	expect(syncSettings()).toEqual({ includeAssets: false, includeServerStorage: false, includeWorkspace: true, port: "34900" });

	process.env.RWORK_SYNC_PORT = "35000";
	process.env.RWORK_INCLUDE_ASSETS_WHEN_SYNCING = "true";
	process.env.RWORK_INCLUDE_SERVER_STORAGE_WHEN_SYNCING = "yes";
	process.env.RWORK_INCLUDE_WORKSPACE_WHEN_SYNCING = "false";
	expect(syncSettings()).toEqual({ includeAssets: true, includeServerStorage: true, includeWorkspace: false, port: "35000" });
});

test("git says whether rwork.local.toml is ignored, and there is no answer outside a repo", () => {
	writeFileSync("rwork.local.toml", "");
	expect(localTomlIgnored()).toBeUndefined();
	Bun.spawnSync(["git", "init", "-q"]);
	expect(localTomlIgnored()).toBe(false);
	writeFileSync(".gitignore", "rwork.local.toml\n");
	expect(localTomlIgnored()).toBe(true);
});
