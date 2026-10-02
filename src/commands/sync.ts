import { readFileSync } from "fs";
import type { RworkBuild } from "../config";
import { envConfig } from "../config";
import { prepareOut } from "../prepare";
import { pruneStaleLuau, startWatch } from "../sync-engine";
import { startDarkluaWatch, type DarkluaWatch } from "../darklua-watch";
import { log } from "../log";

export async function sync(rworkBuild: RworkBuild) {
	const cwd = `.rwork/${rworkBuild.name}`;
	const src = rworkBuild.src;
	const darkluaConfig = `${cwd}/darklua.json`;

	log.warn(
		"MAKE SURE YOU PESDE RUN RELOAD TO ENSURE ASPHALT AND ZAP FILES ARE LOADED!",
	);
	if (src) {
		log.warn(`Darklua Config: ${darkluaConfig}`);
	}

	// Hard-link assets + generate the project/sourcemap, but let `darklua --watch`
	// own the .luau build so we don't pay the full one-shot cost twice.
	prepareOut(rworkBuild, {
		includeWorkspace: false,
		includeServerStorage: envConfig.includeServerStorageWhenSyncing,
		includeAssets: envConfig.includeAssetsWhenSyncing,
	});

	// The compile pipeline (darklua --watch, the non-lua watcher, the sourcemap
	// watcher feeding convert_require) only exists when there's a src to compile.
	// A src-less build serves every $path raw, so rojo serve alone is live.
	let darkluaWatch: DarkluaWatch | null = null;
	// Holder, not a `let`: the supervisor reassigns it from inside a closure.
	const sourcemap: { proc: ReturnType<typeof Bun.spawn> | null } = { proc: null };
	// Set before killing children on shutdown so the supervisors don't respawn them.
	let stopping = false;
	if (src) {
		const dest = `${cwd}/${src}`;

		// darklua --watch: full build once, then ~ms incremental rebuilds on .luau
		// content edits. Wait for the initial build before serving so Studio gets a
		// complete tree. Supervised: respawned if it exits, and killed + respawned
		// if its watcher thread panics (the process survives that but never
		// compiles again, see #2). Its output also goes to .rwork/<build>/darklua.log.
		log.info("[sync] Starting darklua --watch...");
		darkluaWatch = startDarkluaWatch({
			src,
			dest,
			config: darkluaConfig,
			logFile: `${cwd}/darklua.log`,
			onReady: (restarts) => {
				if (restarts === 0) return;
				// A fresh darklua rebuilds everything but knows nothing about sources
				// deleted while the previous one was dead: drop their outputs.
				const pruned = pruneStaleLuau(src, dest);
				log.success(
					`[sync] darklua rebuilt after restart #${restarts}${pruned ? ` (pruned ${pruned} stale output${pruned === 1 ? "" : "s"})` : ""}`,
				);
			},
		});
		await darkluaWatch.ready;
		log.success("[sync] darklua initial build complete");

		// rwork's own watcher hard-links non-lua and cleans deletes; darklua owns the
		// .luau content, so there's no onLuauChange callback.
		startWatch({ src, dest });

		// Keep the sourcemap fresh so darklua's convert_require resolves new/renamed
		// modules (a structural change rewrites it; content-only edits leave it alone).
		// Every rewrite makes darklua rebuild every file, and convert_require re-parses
		// the sourcemap once per file, so keep it scripts-only like prepareOut's:
		// --include-non-scripts expands every .rbxm (game-prototype: 347 KB -> 11 MB,
		// 1.8 s -> 26 s per rebuild) without changing a single converted require.
		// Supervised like rojo serve below: rojo panics on the same transient fs
		// events, and a dead watcher is silent — new modules just keep their raw
		// `@alias` requires in the output.
		const sourcemapArgs = [
			"rojo",
			"sourcemap",
			`${cwd}/sourcemap.project.json`,
			"-o",
			`${cwd}/sourcemap.json`,
			"--watch",
		];
		void (async () => {
			let fastCrashes = 0;
			while (!stopping) {
				const startedAt = Date.now();
				const proc = Bun.spawn(sourcemapArgs, { stdio: ["inherit", "inherit", "inherit"] });
				sourcemap.proc = proc;
				log.diag(`rojo sourcemap --watch spawned (pid=${proc.pid})`);
				const code = await proc.exited;
				if (stopping) break;
				fastCrashes = Date.now() - startedAt < 5000 ? fastCrashes + 1 : 0;
				if (fastCrashes >= 5) {
					log.error("[sync] rojo sourcemap --watch keeps crashing immediately; giving up (new modules won't resolve requires until restart)");
					break;
				}
				log.warn(`[sync] rojo sourcemap --watch exited (code=${code}); restarting...`);
				await Bun.sleep(1000);
			}
		})();
	}

	// Branch switch detector
	let initialHead: string;
	try {
		initialHead = readFileSync(".git/HEAD", "utf-8");
	} catch {
		initialHead = "";
	}

	let branchInterval: ReturnType<typeof setInterval> | null = null;
	if (initialHead) {
		branchInterval = setInterval(async () => {
			try {
				const currentHead = readFileSync(".git/HEAD", "utf-8");
				if (currentHead !== initialHead) {
					log.warn("Branch switch detected, aborting sync...");
					stopping = true;
					if (branchInterval) clearInterval(branchInterval);
					sourcemap.proc?.kill();
					await darkluaWatch?.stop();
					process.exit(0);
				}
			} catch {}
		}, 1000);
	}

	// rojo serve — main loop. Async so the event loop stays free for the fs.watch
	// callbacks, the branch-switch interval, and the darklua output pumps.
	// RWORK_SYNC_PORT overrides rojo's default port. A non-zero exit respawns the
	// server — rojo can panic on transient fs events (e.g. pesde writes temporary
	// .git objects into roblox_packages while applying patches; rojo 7.7 panics
	// canonicalizing the already-deleted path) and the sync should survive that.
	// Repeated immediate crashes (port taken, broken project) give up instead of
	// loop-crashing.
	const serveArgs = ["rojo", "serve"];
	if (envConfig.syncPort) {
		serveArgs.push("--port", envConfig.syncPort);
	}

	let exitCode: number;
	let fastCrashes = 0;
	for (;;) {
		const startedAt = Date.now();
		const serveProc = Bun.spawn(serveArgs, {
			cwd,
			stdio: ["inherit", "inherit", "inherit"],
		});
		log.diag(
			`rojo serve spawned (pid=${serveProc.pid}${envConfig.syncPort ? ` port=${envConfig.syncPort}` : ""})`,
		);
		exitCode = await serveProc.exited;
		log.diag(`rojo serve exited code=${exitCode}`);
		if (exitCode === 0) break;
		fastCrashes = Date.now() - startedAt < 5000 ? fastCrashes + 1 : 0;
		if (fastCrashes >= 5) {
			log.error("[sync] rojo serve keeps crashing immediately; giving up");
			break;
		}
		log.warn(`[sync] rojo serve crashed (code=${exitCode}); restarting...`);
		await Bun.sleep(1000);
	}

	// Cleanup
	stopping = true;
	sourcemap.proc?.kill();
	await darkluaWatch?.stop();
	if (branchInterval) clearInterval(branchInterval);

	if (exitCode !== 0) {
		process.exit(exitCode ?? 1);
	}
}
