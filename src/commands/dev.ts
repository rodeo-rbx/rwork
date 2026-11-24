import type { RworkBuild } from "../config";
import { placeFile } from "../paths";
import { build } from "./build";
import { publish } from "./publish";
import { sync } from "./sync";
import { openStudio } from "../studio";
import { log } from "../log";

// Studio opens after rojo serve answers, not before: the Rojo plugin looks for a
// server as it loads (Auto Reconnect checks only then), and a failed build or
// serve shows up before the wait for Studio instead of after it.
export async function dev(rworkBuild: RworkBuild, place?: string, options: { upload?: boolean } = {}) {
	let target: string;
	if (place) {
		if (options.upload) {
			// Live mode + --upload: build + publish a fresh build to the place, then
			// open THAT place once the sync is serving.
			await publish(rworkBuild, place);
		}
		// Live mode: open the already-published place and live-sync source on top
		// of it. The Open Cloud upload is the slow, flaky, version-minting step, so
		// it's opt-in via --upload (or use `rwork publish` to refresh the published
		// baseline). Assumes the place has a prior build.
		target = place;
	} else {
		// Local mode: build the place file, then open it once the sync is serving.
		await build(rworkBuild);
		target = placeFile(rworkBuild);
	}
	log.success(
		"Build ready! You must enable HttpService and DataStoreService in Experience Settings after publishing to ensure the build works as expected.",
	);
	log.info(`Studio opens ${target} once rojo serve is up`);
	await sync(rworkBuild, {
		onServing: () => openStudio(target, { exitOnFailure: false }),
		// Live mode only: a local build.rbxl has PlaceId 0, which a listed id would refuse.
		placeId: place,
	});
}
