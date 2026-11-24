# SlopeMP

A browser-based music editor.

```sh
bun install
bun run build
bun run start
```

Open `http://127.0.0.1:4173/slopemp/`. The build produces the static website in
`dist/web/`, including bundled assets and license notices.

```sh
bunx playwright install chromium firefox
bun run check
bun test tests/unit
bun run test:browser
```

Asset sources, hashes, attribution, and license texts are in [license/README.md](license/README.md).

## Deploy to Cloudflare Pages

Run these commands from the repository in your devbox:

```sh
bun install
bun run cf:login
bun run deploy
```

Log in through the browser when Wrangler prompts. Deploy to the `slopemp`
Pages project with `main` as its production branch at `https://slopemp.pages.dev`.

For later updates, run `bun run deploy`. This builds the site and uploads
`dist/web/` to the production branch, even when your local branch has another
name. According to [Cloudflare](https://developers.cloudflare.com/pages/functions/wrangler-configuration/),
`wrangler.jsonc` supplies the Pages project name and build output directory.
The website is served at `/`; the multiplayer server runs separately.

Run `bun run preview:pages` to build and preview the site locally through
Wrangler. Wrangler stores local state in the ignored `.wrangler/` directory.

## Regenerate protobuf bindings

Install the Protocol Buffers compiler (`protoc`) and make sure it is on your
`PATH`. From the repository root, run the following after editing `src/*.proto` or `shared/*.proto`.

```sh
bun install
bun run generate:proto
```

The command uses the generator pinned in `package.json` and writes TypeScript
bindings to `src/generated/` and `shared/generated/`. Commit the updated schemas
and bindings together.

## Multiplayer

SlopeMP starts offline. To host a multiplayer editing session, run:

```sh
bun run server
```

The server prints its WebSocket address and defaults to `ws://127.0.0.1:4174/`.
On first startup, the server writes these defaults to `run-server/config.toml`
in the launch directory. Edit that file to change the settings.

```toml
host = "127.0.0.1"
port = 4174
password = ""
save_interval_ms = 60000
# tls_cert = "cert.pem"
# tls_key = "key.pem"
```

Set a password to require it when joining. If your site runs over HTTPS, connect
with `wss://`. Set both TLS paths (relative to `run-server/` or absolute), or
terminate TLS at your reverse proxy.

Save your open song, then choose **File > Multiplayer...** in SlopeMP. Enter
the WebSocket address and password in their separate fields. The server song
becomes the active song. Import a song after joining to share it with the room.

Undo and redo apply to your own edits. A conflicting reversal reports the conflict
and skips that history entry.

If the connection drops, editing pauses while the client reconnects. The server
decides which edits are final. Rejected edits are discarded when the client
resynchronizes. Choose **Disconnect** in the multiplayer dialog to keep editing
the server-confirmed song locally.

The server creates the Git-ignored `run-server/` directory at startup and saves
`run-server/currentsong.slopemp` every 60 seconds by default and on graceful
shutdown (Ctrl+C or SIGTERM). On startup the server loads this file, creates a
blank song if the file is missing, or reports the error and exits if the file
is corrupt.

Run `bun run test:server` for the WebSocket server tests. The client integration
tests run with `bun run test:unit` and `bun run test:browser`.
