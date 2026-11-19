import type { RworkBuild } from "../config";
import { placeFile } from "../paths";
import { build } from "./build";
import { publish } from "./publish";
import { sync } from "./sync";
import { openStudio } from "../studio";
import { log } from "../log";

export async function dev(rworkBuild: RworkBuild, place?: string, options: { upload?: boolean } = {}) {
	if (place) {
		if (options.upload) {
			// Live mode + --upload: build + publish a fresh build to the place,
			// then open THAT place in Studio.
			await publish(rworkBuild, place, { open: true });
		} else {
			// Live mode: open the already-published place and live-sync source on
			// top of it. The Open Cloud upload is the slow, flaky, version-minting
			// step, so it's opt-in via --upload (or use `rwork publish` to refresh
			// the published baseline). Assumes the place has a prior build.
			openStudio(place);
		}
	} else {
		// Local mode: build the place file and open it.
		build(rworkBuild);
		openStudio(placeFile(rworkBuild));
	}
	log.success(
		"Build ready! You must enable HttpService and DataStoreService in Experience Settings after publishing to ensure the build works as expected.",
	);
	await sync(rworkBuild);
}
