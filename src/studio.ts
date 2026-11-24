import { log } from "./log";

// Open a place file in Studio via rodeo (a sibling tool on PATH). rodeo
// launches Studio with the place, runs a no-op, and --detach leaves Studio
// running after rodeo exits — so the opened place is also a rodeo-addressable
// Studio for `rodeo run`/`rodeo state`.
//
// Not spawnSync: `rwork dev` opens Studio while its watchers run, and blocking
// the event loop for the whole launch would stall them (the project watcher,
// the branch-switch check, darklua's output pumps). Once a sync is running, a
// failed launch is reported and the sync goes on (`exitOnFailure: false`).
export async function openStudio(file?: string, options: { exitOnFailure?: boolean } = {}) {
	const { exitOnFailure = true } = options;
	const target = file ?? "build.rbxl";
	log.info(`Opening ${target} in Studio (rodeo)...`);
	const proc = Bun.spawn(
		["rodeo", "run", "--source", "return nil", "--place", target, "--detach", "--focus"],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
	const code = await proc.exited;
	if (code === 0) return;
	log.error(`Failed to open Studio (code ${code})`);
	if (exitOnFailure) process.exit(1);
}
