import { readFileSync, writeFileSync } from "fs";
import type { RworkBuild } from "./config";

interface DarkluaRule {
	rule: string;
	[key: string]: unknown;
}

interface DarkluaConfig {
	generator?: string;
	rules: (DarkluaRule | string)[];
}

const BASE_CONVERT_REQUIRE: DarkluaRule = {
	rule: "convert_require",
	current: { name: "luau", use_luau_configuration: true },
	target: {
		name: "roblox",
		indexing_style: "wait_for_child",
		rojo_sourcemap: "./sourcemap.json",
	},
};

function makeGlobalRules(
	globals: Record<string, string | boolean | number>,
): DarkluaRule[] {
	return Object.entries(globals).map(([identifier, value]) => ({
		rule: "inject_global_value",
		identifier,
		value,
	}));
}

/** Rewrite rojo_sourcemap in convert_require rules to point to the generated sourcemap */
function rewriteSourcemapPaths(rules: (DarkluaRule | string)[]) {
	for (const rule of rules) {
		if (
			typeof rule === "object" &&
			rule.rule === "convert_require" &&
			rule.target
		) {
			(rule.target as Record<string, unknown>).rojo_sourcemap =
				"./sourcemap.json";
		}
	}
}

export function prepareDarklua(build: RworkBuild, outputDir: string): string {
	const configPath = `${outputDir}/darklua.json`;

	let config: DarkluaConfig;

	if (build.darklua) {
		// Read user config, rewrite sourcemap paths, merge globals
		const userFile = readFileSync(build.darklua, "utf-8");
		config = JSON.parse(userFile);
		rewriteSourcemapPaths(config.rules ?? []);

		if (build.globals) {
			const globalRules = makeGlobalRules(build.globals);
			config.rules = [...(config.rules ?? []), ...globalRules];
		}
	} else {
		// Generate base config
		const rules: (DarkluaRule | string)[] = [
			structuredClone(BASE_CONVERT_REQUIRE),
		];

		if (build.globals) {
			rules.push(...makeGlobalRules(build.globals));
		}

		rules.push("compute_expression");

		config = { generator: "retain_lines", rules };
	}

	writeFileSync(configPath, JSON.stringify(config, null, "\t"));
	return configPath;
}
