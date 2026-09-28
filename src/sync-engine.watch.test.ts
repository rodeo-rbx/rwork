import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { initialSync, startWatch } from "./sync-engine";

// The mirror (dest) has to end up holding what src holds once a change settles: every non-.luau
// file, and no folder or file that src no longer has. .luau is darklua's to write, so it's left
// out of the comparison.

const FOLDERS = ["gun", "melee", "motion", "mobs", "grenade", "misc"];
const FILES_PER_FOLDER = 25;

function tree(root: string): Set<string> {
	const out = new Set<string>();
	if (!existsSync(root)) return out;
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				out.add(`${relative(root, full)}/`);
				walk(full);
			} else out.add(relative(root, full));
		}
	};
	walk(root);
	return out;
}

/** What the mirror lacks, and what it holds that src doesn't (ignoring .luau). */
function diff(src: string, dest: string) {
	const s = tree(src);
	const expected = new Set<string>();
	for (const p of s) {
		if (p.endsWith("/") || p.endsWith(".luau")) continue;
		expected.add(p);
		for (let d = dirname(p); d !== "."; d = dirname(d)) expected.add(`${d}/`);
	}
	const m = new Set([...tree(dest)].filter((p) => !p.endsWith(".luau")));
	return {
		missing: [...expected].filter((p) => !m.has(p)).sort(),
		stale: [...m].filter((p) => !s.has(p)).sort(),
	};
}

const IN_SYNC = { missing: [], stale: [] };
const TIMEOUT = 20_000;

async function settle(src: string, dest: string, ms = 6000) {
	const end = Date.now() + ms;
	let d = diff(src, dest);
	while ((d.missing.length || d.stale.length) && Date.now() < end) {
		await Bun.sleep(100);
		d = diff(src, dest);
	}
	return d;
}

let stop: (() => void) | undefined;
let dir: string | undefined;

afterEach(() => {
	stop?.();
	stop = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function makeDirs() {
	dir = mkdtempSync(join(tmpdir(), "rwork-watch-"));
	const src = join(dir, "src");
	const dest = join(dir, "out");
	mkdirSync(src, { recursive: true });
	return { src, dest };
}

async function watchMirror(src: string, dest: string) {
	initialSync(src, dest);
	const watcher = startWatch({ src, dest });
	stop = () => watcher.close();
	// give the watcher a moment to start receiving events
	await Bun.sleep(200);
}

/** Folders of .rbxm assets shaped like the game's animation folders. */
function writeAssets(root: string) {
	for (const folder of FOLDERS) {
		mkdirSync(join(root, folder), { recursive: true });
		for (let i = 0; i < FILES_PER_FOLDER; i++) writeFileSync(join(root, folder, `clip${i}.rbxm`), `${folder}/${i}`);
	}
}

test("renaming a folder moves it in the mirror", async () => {
	const { src, dest } = makeDirs();
	writeAssets(join(src, "animations", "old"));
	await watchMirror(src, dest);

	renameSync(join(src, "animations", "old"), join(src, "animations", "new"));

	expect(await settle(src, dest)).toEqual(IN_SYNC);
}, TIMEOUT);

test("deleting a folder removes it from the mirror", async () => {
	const { src, dest } = makeDirs();
	writeAssets(join(src, "animations", "old"));
	writeFileSync(join(src, "keep.rbxm"), "keep");
	await watchMirror(src, dest);

	rmSync(join(src, "animations"), { recursive: true });

	expect(await settle(src, dest)).toEqual(IN_SYNC);
}, TIMEOUT);

// What a git checkout that moves folders of LFS assets does: it deletes the old files and folders
// and writes the new ones one at a time, spread out over a second or more, while the watcher keeps
// running. Folder watches opened and closed mid-burst used to lose the parent folder's events.
test("a spread-out burst that replaces whole folders reaches the mirror", async () => {
	const { src, dest } = makeDirs();
	const animations = join(src, "animations");
	writeAssets(join(animations, "keyframeSequences"));
	writeAssets(join(animations, "retargeted"));
	await watchMirror(src, dest);

	for (const old of ["keyframeSequences", "retargeted"]) {
		for (const folder of FOLDERS) {
			for (let i = 0; i < FILES_PER_FOLDER; i++) {
				unlinkSync(join(animations, old, folder, `clip${i}.rbxm`));
				if (i % 5 === 0) await Bun.sleep(1);
			}
			rmSync(join(animations, old, folder), { recursive: true });
		}
		rmSync(join(animations, old), { recursive: true });
	}
	for (const target of ["r15KeyframeSequences/r15", "r6KeyframeSequences/r15", "r6KeyframeSequences/r6"]) {
		for (const folder of FOLDERS) {
			mkdirSync(join(animations, target, folder), { recursive: true });
			for (let i = 0; i < FILES_PER_FOLDER; i++) {
				writeFileSync(join(animations, target, folder, `clip${i}.rbxm`), `${target}/${folder}/${i}`);
				if (i % 5 === 0) await Bun.sleep(1);
			}
		}
	}

	expect(await settle(src, dest)).toEqual(IN_SYNC);
}, TIMEOUT);

test("replacing a file's content (an atomic save) updates the mirror", async () => {
	const { src, dest } = makeDirs();
	writeFileSync(join(src, "model.rbxm"), "v1");
	writeFileSync(join(src, "data.json"), "{}");
	await watchMirror(src, dest);

	writeFileSync(join(src, "model.rbxm.tmp"), "v2");
	renameSync(join(src, "model.rbxm.tmp"), join(src, "model.rbxm"));
	writeFileSync(join(src, "data.json"), '{"v":2}');

	expect(await settle(src, dest)).toEqual(IN_SYNC);
	const end = Date.now() + 6000;
	while (Date.now() < end && readFileSync(join(dest, "data.json"), "utf8") !== '{"v":2}') await Bun.sleep(100);
	expect(readFileSync(join(dest, "model.rbxm"), "utf8")).toBe("v2");
	expect(readFileSync(join(dest, "data.json"), "utf8")).toBe('{"v":2}');
}, TIMEOUT);

test(".luau stays darklua's: never copied, but its output goes when the source does", async () => {
	const { src, dest } = makeDirs();
	mkdirSync(join(src, "Pkg"));
	writeFileSync(join(src, "Pkg", "init.luau"), "return 1");
	writeFileSync(join(src, "Pkg", "gone.luau"), "return 2");
	await watchMirror(src, dest);
	// stand-ins for darklua's output (darklua makes its own folders; the initial sync only
	// creates folders that hold a non-.luau file)
	mkdirSync(join(dest, "Pkg"), { recursive: true });
	writeFileSync(join(dest, "Pkg", "init.luau"), "compiled");
	writeFileSync(join(dest, "Pkg", "gone.luau"), "compiled");

	writeFileSync(join(src, "Pkg", "new.luau"), "return 3");
	writeFileSync(join(src, "Pkg", "asset.rbxm"), "asset");
	unlinkSync(join(src, "Pkg", "gone.luau"));

	expect(await settle(src, dest)).toEqual(IN_SYNC);
	const end = Date.now() + 6000;
	while (Date.now() < end && existsSync(join(dest, "Pkg", "gone.luau"))) await Bun.sleep(100);
	expect(existsSync(join(dest, "Pkg", "gone.luau"))).toBe(false);
	expect(readFileSync(join(dest, "Pkg", "init.luau"), "utf8")).toBe("compiled");
	expect(existsSync(join(dest, "Pkg", "new.luau"))).toBe(false);
}, TIMEOUT);
