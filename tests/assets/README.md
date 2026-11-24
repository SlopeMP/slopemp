# Test audio assets

These unchanged fixtures are used only by tests and benchmarks. Browser tests
serve them through Playwright routes; production builds do not include them.

## Audio clips

Piano C4 is from [Versilian Community Sample Library](https://github.com/sgossner/VCSL/tree/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e), and flute C4 is from [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE/tree/440300901dfe9275fd84e0b7763af1f8443ae62e). Both repositories dedicate their samples under CC0 1.0. Files are unchanged.

| File         | Source                                                                                                                                                                                        | SHA-256                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| piano-C4.wav | [Kawai grand piano C4](https://github.com/sgossner/VCSL/blob/c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e/Chordophones/Zithers/Grand%20Piano%2C%20Kawai/Sustains/GPiano_sus_C4_v2_rr1_Player.wav) | `69845de40a38ed6501746520f9f385ae56200a4372faed48178e64a32a75e58c` |
| flute-C4.wav | [Flute C4](https://github.com/sgossner/VSCO-2-CE/blob/440300901dfe9275fd84e0b7763af1f8443ae62e/Woodwinds/Flute/susvib/LDFlute_susvib_C4_v1_1.wav)                                             | `e88a0ff35e6b8c29fd88bc778a4c817d955b2c3a2934def97a7d093b72e2ae97` |

## SoundFont

According to the embedded copyright field in `florestan-subset.sf2`, this
SoundFont is Public Domain. It contains 17 presets from Florestan by Nando
Florestan. The file was downloaded unchanged from the TinySoundFont repository;
SlopeMP does not include the TinySoundFont software.

| Test file                           | Source file                                                                                                                                 | Bytes  | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `tests/assets/florestan-subset.sf2` | [Florestan subset](https://github.com/schellingb/TinySoundFont/blob/853a0a171759f1ddba0de1442133a75912bbeffa/examples/florestan-subset.sf2) | 531786 | `1d890349a4bf0ae8d932000f0157633c03b81e127e479e069238ff382db44a32` |

[florestan-subset.txt](florestan-subset.txt) retains the source revision,
download date, embedded license notice, and author's website.
