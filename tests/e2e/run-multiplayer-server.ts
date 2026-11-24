import { createMultiplayerServer } from "@slopemp/server";
import { decodeWire, validateSong } from "@slopemp/song";

const song = decodeWire(Bun.env["SLOPEMP_TEST_SONG"] ?? "");
validateSong(song);
const server = createMultiplayerServer({
  song,
  port: Number(Bun.env["SLOPEMP_TEST_SERVER_PORT"] ?? 0),
  password: Bun.env["SLOPEMP_TEST_SERVER_PASSWORD"] ?? "",
});
process.stdout.write(`${server.url.href.replace("http:", "ws:")}\n`);
