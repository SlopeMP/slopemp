# Bundled assets and licenses

Fluid R3 Mono in `public/assets/` is bundled with the editor. Test audio
fixtures and their provenance are stored separately in `tests/assets/`.

## Software included in the browser build

SlopeMP uses GPL-3.0-only; the complete text is in the repository's `LICENSE`
and is also published as `dist/web/LICENSE`.

| Dependency | Version | Author | License text |
| --- | --- | --- | --- |
| fflate | 0.8.2 | Arjun Barrett | [MIT](fflate-MIT.txt) |
| @bufbuild/protobuf | 2.17.0 | Buf Technologies and Google | [Apache 2.0](protobuf-es-Apache-2.0.txt), [BSD 3-Clause](protobuf-es-BSD-3-Clause.txt) |
| SolidJS | 1.9.19 | Ryan Carniato | [MIT](solid-js-MIT.txt) |
| @breezystack/lamejs | 1.2.7 | Alex Zhukov and contributors | [LGPL 3.0](lamejs-LGPL-3.0.txt) |
| Tabler Icons | 3.52.0 | Paweł Kuna | [MIT](tabler-icons-MIT.txt) |
| [@wasm-audio-decoders/ogg-vorbis](https://github.com/eshaz/wasm-audio-decoders/tree/6fe55b9a29543d0a5a2d896338c39199a81d9a58/src/ogg-vorbis) | 0.1.20 | Ethan Halsall | [MIT](wasm-audio-decoders-MIT.txt) |
| [@wasm-audio-decoders/common](https://github.com/eshaz/wasm-audio-decoders/tree/e4f7eef8cda48719a884023582d8efc5b8d76f6c/src/common) | 9.0.7 | Ethan Halsall | [MIT](wasm-audio-decoders-MIT.txt) |
| [codec-parser](https://github.com/eshaz/codec-parser/tree/7834ca161922cd58f5e627d75b7dcc45dcce7e58) | 2.5.0 | Ethan Halsall | [LGPL 3.0 or later](codec-parser-LGPL-3.0.txt) |
| [simple-yenc](https://github.com/eshaz/simple-yenc/tree/3f87552b39abc2791f1e5331cb444a2726abeb86) | 1.0.4 | Ethan Halsall | [MIT](simple-yenc-MIT.txt) |
| [@eshaz/web-worker](https://github.com/eshaz/web-worker/tree/8d1e4bbf49f283fe59fdda20f633286148770696) | 1.2.2 | Google LLC | [Apache 2.0](web-worker-Apache-2.0.txt) |

The MP3 encoder source is available from
[shijinyu/lamejs](https://github.com/shijinyu/lamejs) and the exact dependency
version is recorded in `package.json` and `bun.lock`. No editor dependency code
was used to create the downloaded audio samples or SoundFont.

The SF3 decoder includes WebAssembly builds of libogg and libvorbis by the
Xiph.Org Foundation. [libogg source](https://github.com/xiph/ogg/tree/3069cc2bb44160982cdb21b2b8f0660c76b17572), [libvorbis source](https://github.com/xiph/vorbis/tree/84c023699cdf023a32fa4ded32019f194afcdad0), [libogg BSD 3-Clause license](libogg-BSD-3-Clause.txt), [libvorbis BSD 3-Clause license](libvorbis-BSD-3-Clause.txt).

The WebAssembly builds include code from Emscripten and musl. [Emscripten source](https://github.com/emscripten-core/emscripten), [Emscripten MIT or University of Illinois/NCSA licenses](emscripten-licenses.txt), [musl source](https://musl.libc.org/), [musl MIT license](musl-MIT.txt).

The decoder's shared runtime includes Mark Adler's puff 2.3. [puff source](https://github.com/eshaz/wasm-audio-decoders/tree/e4f7eef8cda48719a884023582d8efc5b8d76f6c/src/common/src/puff), [Zlib license](puff-Zlib.txt).

codec-parser is Copyright 2020-2023 Ethan Halsall. The LGPL applies to its
use in the SF3 decoder. [LGPL 3.0 text](codec-parser-LGPL-3.0.txt).

## Synthesis source

The TypeScript modules in `src/synth/` are adapted from UltraBox revision
`91b4bc1988e605ba5f5009f557e52ccb33975754`, copyright 2012–2022 John Nesky
and contributing authors, under the [MIT license](ultrabox-MIT.txt). They are
maintained directly with the application; the browser build includes this license.

The chorus processor, FFT, and bundled instrument presets use code or definitions
from BeepBox revision `355e510099d230d066d95074c16d748d59fe054c`, copyright
John Nesky and contributing authors. Preset definitions shared with UltraBox use
the UltraBox revision above. [BeepBox source](https://github.com/johnnesky/beepbox/tree/355e510099d230d066d95074c16d748d59fe054c),
[MIT license](beepbox-MIT.txt).

## Editor UI references

The editor layout, note and channel geometry, and channel gestures are adapted
from BeepBox, copyright John Nesky and contributing authors.
[BeepBox source](https://github.com/johnnesky/beepbox/tree/355e510099d230d066d95074c16d748d59fe054c),
[MIT license](beepbox-MIT.txt).

## Test fixtures

The chorus, note path, and spectrum waveform fixtures were generated from BeepBox
at the revision above using the generated chorus DSP, `PatternEditor._drawNote`,
and `SpectrumWaveState`, respectively.

Fluid R3 Mono is distributed under the MIT license; see [fluid-r3-mono.md](fluid-r3-mono.md). The bundled SF3 is unchanged from [LibreScore/sf3](https://github.com/LibreScore/sf3/blob/master/FluidR3Mono_GM.sf3.wasm) (the upstream `.wasm` extension is renamed to `.sf3`). SHA-256: `cfcd66d89e8386823400eca64934b14fbea7bf48ba1f00d21189af1262794ec2`.
