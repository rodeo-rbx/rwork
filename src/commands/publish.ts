import { writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { RworkBuild } from "../config";
import { buildDir, placeFile } from "../paths";
import { prepareOut, runDarkluaOnce } from "../prepare";
import { openStudio } from "../studio";
import { log } from "../log";

// Resolve the universe that owns a place. RWORK_UNIVERSE_ID overrides; otherwise
// ask Roblox's public endpoint so callers only ever need the place id.
async function resolveUniverse(place: string): Promise<string> {
	if (process.env.RWORK_UNIVERSE_ID) {
		return process.env.RWORK_UNIVERSE_ID;
	}
	const res = await fetch(`https://apis.roblox.com/universes/v1/places/${place}/universe`);
	if (!res.ok) {
		log.error(
			`Could not resolve the universe for place ${place} (${res.status}). Set RWORK_UNIVERSE_ID.`,
		);
		process.exit(1);
	}
	const universeId = ((await res.json()) as { universeId?: number }).universeId;
	if (!universeId) {
		log.error(`No universe found for place ${place}. Set RWORK_UNIVERSE_ID.`);
		process.exit(1);
	}
	return String(universeId);
}

// Build the binary place file with rojo, then upload it via the Open Cloud
// "publish version" endpoint. `rojo upload` is no use here: it posts to a
// legacy endpoint that Roblox has removed.
async function publishViaOpenCloud(stage: string, file: string, place: string, apiKey: string) {
	const universe = await resolveUniverse(place);

	log.info("Building the place file...");
	const proc = Bun.spawnSync(["rojo", "build", "-o", resolve(file)], {
		cwd: stage,
		stdio: ["inherit", "inherit", "inherit"],
	});
	if (proc.exitCode !== 0) {
		log.error(`Failed to build the place file (code ${proc.exitCode})`);
		process.exit(1);
	}

	log.info(`Publishing to place ${place} (universe ${universe}) via Open Cloud...`);
	const url = `https://apis.roblox.com/universes/v1/${universe}/places/${place}/versions?versionType=Published`;

	// Upload with curl rather than Bun's fetch: fetch intermittently malforms
	// large (tens-of-MB) upload requests, which the Roblox edge rejects with a
	// generic HTML "400 Bad request". curl is reliable and ubiquitous. The API
	// key is written to a 0600 temp header file (curl -H @file) so it never
	// appears in the process argument list. Resilience for a flaky connection:
	// --retry (+ --retry-all-errors, so transient drops like "curl (55) Recv
	// failure" and timeouts retry) plus stall detection (--speed-time/-limit:
	// abort only if the transfer stalls below 1KB/s for 30s, NOT on a fixed
	// total-time cap, so a slow-but-progressing upload isn't cut; --max-time is
	// just a generous backstop). Identical content is deduped server-side, so a
	// retried publish is safe.
	const headerFile = join(tmpdir(), `rwork-oc-header-${process.pid}`);
	const responseFile = join(tmpdir(), `rwork-oc-response-${process.pid}`);
	writeFileSync(headerFile, `x-api-key: ${apiKey}\n`, { mode: 0o600 });

	try {
		const curl = Bun.spawnSync(
			[
				"curl", "-sS",
				"--connect-timeout", "20",
				"--speed-limit", "1000",
				"--speed-time", "30",
				"--max-time", "600",
				"--retry", "4",
				"--retry-delay", "3",
				"--retry-all-errors",
				"-X", "POST",
				"-H", `@${headerFile}`,
				"-H", "Content-Type: application/octet-stream",
				"--data-binary", `@${file}`,
				"-o", responseFile,
				"-w", "%{http_code}",
				url,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (curl.exitCode !== 0) {
			log.error(`Failed to upload to place ${place}: ${curl.stderr.toString().trim() || `curl exited ${curl.exitCode}`}`);
			process.exit(1);
		}

		const status = curl.stdout.toString().trim();
		const responseBody = readFileSync(responseFile, "utf8");
		if (!status.startsWith("2")) {
			log.error(`Failed to publish to place ${place} (${status}): ${responseBody.trim()}`);
			process.exit(1);
		}

		const { versionNumber } = JSON.parse(responseBody) as { versionNumber?: number };
		log.info(`Published version ${versionNumber} of place ${place}`);
	} finally {
		rmSync(headerFile, { force: true });
		rmSync(responseFile, { force: true });
	}
}

// Build the prepared project and upload it to a live place through the Open
// Cloud API, as RWORK_API_KEY (universe auto-resolved from the place id, or
// RWORK_UNIVERSE_ID). There is no other way in: Roblox takes a place upload
// from an API key only, not from the account Studio is signed in to. So with
// no key this stops here, before the staging a publish would spend on nothing.
export async function publish(
	rworkBuild: RworkBuild,
	place: string,
	options?: { open?: boolean },
) {
	const apiKey = process.env.RWORK_API_KEY;
	if (!apiKey) {
		log.error(
			"publish needs RWORK_API_KEY, an Open Cloud API key that can write to the place. " +
				"Roblox no longer accepts a Studio sign-in for uploading one.",
		);
		process.exit(1);
	}

	const startTime = performance.now();
	// Its own stage: a sync of this build may be running, serving syncDir.
	const stage = buildDir(rworkBuild);

	log.info("Preparing out files...");
	prepareOut(rworkBuild, {
		includeWorkspace: true,
		includeServerStorage: true,
		includeAssets: true,
	}, stage);
	runDarkluaOnce(rworkBuild, stage);

	await publishViaOpenCloud(stage, placeFile(rworkBuild), place, apiKey);

	const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
	log.success(`Published ${stage} to place ${place} in ${elapsed}s`);

	if (options?.open) {
		await openStudio(place);
	}
}
