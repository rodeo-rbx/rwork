import { relative, join } from "path";

/**
 * Where `sync` stages a build: the project `rojo serve` serves and the tree its watchers keep
 * current. While a sync runs, what it staged here is its own, and nothing else may rewrite it.
 */
export function syncDir(build: { name: string }): string {
	return `.rwork/${build.name}`;
}

/**
 * Where `build` and `publish` stage. Not syncDir: staging empties the staged tree before filling
 * it, and a build's project differs from a sync's (Workspace is in it). Done in syncDir under a
 * running sync, rojo serve passes both on to Studio: every synced script is removed, and
 * Workspace arrives as an addition the plugin can't make. The stage sits inside syncDir because
 * nothing a sync runs watches there: rojo serve watches the staged project and its $paths, and
 * darklua only its own config and sourcemap.
 */
export function buildDir(build: { name: string }): string {
	return join(syncDir(build), "build");
}

/** The place file `build` and `publish` produce. */
export function placeFile(build: { name: string }): string {
	return join(syncDir(build), "build.rbxl");
}

/**
 * Walk a project JSON tree and remap $path values for a new cwd.
 *
 * - Computes relative prefix from outputDir back to "." (e.g., "../../" for ".rwork/dev")
 * - If srcFolder is provided and a $path starts with it, skip (output dir has src/ locally)
 * - Otherwise, prepend the relative prefix so rojo resolves from outputDir
 *
 * globIgnorePaths get the same treatment: rojo matches them against paths
 * relative to the project file's folder, so a repo-root-relative glob silently
 * stops matching once the project is staged (issue #1). Entries starting with
 * `**` are left alone — `**` matches through `../` components, so they already
 * work from anywhere, and prefixing them would break matching for files staged
 * locally under srcFolder.
 */
export function mutatePaths(
	node: Record<string, unknown>,
	outputDir: string,
	srcFolder?: string,
): void {
	const prefix = relative(outputDir, ".");

	const globs = node.globIgnorePaths;
	if (Array.isArray(globs)) {
		node.globIgnorePaths = globs.map((glob) => {
			if (typeof glob !== "string") return glob;
			const firstComponent = glob.split("/")[0];
			if (srcFolder && firstComponent === srcFolder) return glob;
			if (firstComponent === "**") return glob;
			return join(prefix, glob);
		});
	}

	function walk(obj: Record<string, unknown>) {
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$path" && typeof value === "string") {
				const firstComponent = value.split("/")[0];
				if (srcFolder && firstComponent === srcFolder) continue;
				obj[key] = join(prefix, value);
			} else if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				walk(value as Record<string, unknown>);
			}
		}
	}

	walk(node);
}
