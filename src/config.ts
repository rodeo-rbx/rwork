import { parse as parseToml } from "smol-toml";
import { existsSync, readFileSync } from "fs";
import { log } from "./log";

/** A developer's own settings, git-ignored, merged over rwork.toml. */
export const LOCAL_TOML = "rwork.local.toml";

// Coerce a -G override value to bool/number/string so overrides match toml types.
function parseGlobalValue(raw: string): string | boolean | number {
	if (raw === "true") return true;
	if (raw === "false") return false;
	const num = Number(raw);
	if (!Number.isNaN(num)) return num;
	return raw;
}

export interface RworkBuild {
	name: string;
	project: string;
	// Absent = nothing to compile: no darklua, no watchers, no sourcemap; the
	// project's $paths are all served raw from the repo.
	src?: string;
	darklua?: string;
	globals?: Record<string, string | boolean | number>;
}

interface TomlBuild {
	project?: string;
	src?: string;
	darklua?: string;
	globals?: Record<string, string | boolean | number>;
}

interface TomlPlace {
	id?: number | string;
	build?: string;
}

interface TomlSync {
	port?: number | string;
	include_assets?: boolean;
	include_server_storage?: boolean;
}

interface RworkToml {
	/** The build when no --build is given and no target place binds one ("dev" if unset). */
	default_build?: string;
	/** The live place when no --place is given and RWORK_PLACE_ID is unset. */
	default_place?: number | string;
	build?: Record<string, TomlBuild>;
	places?: Record<string, TomlPlace>;
	sync?: TomlSync;
}

interface CliOverrides {
	project?: string;
	src?: string;
	darklua?: string;
	globals?: Record<string, string>;
}

function isTable(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** `over` merged into `base` table by table; any other value (arrays included) replaces. */
export function mergeToml(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const current = merged[key];
		merged[key] = isTable(current) && isTable(value) ? mergeToml(current, value) : value;
	}
	return merged;
}

// The warning is for people, once a run: every command reads the files more than once.
let warnedNotIgnored = false;

/** Whether git ignores rwork.local.toml here: undefined outside a git repo (or without git). */
export function localTomlIgnored(): boolean | undefined {
	try {
		const check = Bun.spawnSync(["git", "check-ignore", "-q", LOCAL_TOML], { stdio: ["ignore", "ignore", "ignore"] });
		return check.exitCode === 0 ? true : check.exitCode === 1 ? false : undefined;
	} catch {
		return undefined;
	}
}

/** A rwork.local.toml git would commit is a mistake waiting to happen (places, ports, globals
 *  of one developer landing on everyone): say so. */
function warnIfNotIgnored() {
	if (warnedNotIgnored) return;
	warnedNotIgnored = true;
	if (localTomlIgnored() === false) {
		log.warn(`${LOCAL_TOML} is not git-ignored: add it to .gitignore so it stays yours`);
	}
}

interface LoadedToml {
	/** rwork.toml with rwork.local.toml merged over it. */
	merged: RworkToml;
	/** rwork.local.toml alone, to say which settings came from it. */
	local?: RworkToml;
}

function loadToml(): LoadedToml {
	const shared = parseToml(readFileSync("rwork.toml", "utf-8")) as Record<string, unknown>;
	if (!existsSync(LOCAL_TOML)) return { merged: shared as RworkToml };
	const local = parseToml(readFileSync(LOCAL_TOML, "utf-8")) as Record<string, unknown>;
	warnIfNotIgnored();
	return { merged: mergeToml(shared, local) as RworkToml, local: local as RworkToml };
}

function readRworkToml(): RworkToml {
	return loadToml().merged;
}

/** An environment variable's yes/no: unset is undefined, anything but "false" is yes. */
function envFlag(name: string): boolean | undefined {
	const value = process.env[name];
	return value === undefined ? undefined : value !== "false";
}

export interface SyncSettings {
	includeAssets: boolean;
	includeServerStorage: boolean;
	/** Port for `rojo serve` during sync; the project's servePort, else rojo's default, when unset. */
	port?: string;
}

/** `rwork sync`'s settings: an environment variable, else [sync] in rwork.local.toml, else in
 *  rwork.toml, else the default. rwork expects rojo and rodeo as sibling tools on PATH. */
export function syncSettings(): SyncSettings {
	const sync = readRworkToml().sync ?? {};
	return {
		includeAssets: envFlag("RWORK_INCLUDE_ASSETS_WHEN_SYNCING") ?? sync.include_assets ?? true,
		includeServerStorage:
			envFlag("RWORK_INCLUDE_SERVER_STORAGE_WHEN_SYNCING") ?? sync.include_server_storage ?? true,
		port: process.env.RWORK_SYNC_PORT ?? (sync.port !== undefined ? String(sync.port) : undefined),
	};
}

/** default_build from rwork.local.toml, else rwork.toml. */
export function defaultBuildName(): string | undefined {
	return readRworkToml().default_build;
}

/** default_place from rwork.local.toml, else rwork.toml (a [places.*] name or a raw id). */
export function defaultPlace(): string | undefined {
	const place = readRworkToml().default_place;
	return place === undefined ? undefined : String(place);
}

export interface NamedPlace {
	name: string;
	id: string;
	// Build this place is bound to; becomes the default build when the place
	// is targeted, and an explicit contradicting --build is an error.
	build?: string;
}

// Look up a [places.<name>] entry from rwork.toml. Returns undefined when the
// name doesn't match, so callers can fall back to treating it as a raw id.
export function lookupPlace(name: string): NamedPlace | undefined {
	const { merged, local } = loadToml();
	const entry = merged.places?.[name];
	if (!entry) return undefined;

	if (entry.id === undefined) {
		log.error(`rwork.toml: places.${name}.id is required`);
		process.exit(1);
	}

	log.info(
		`[RworkPlace] ${name} → ${entry.id}${entry.build ? ` (build ${entry.build})` : ""}${local?.places?.[name] ? ` (${LOCAL_TOML})` : ""}`,
	);
	return { name, id: String(entry.id), build: entry.build };
}

export function parseRworkConfig(
	buildName: string,
	overrides?: CliOverrides,
): RworkBuild {
	const { merged: toml, local } = loadToml();

	if (!toml.build) {
		log.error("rwork.toml: missing [build] section");
		process.exit(1);
	}

	const entry = toml.build[buildName];
	if (!entry) {
		const available = Object.keys(toml.build).join(", ");
		log.error(
			`rwork.toml: no build "${buildName}" (available: ${available})`,
		);
		process.exit(1);
	}

	if (!entry.project) {
		log.error(`rwork.toml: build.${buildName}.project is required`);
		process.exit(1);
	}
	// Merge globals: toml base + CLI overrides
	let globals = entry.globals
		? { ...entry.globals }
		: undefined;

	if (overrides?.globals) {
		globals = globals ?? {};
		for (const [key, rawValue] of Object.entries(overrides.globals)) {
			globals[key] = parseGlobalValue(rawValue);
		}
	}

	const build: RworkBuild = {
		name: buildName,
		project: overrides?.project ?? entry.project,
		src: overrides?.src ?? entry.src,
		darklua: overrides?.darklua ?? entry.darklua,
		globals,
	};

	// Which settings rwork.local.toml (or a -G flag) set, so a personal override is never a surprise.
	const localEntry = local?.build?.[buildName];
	const origin = (field: "project" | "src" | "darklua") =>
		overrides?.[field] === undefined && localEntry?.[field] !== undefined ? ` (${LOCAL_TOML})` : "";
	const globalOrigin = (key: string) =>
		overrides?.globals?.[key] !== undefined ? " (-G)" : localEntry?.globals?.[key] !== undefined ? ` (${LOCAL_TOML})` : "";

	log.info(`[RworkBuild] ${build.name}${local?.default_build === buildName ? ` (default_build in ${LOCAL_TOML})` : ""}`);
	log.info(`  project: ${build.project}${origin("project")}`);
	log.info(`  src:     ${build.src ?? "(none — project paths served raw)"}${origin("src")}`);
	log.info(`  darklua: ${build.src ? (build.darklua ?? "(generated)") : "(skipped — no src)"}${build.src ? origin("darklua") : ""}`);
	if (build.globals) {
		log.info(`  globals:`);
		for (const [key, value] of Object.entries(build.globals)) {
			log.info(`    ${key} = ${String(value)}${globalOrigin(key)}`);
		}
	}

	return build;
}
