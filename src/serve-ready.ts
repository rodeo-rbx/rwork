import { readFileSync } from "fs";
import { join } from "path";

// rojo serve's own defaults (src/cli/serve.rs): a project's servePort/serveAddress
// win over them, and --port over both.
const ROJO_DEFAULT_PORT = 34872;
const ROJO_DEFAULT_ADDRESS = "127.0.0.1";

/** Where `rojo serve` in `cwd` listens: `portOverride` (what rwork passes as --port),
 *  else the served project's servePort/serveAddress, else rojo's defaults. */
export function serveEndpoint(cwd: string, portOverride?: string): { address: string; port: number } {
	let project: { servePort?: unknown; serveAddress?: unknown } = {};
	try {
		project = JSON.parse(readFileSync(join(cwd, "default.project.json"), "utf-8"));
	} catch {
		// Unreadable here means rojo serve fails too; the defaults keep the wait harmless.
	}
	const port = portOverride
		? Number(portOverride)
		: typeof project.servePort === "number"
			? project.servePort
			: ROJO_DEFAULT_PORT;
	let address = typeof project.serveAddress === "string" ? project.serveAddress : ROJO_DEFAULT_ADDRESS;
	// A wildcard bind listens on loopback too, which is where Studio's plugin connects.
	if (address === "0.0.0.0") address = "127.0.0.1";
	if (address === "::") address = "::1";
	return { address, port };
}

/** The base URL of a Rojo server at an endpoint (an IPv6 address goes in brackets). */
export function serveUrl(endpoint: { address: string; port: number }): string {
	const host = endpoint.address.includes(":") ? `[${endpoint.address}]` : endpoint.address;
	return `http://${host}:${endpoint.port}`;
}

/** The string a MessagePack map holds under `key`, found by its encoded key: enough for
 *  one field of Rojo's server info without a MessagePack dependency. Short keys only
 *  (under 32 bytes, so the key is a fixstr). */
export function msgpackString(bytes: Uint8Array, key: string): string | null {
	const encodedKey = new TextEncoder().encode(key);
	const head = 0xa0 | encodedKey.length;
	search: for (let i = 0; i + 1 + encodedKey.length < bytes.length; i++) {
		if (bytes[i] !== head) continue;
		for (let j = 0; j < encodedKey.length; j++) {
			if (bytes[i + 1 + j] !== encodedKey[j]) continue search;
		}
		const at = i + 1 + encodedKey.length;
		const tag = bytes[at]!;
		let start: number;
		let length: number;
		if (tag >= 0xa0 && tag <= 0xbf) [start, length] = [at + 1, tag & 0x1f];
		else if (tag === 0xd9) [start, length] = [at + 2, bytes[at + 1]!];
		else if (tag === 0xda) [start, length] = [at + 3, (bytes[at + 1]! << 8) | bytes[at + 2]!];
		else return null;
		return new TextDecoder().decode(bytes.subarray(start, start + length));
	}
	return null;
}

/** The project name a Rojo server at `baseUrl` reports, or null if nothing Rojo-like
 *  answers there. Rojo 7.7 answers in MessagePack, earlier versions in JSON; a Rojo
 *  answer whose name can't be read reads as "(unknown)", still a server. */
export async function rojoProjectAt(baseUrl: string, timeoutMs = 1000): Promise<string | null> {
	try {
		const response = await fetch(`${baseUrl}/api/rojo`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return null;
		const type = response.headers.get("content-type") ?? "";
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (type.includes("msgpack")) return msgpackString(bytes, "projectName") ?? "(unknown)";
		const info = JSON.parse(new TextDecoder().decode(bytes)) as { projectName?: unknown };
		return typeof info.projectName === "string" ? info.projectName : null;
	} catch {
		return null;
	}
}

export type ServeWait = "serving" | "stopped" | "timeout";

/** Polls `baseUrl` until a Rojo server answers while `alive()` holds (the answer is then
 *  ours, not a server that was already on the port), until `stopped()`, or until
 *  `timeoutMs` passes. */
export async function waitForServe(options: {
	baseUrl: string;
	alive: () => boolean;
	stopped: () => boolean;
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<ServeWait> {
	const { baseUrl, alive, stopped, timeoutMs = 120_000, intervalMs = 250 } = options;
	const deadline = Date.now() + timeoutMs;
	while (!stopped()) {
		if (alive() && (await rojoProjectAt(baseUrl)) !== null && alive()) return "serving";
		if (Date.now() >= deadline) return "timeout";
		await Bun.sleep(intervalMs);
	}
	return "stopped";
}
