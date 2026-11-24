import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { msgpackString, rojoProjectAt, serveEndpoint, serveUrl, waitForServe } from "./serve-ready";

// `rwork dev` opens Studio once its own rojo serve answers, so the Rojo plugin finds the server
// as it loads. These check where that wait looks and when it says the server is up.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rwork-serve-ready-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function project(fields: Record<string, unknown>) {
	writeFileSync(join(dir, "default.project.json"), JSON.stringify({ name: "game", tree: {}, ...fields }));
}

/** A MessagePack string: fixstr, or str8 past 31 bytes. */
function msgpackStr(text: string): number[] {
	const bytes = [...new TextEncoder().encode(text)];
	return bytes.length < 32 ? [0xa0 | bytes.length, ...bytes] : [0xd9, bytes.length, ...bytes];
}

/** Rojo 7.7's /api/rojo body: a MessagePack map, here {sessionId, projectName, protocolVersion}. */
function serverInfo(projectName: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array([0x83, ...msgpackStr("sessionId"), ...msgpackStr("x"), ...msgpackStr("projectName"), ...msgpackStr(projectName), ...msgpackStr("protocolVersion"), 0x05]);
}

/** A stand-in Rojo 7.7 server answering /api/rojo for `projectName`. */
function fakeRojo(projectName: string, port = 0) {
	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: (request) =>
			new URL(request.url).pathname === "/api/rojo"
				? new Response(serverInfo(projectName), { headers: { "content-type": "application/msgpack" } })
				: new Response("not found", { status: 404 }),
	});
}

test("the endpoint is rwork's --port, else the project's servePort and serveAddress, else rojo's defaults", () => {
	expect(serveEndpoint(dir)).toEqual({ address: "127.0.0.1", port: 34872 });
	project({ servePort: 40000, serveAddress: "127.0.0.2" });
	expect(serveEndpoint(dir)).toEqual({ address: "127.0.0.2", port: 40000 });
	expect(serveEndpoint(dir, "41000")).toEqual({ address: "127.0.0.2", port: 41000 });
	// a wildcard bind is reached on loopback
	project({ serveAddress: "0.0.0.0" });
	expect(serveEndpoint(dir).address).toBe("127.0.0.1");
	project({ serveAddress: "::" });
	expect(serveUrl(serveEndpoint(dir))).toBe("http://[::1]:34872");
});

test("a server's project name is read from /api/rojo, MessagePack or JSON, and nothing listening reads as null", async () => {
	const server = fakeRojo("game");
	try {
		expect(await rojoProjectAt(`http://127.0.0.1:${server.port}`)).toBe("game");
	} finally {
		server.stop(true);
	}
	expect(await rojoProjectAt(`http://127.0.0.1:${server.port}`)).toBeNull();

	// Rojo before 7.7 answered in JSON
	const older = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ projectName: "old-game" }) });
	try {
		expect(await rojoProjectAt(`http://127.0.0.1:${older.port}`)).toBe("old-game");
	} finally {
		older.stop(true);
	}
});

test("a MessagePack map's string is found by its key, short or long", () => {
	const long = "a-project-name-longer-than-thirty-one-bytes";
	expect(msgpackString(serverInfo("game"), "projectName")).toBe("game");
	expect(msgpackString(serverInfo(long), "projectName")).toBe(long);
	expect(msgpackString(serverInfo("game"), "placeId")).toBeNull();
});

test("the wait ends when the server answers while the serve process is alive", async () => {
	const server = fakeRojo("game");
	try {
		const waited = await waitForServe({
			baseUrl: `http://127.0.0.1:${server.port}`,
			alive: () => true,
			stopped: () => false,
			intervalMs: 10,
		});
		expect(waited).toBe("serving");
	} finally {
		server.stop(true);
	}
});

test("an answer while the serve process is dead is not ours, and the wait goes on until it times out", async () => {
	const server = fakeRojo("someone-else");
	try {
		const waited = await waitForServe({
			baseUrl: `http://127.0.0.1:${server.port}`,
			alive: () => false,
			stopped: () => false,
			timeoutMs: 100,
			intervalMs: 10,
		});
		expect(waited).toBe("timeout");
	} finally {
		server.stop(true);
	}
});

test("a stopped sync ends the wait, and a server that comes up later is waited for", async () => {
	let stop = false;
	setTimeout(() => (stop = true), 50);
	expect(
		await waitForServe({ baseUrl: "http://127.0.0.1:1", alive: () => true, stopped: () => stop, intervalMs: 10 }),
	).toBe("stopped");

	// nothing on the port yet; the server starts after a few polls
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port;
	probe.stop(true);
	let server: ReturnType<typeof Bun.serve> | undefined;
	setTimeout(() => {
		server = fakeRojo("game", port);
	}, 60);
	try {
		expect(
			await waitForServe({ baseUrl: `http://127.0.0.1:${port}`, alive: () => true, stopped: () => false, intervalMs: 10 }),
		).toBe("serving");
	} finally {
		server?.stop(true);
	}
});
