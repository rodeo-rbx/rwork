import { resolve } from "path";
import type { RworkBuild } from "../config";
import { buildDir, placeFile } from "../paths";
import { prepareOut, runDarkluaOnce } from "../prepare";
import { openStudio } from "../studio";
import { log } from "../log";

export async function build(rworkBuild: RworkBuild, options?: { open?: boolean }) {
	const startTime = performance.now();
	// Its own stage: a sync of this build may be running, serving syncDir.
	const stage = buildDir(rworkBuild);
	const place = placeFile(rworkBuild);

	log.info("Preparing out files...");
	prepareOut(rworkBuild, {
		includeWorkspace: true,
		includeServerStorage: true,
		includeAssets: true,
	}, stage);
	runDarkluaOnce(rworkBuild, stage);

	log.info("Building the place file...");
	const proc = Bun.spawnSync(["rojo", "build", "-o", resolve(place)], {
		cwd: stage,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (proc.exitCode !== 0) {
		log.error(`Failed to build the place file (code ${proc.exitCode})`);
		process.exit(1);
	}

	const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
	log.success(`Successfully built ${place} in ${elapsed}s`);

	if (options?.open) {
		await openStudio(place);
	}
}
