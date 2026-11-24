import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clone, createNote, createSong, createTransaction, required } from "@slopemp/song";
import type { Song } from "@slopemp/song";
import { parseSongBytes, serializeSongBytes } from "@slopemp/song/codec";

import { connect, join as joinServer, submit } from "./test-peer";
import type { Peer } from "./test-peer";

type CliProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;
const entry = new URL("./index.ts", import.meta.url).pathname;
const fileName = "currentsong.slopemp";

const inWorkspace = async (run: (directory: string) => Promise<void>): Promise<void> => {
  const workspace = await mkdtemp(join(tmpdir(), "slopemp-server-test-"));
  try {
    const directory = join(workspace, "run-server");
    await mkdir(directory);
    await run(directory);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

const launch = async (directory: string, settings = ""): Promise<CliProcess> => {
  await writeFile(join(directory, "config.toml"), `port = 0\n${settings}`);
  return Bun.spawn([process.execPath, entry], {
    cwd: join(directory, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 4000,
    killSignal: "SIGKILL",
  });
};

const addressOf = async (server: CliProcess): Promise<URL> => {
  const reader = server.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error(
          `Server closed before listening. ${await new Response(server.stderr).text()}`,
        );
      }
      stdout += decoder.decode(chunk.value, { stream: true });
      const address = /listening at (ws:\/\/\S+)\n/u.exec(stdout)?.[1];
      if (address !== undefined) {
        return new URL(address);
      }
    }
  } finally {
    reader.releaseLock();
  }
};

const commit = async (
  peer: Peer,
  previous: Song,
  proposal: Song,
  revision: number,
): Promise<number> => {
  const id = `persistence-edit-${revision}`;
  submit(peer, id, revision, createTransaction(previous, proposal));
  const result = await peer.next("accepted");
  expect(result.id).toBe(id);
  expect(result.revision).toBe(revision + 1);
  return result.revision;
};

const waitForSong = async (path: string, title: string): Promise<Song> => {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (await Bun.file(path).exists()) {
      const song = parseSongBytes(await readFile(path));
      if (song.title === title) {
        return song;
      }
    }
    await Bun.sleep(15);
  }
  throw new Error(`Timed out waiting for the song "${title}" to be saved.`);
};

test("starts from a song file, saves edits on SIGTERM, and restores them on restart", async () => {
  await inWorkspace(async (directory) => {
    const path = join(directory, fileName);
    const fixture = createSong();
    fixture.title = "Saved arrangement";
    fixture.tempo = 120;
    const track = required(fixture.channels[0]);
    track.cells[0] = 1;
    required(track.patterns[1]).notes.push(createNote(0, 1, 48));
    const initialBytes = serializeSongBytes(fixture);
    const baseline = parseSongBytes(initialBytes);
    await writeFile(path, initialBytes);

    await using server = await launch(directory);
    const { peer, welcome } = await joinServer(await addressOf(server));
    expect(welcome.song).toEqual(baseline);

    const changed = clone(baseline);
    changed.tempo = 175;
    changed.title = "New arrangement";
    const editedTrack = required(changed.channels[0]);
    editedTrack.name = "Harmony";
    required(editedTrack.patterns[1]).notes.push(createNote(2, 3, 55));
    await commit(peer, baseline, changed, welcome.revision);

    // The default timer has not reached its first tick.
    await Bun.sleep(100);
    expect(await readFile(path)).toEqual(Buffer.from(initialBytes));

    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
    expect(parseSongBytes(await readFile(path))).toEqual(changed);

    await using restarted = await launch(directory);
    const joined = await joinServer(await addressOf(restarted));
    expect(joined.welcome.song).toEqual(changed);
    expect(joined.welcome.revision).toBe(0);
    restarted.kill("SIGTERM");
    expect(await restarted.exited).toBe(0);
  });
});

test("generates a missing song and periodically saves its latest accepted edits", async () => {
  await inWorkspace(async (directory) => {
    const path = join(directory, fileName);
    await using server = await launch(directory, "save_interval_ms = 100\n");
    const { peer, welcome } = await joinServer(await addressOf(server));
    expect(welcome.song.channels.length).toBeGreaterThan(0);
    expect(welcome.revision).toBe(0);

    let { song } = welcome;
    let { revision } = welcome;
    for (const title of ["First periodic save", "Second periodic save"]) {
      const changed = { ...song, title };
      revision = await commit(peer, song, changed, revision);
      expect(await waitForSong(path, title)).toEqual(changed);
      song = changed;
    }

    server.kill("SIGINT");
    expect(await server.exited).toBe(0);
    expect(parseSongBytes(await readFile(path))).toEqual(song);
  });
});

test("reports corrupt song files with the codec error and preserves the original bytes", async () => {
  await inWorkspace(async (directory) => {
    const path = join(directory, fileName);
    const original = Buffer.from("This is not a SlopeMP song file.");
    await writeFile(path, original);
    await using server = await launch(directory);
    const [exitCode, stdout, stderr] = await Promise.all([
      server.exited,
      new Response(server.stdout).text(),
      new Response(server.stderr).text(),
    ]);
    expect(exitCode).toBeGreaterThan(0);
    expect(stdout).not.toContain("listening at");
    expect(stderr).toContain(`Corrupt song file ${path}`);
    expect(stderr).toContain("error: Invalid or corrupt SlopeMP data.");
    expect(await readFile(path)).toEqual(original);
  });
});

test("reports filesystem issues if the song path is a directory", async () => {
  await inWorkspace(async (directory) => {
    const path = join(directory, fileName);
    await mkdir(path);
    await using server = await launch(directory);
    const [exitCode, stderr] = await Promise.all([
      server.exited,
      new Response(server.stderr).text(),
    ]);
    expect(exitCode).toBeGreaterThan(0);
    expect(stderr).toContain(`Could not read song file ${path}`);
    expect(stderr).toContain("EISDIR");
  });
});

test("requires the password configured in TOML", async () => {
  await inWorkspace(async (directory) => {
    await using server = await launch(directory, 'password = "private room"\n');
    const address = await addressOf(server);
    const incorrect = await connect(address);
    incorrect.send({ type: "hello", password: "wrong" });
    expect((await incorrect.next("error")).reason).toBe("Incorrect server password.");
    const { welcome } = await joinServer(address, "private room");
    expect(welcome.revision).toBe(0);
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
  });
});
