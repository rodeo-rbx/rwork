import { Command } from "commander";
import { defaultBuildName, defaultPlace, lookupPlace, parseRworkConfig } from "./config";
import { build } from "./commands/build";
import { sync } from "./commands/sync";
import { dev } from "./commands/dev";
import { publish } from "./commands/publish";
import { log } from "./log";

const pkg = require("../package.json") as { version: string };

interface BuildOpts {
	build: string;
	project?: string;
	src?: string;
	darklua?: string;
	global: Record<string, string>;
}

// Collect repeatable `-G KEY=VALUE` into a record.
function collectGlobal(pair: string, acc: Record<string, string> = {}) {
	const eq = pair.indexOf("=");
	if (eq > 0) {
		acc[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return acc;
}

interface PlaceTarget {
	id: string;
	// Set when the target is a named [places.*] entry with a bound build.
	build?: string;
}

// Uniform --place resolution, identical for every command that takes it:
// a [places.*] key from rwork.toml (or rwork.local.toml) resolves to that
// entry; anything else is a raw place id. The flag falls back to
// RWORK_PLACE_ID, then default_place (a dev's personal scratch place, best in
// rwork.local.toml), through the same rule.
function resolveTarget(place?: string): PlaceTarget | undefined {
	const arg = place ?? process.env.RWORK_PLACE_ID ?? defaultPlace();
	if (!arg) return undefined;
	return lookupPlace(arg) ?? { id: arg };
}

// The build a command runs with: an explicit --build wins but must agree
// with the target place's bound build; otherwise the binding is the
// default, then default_build (rwork.local.toml over rwork.toml), then "dev".
function resolveBuildName(opts: BuildOpts, cmd: Command, target?: PlaceTarget): string {
	const explicit =
		cmd.getOptionValueSource("build") === "cli" ? opts.build : undefined;

	if (target?.build && explicit && explicit !== target.build) {
		log.error(
			`--build ${explicit} conflicts with the target place's bound build "${target.build}" (rwork.toml [places])`,
		);
		process.exit(1);
	}
	return explicit ?? target?.build ?? defaultBuildName() ?? opts.build;
}

// Resolve the shared build-selection options into an RworkBuild.
function resolveBuild(opts: BuildOpts, cmd: Command, target?: PlaceTarget) {
	return parseRworkConfig(resolveBuildName(opts, cmd, target), {
		project: opts.project,
		src: opts.src,
		darklua: opts.darklua,
		globals: opts.global && Object.keys(opts.global).length > 0 ? opts.global : undefined,
	});
}

const program = new Command();
program
	.name("rwork")
	.description("A CLI for fully managed Rojo workflows")
	.version(pkg.version, "-v, --version")
	.showHelpAfterError();

// Options shared by every command — they select/override the build.
function withBuildOptions(cmd: Command) {
	return cmd
		.option("--build <name>", "a [build.*] entry from rwork.toml", "dev")
		.option("--project <path>", "override the build's Rojo project")
		.option("--src <path>", "override the build's source dir")
		.option("--darklua <path>", "override the build's darklua config")
		.option("-G, --global <key=value>", "override a build global (repeatable)", collectGlobal);
}

withBuildOptions(program.command("build"))
	.description("Compile + build a place file into .rwork/<build>/build.rbxl")
	.option("-o, --open", "open the built place in Studio")
	.action(async (opts, cmd) => {
		await build(resolveBuild(opts, cmd), { open: opts.open });
	});

withBuildOptions(program.command("sync"))
	.description("Live-sync source into an open Studio (rojo serve + watchers)")
	.action(async (opts, cmd) => {
		await sync(resolveBuild(opts, cmd));
	});

withBuildOptions(program.command("dev"))
	.description("Build + open + sync (local loop); --place for live mode")
	.option(
		"--place <id|name>",
		"live place: a [places.*] name or raw id (or RWORK_PLACE_ID) — enables live mode",
	)
	.option(
		"--upload",
		"live mode: push a fresh build to the place before opening (default: open the published place and live-sync, no upload)",
	)
	.action(async (opts, cmd) => {
		const target = resolveTarget(opts.place);
		await dev(resolveBuild(opts, cmd, target), target?.id, { upload: opts.upload });
	});

withBuildOptions(program.command("publish"))
	.description("Build + upload the place to a live place")
	.option("--place <id|name>", "live place: a [places.*] name or raw id (or RWORK_PLACE_ID)")
	.option("-o, --open", "open the place in Studio after publishing")
	.action(async (opts, cmd) => {
		const target = resolveTarget(opts.place);
		if (!target) {
			log.error("publish requires a place: pass --place <id|name> or set RWORK_PLACE_ID");
			process.exit(1);
		}
		await publish(resolveBuild(opts, cmd, target), target.id, { open: opts.open });
	});

await program.parseAsync(Bun.argv);
