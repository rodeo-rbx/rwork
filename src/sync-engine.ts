import {
	linkSync,
	copyFileSync,
	unlinkSync,
	mkdirSync,
	rmSync,
	readdirSync,
	existsSync,
	statSync,
	watch,
	type FSWatcher,
	type Stats,
} from "fs";
import { dirname, join, relative, resolve, extname } from "path";
import { log } from "./log";

const LINK_EXTENSIONS = new Set([
	".rbxm",
	".rbxmx",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".xml",
	".wav",
	".mp3",
	".ogg",
	".flac",
]);

function shouldHardLink(relPath: string): boolean {
	return LINK_EXTENSIONS.has(extname(relPath));
}

function shouldSkipCopy(relPath: string): boolean {
	return relPath.endsWith(".luau");
}

/** Recursively walk a directory and yield all file paths */
function* walkDir(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walkDir(fullPath);
		} else {
			yield fullPath;
		}
	}
}

/** Write one src file to dest (hard-link, copy, or skip per extension rules). Idempotent. */
function writeOneFile(srcPath: string, destPath: string, relPath: string): void {
	// .luau is owned by darklua (--watch in sync, one-shot in build/publish);
	// rwork must not touch it. The pre-unlink below would otherwise race
	// darklua's write and can delete its output, dropping the module from the
	// synced tree (e.g. an edited init.luau vanishing, so its folder stops being
	// a ModuleScript). Skip .luau BEFORE the unlink. Deletes are still handled
	// by the watcher's removeFromDest (darklua --watch leaves stale output on a source delete).
	if (shouldSkipCopy(relPath)) return;

	mkdirSync(dirname(destPath), { recursive: true });

	try {
		unlinkSync(destPath);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			log.diag(`writeOneFile pre-unlink failed: ${relPath}: ${(e as Error).message}`);
		}
	}

	if (shouldHardLink(relPath)) {
		try {
			linkSync(srcPath, destPath);
			return;
		} catch (e) {
			log.diag(`writeOneFile linkSync fell back to copy: ${relPath}: ${(e as Error).message}`);
		}
	}
	copyFileSync(srcPath, destPath);
}

/** Initial sync: clean dest, walk src, hard-link or copy all files */
export function initialSync(srcDir: string, destDir: string): void {
	const absSrc = resolve(srcDir);
	const absDest = resolve(destDir);

	rmSync(absDest, { recursive: true, force: true });
	mkdirSync(absDest, { recursive: true });

	let linked = 0;
	let copied = 0;
	for (const srcPath of walkDir(absSrc)) {
		const rel = relative(absSrc, srcPath);
		writeOneFile(srcPath, join(absDest, rel), rel);
		if (shouldSkipCopy(rel)) continue;
		if (shouldHardLink(rel)) linked++;
		else copied++;
	}
	log.info(`[sync] Initial sync complete: ${linked} linked, ${copied} copied`);
}

/** Delete `.luau` outputs in dest whose source no longer exists. darklua only
 *  cleans outputs for removals it saw; after it is restarted (or misses an
 *  event) the output tree can keep modules that are gone from src, which Rojo
 *  would happily go on serving. Returns how many files were removed. */
export function pruneStaleLuau(srcDir: string, destDir: string): number {
	const absSrc = resolve(srcDir);
	const absDest = resolve(destDir);
	if (!existsSync(absDest)) return 0;

	let pruned = 0;
	for (const destPath of walkDir(absDest)) {
		const rel = relative(absDest, destPath);
		if (!rel.endsWith(".luau") || existsSync(join(absSrc, rel))) continue;
		try {
			unlinkSync(destPath);
			pruned++;
			log.info(`[sync] prune: ${rel}`);
		} catch (e) {
			log.diag(`prune failed: ${rel}: ${(e as Error).message}`);
		}
	}
	return pruned;
}

export interface WatchSyncOptions {
	src: string;
	dest: string;
	onLuauChange?: () => void;
}

/** How long a batch of events waits for the burst to go quiet, and the most it's ever held.
 *  Batches sync from disk, so a short settle only means more, smaller batches during a burst. */
const SETTLE_MS = 20;
const MAX_BATCH_MS = 1000;
/** A batch this large is synced by walking the whole tree instead of path by path. */
const FULL_SYNC_PATHS = 200;

function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

/** Whether dest already holds src's current content: the same inode for a hard link, otherwise a
 *  copy that is the same size and no older than the source. */
function isUpToDate(srcPath: string, destPath: string, relPath: string): boolean {
	const d = statOrNull(destPath);
	if (!d || d.isDirectory()) return false;
	const s = statSync(srcPath);
	if (shouldHardLink(relPath) && s.ino === d.ino && s.dev === d.dev) return true;
	return s.size === d.size && d.mtimeMs >= s.mtimeMs;
}

/**
 * Start watching src for changes, sync to dest.
 *
 * One recursive fs.watch on src, created once. Per-folder watches (chokidar's model) have to be
 * opened and closed as folders come and go, and on macOS every open or close makes Bun rebuild its
 * shared FSEvents stream from "now", dropping whatever happens in between; a git checkout that
 * moves folders of assets lost its new folders that way. Events only say which path changed, so
 * each batch syncs those paths from what's on disk when it runs: a path that's gone is removed, a
 * folder is synced as a whole, a file is linked or copied, and a renamed entry's folder listing is
 * rechecked too. That's correct whatever order or grouping the events came in.
 */
export function startWatch(options: WatchSyncOptions): FSWatcher {
	const absSrc = resolve(options.src);
	const absDest = resolve(options.dest);

	log.info(`[sync] Watching for changes... (diag=${log.diagEnabled ? "on" : "off"})`);
	log.diag(`startWatch absSrc=${absSrc} absDest=${absDest}`);

	let totalEvents = 0;
	let totalBatches = 0;
	let totalLuauTriggers = 0;
	let lastEventAt = Date.now();
	const startedAt = Date.now();

	const fireLuauChange = () => {
		totalLuauTriggers++;
		log.diag(`  → onLuauChange #${totalLuauTriggers}`);
		try {
			options.onLuauChange?.();
		} catch (e) {
			log.error(`[sync] onLuauChange threw: ${(e as Error).message}`);
			log.diag((e as Error).stack ?? "(no stack)");
		}
	};

	/** Removes rel from dest, whatever it is there. A deleted .luau source's output goes too:
	 *  darklua --watch leaves it behind. */
	const removeFromDest = (rel: string) => {
		const destPath = join(absDest, rel);
		const d = statOrNull(destPath);
		if (!d) return;
		rmSync(destPath, { recursive: true, force: true });
		log.info(`[sync] ${d.isDirectory() ? "rmdir" : "delete"}: ${rel}`);
	};

	const writeFile = (rel: string) => {
		writeOneFile(join(absSrc, rel), join(absDest, rel), rel);
		log.info(`[sync] change: ${rel} (${shouldHardLink(rel) ? "link" : "copy"})`);
	};

	const ensureDestDir = (rel: string) => {
		const destPath = join(absDest, rel);
		const d = statOrNull(destPath);
		if (d?.isDirectory()) return;
		if (d) unlinkSync(destPath);
		mkdirSync(destPath, { recursive: true });
		log.info(`[sync] mkdir: ${rel || "."}`);
	};

	/** Removes what dest/rel holds that src/rel no longer does. */
	const removeStale = (rel: string, srcNames: Set<string>) => {
		for (const name of readdirSync(join(absDest, rel))) {
			if (!srcNames.has(name)) removeFromDest(join(rel, name));
		}
	};

	/** Makes dest/rel match the src folder rel, all the way down. */
	const syncTree = (rel: string) => {
		ensureDestDir(rel);
		const entries = readdirSync(join(absSrc, rel), { withFileTypes: true });
		for (const e of entries) {
			const child = join(rel, e.name);
			if (e.isDirectory()) syncTree(child);
			else if (!shouldSkipCopy(child) && !isUpToDate(join(absSrc, child), join(absDest, child), child)) {
				writeFile(child);
			}
		}
		removeStale(rel, new Set(entries.map((e) => e.name)));
	};

	/** Checks one folder's listing (not its contents): adds entries dest lacks, including whole
	 *  folders it never heard about, and removes entries src no longer has. */
	const syncListing = (rel: string) => {
		if (!statOrNull(join(absSrc, rel))?.isDirectory()) {
			removeFromDest(rel);
			return;
		}
		ensureDestDir(rel);
		const entries = readdirSync(join(absSrc, rel), { withFileTypes: true });
		for (const e of entries) {
			const child = join(rel, e.name);
			if (existsSync(join(absDest, child))) continue;
			if (e.isDirectory()) syncTree(child);
			else if (!shouldSkipCopy(child)) writeFile(child);
		}
		removeStale(rel, new Set(entries.map((e) => e.name)));
	};

	/** Syncs one path from what's on disk now. */
	const syncPath = (rel: string) => {
		const s = statOrNull(join(absSrc, rel));
		if (!s) removeFromDest(rel);
		else if (s.isDirectory()) syncTree(rel);
		else if (!shouldSkipCopy(rel)) writeFile(rel);
	};

	// path -> strongest event kind seen this batch ("rename" also rechecks the parent's listing)
	const pending = new Map<string, "change" | "rename">();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let batchStartedAt = 0;

	const flush = () => {
		timer = undefined;
		const batch = [...pending];
		pending.clear();
		totalBatches++;
		const touchedLuau = batch.some(([rel]) => rel.endsWith(".luau"));
		log.diag(`batch #${totalBatches}: ${batch.length} paths`);

		const guarded = (what: string, rel: string, fn: () => void) => {
			try {
				fn();
			} catch (e) {
				// usually the path changed again mid-sync; its next event resyncs it
				log.diag(`${what} ${rel || "."} failed: ${(e as Error).message}`);
			}
		};
		if (batch.length > FULL_SYNC_PATHS) {
			guarded("full sync", "", () => syncTree(""));
		} else {
			for (const [rel, kind] of batch) {
				guarded("sync", rel, () => syncPath(rel));
				if (kind === "rename" && rel !== "") {
					const parent = dirname(rel);
					guarded("sync listing", parent, () => syncListing(parent === "." ? "" : parent));
				}
			}
		}
		if (touchedLuau) fireLuauChange();
	};

	const watcher = watch(absSrc, { recursive: true }, (eventType, filename) => {
		totalEvents++;
		lastEventAt = Date.now();
		const rel = filename ? filename.toString() : "";
		log.diag(`watch event #${totalEvents}: type=${eventType} filename=${rel}`);
		if (pending.get(rel) !== "rename") pending.set(rel, eventType === "rename" ? "rename" : "change");

		const now = Date.now();
		if (timer) clearTimeout(timer);
		else batchStartedAt = now;
		timer = setTimeout(flush, now - batchStartedAt >= MAX_BATCH_MS ? 0 : SETTLE_MS);
	});

	watcher.on("error", (err) => {
		log.error(`[sync] watcher error: ${(err as Error).message}`);
		log.diag((err as Error).stack ?? "(no stack)");
	});

	if (log.diagEnabled) {
		const heartbeat = setInterval(() => {
			const idle = Math.round((Date.now() - lastEventAt) / 1000);
			const uptime = Math.round((Date.now() - startedAt) / 1000);
			log.diag(
				`heartbeat: events=${totalEvents} batches=${totalBatches} luauTriggers=${totalLuauTriggers} idle=${idle}s uptime=${uptime}s`,
			);
		}, 30_000);
		watcher.on("close", () => clearInterval(heartbeat));
	}

	return watcher;
}
