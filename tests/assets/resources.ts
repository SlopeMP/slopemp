import type { Resource } from "../../src/model";

export const TEST_RESOURCES: Resource[] = [
  {
    id: "test-piano-c4",
    url: "./test-assets/piano-C4.wav",
    rootKey: 60,
    start: 0,
    loopStart: 0,
    loopEnd: 653_483,
    mode: "Play Once",
    backwards: false,
    metadata: { license: "CC0-1.0" },
  },
  {
    id: "test-flute-c4",
    url: "./test-assets/flute-C4.wav",
    rootKey: 60,
    start: 0,
    loopStart: 0,
    loopEnd: 334_863,
    mode: "Play Once",
    backwards: false,
    metadata: { license: "CC0-1.0" },
  },
  {
    id: "test-florestan",
    url: "./test-assets/florestan-subset.sf2",
    metadata: { license: "Public Domain" },
  },
];
