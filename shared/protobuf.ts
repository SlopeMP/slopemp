import { create, fromBinary, isMessage, toBinary } from "@bufbuild/protobuf";
import type { DescMessage, MessageInitShape } from "@bufbuild/protobuf";

import { invalid, packBytes, unpackBytes } from "./binary-frame";
import type { EffectSchema, InstrumentSchema } from "./generated/instrument_pb";
import { EffectParameterSchema, EnvelopeSchema } from "./generated/instrument_pb";
import type { SongSchema } from "./generated/song_pb";
import type { Effect, Envelope, Instrument } from "./instruments";
import type { Song } from "./model";

const safeKey = (key: string): string => {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    return invalid();
  }
  return key;
};

const effectParameter = (value: unknown): MessageInitShape<typeof EffectParameterSchema> => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { kind: { case: "number", value } };
  }
  if (typeof value === "boolean") {
    return { kind: { case: "boolean", value } };
  }
  if (typeof value === "string") {
    return { kind: { case: "text", value } };
  }
  return invalid();
};

const mapEffect = (effect: Effect): MessageInitShape<typeof EffectSchema> => ({
  ...effect,
  parameters: Object.fromEntries(
    Object.entries(effect.parameters).map(([key, value]) => [safeKey(key), effectParameter(value)]),
  ),
});

const mapEnvelope = (envelope: Envelope): MessageInitShape<typeof EnvelopeSchema> => ({
  ...envelope,
  sf2Modulators: envelope.sf2Modulators && { entries: envelope.sf2Modulators },
});

export const mapInstrument = (
  instrument: Instrument,
): MessageInitShape<typeof InstrumentSchema> => ({
  ...instrument,
  effects: instrument.effects.map(mapEffect),
  envelopes: instrument.envelopes.map(mapEnvelope),
  drums: instrument.drums.map((drum) => ({ ...drum, envelope: mapEnvelope(drum.envelope) })),
});

export const mapSong = (song: Song): MessageInitShape<typeof SongSchema> => ({
  ...song,
  channels: song.channels.map((channel) => ({
    ...channel,
    instruments: channel.instruments.map(mapInstrument),
    effects: channel.effects.map(mapEffect),
  })),
});

// Convert protobuf messages to editable objects. Explicitly present optional
// scalars are own properties, so absence survives this conversion.
const fromMessage = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(fromMessage);
  }
  if (value === null || typeof value !== "object") {
    return Number.isNaN(value) ? invalid() : value;
  }
  if (isMessage(value, EffectParameterSchema)) {
    const parameter = value.kind.value;
    return parameter === undefined || (typeof parameter === "number" && !Number.isFinite(parameter))
      ? invalid()
      : parameter;
  }
  let fields = value;
  if (isMessage(value, EnvelopeSchema) && value.sf2Modulators !== undefined) {
    fields = { ...value, sf2Modulators: value.sf2Modulators.entries };
  }
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => !(key === "$typeName" && isMessage(value)))
      .map(([key, child]: [string, unknown]) => [safeKey(key), fromMessage(child)]),
  );
};

const validateMessageValues = (value: unknown): void => {
  if (Number.isNaN(value)) {
    invalid();
  }
  if (Array.isArray(value)) {
    value.forEach(validateMessageValues);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      safeKey(key);
      validateMessageValues(child);
    }
  }
};

export const packMessage = <Schema extends DescMessage>(
  schema: Schema,
  init: MessageInitShape<Schema>,
): Uint8Array<ArrayBuffer> => {
  const message = create(schema, init);
  validateMessageValues(message);
  return packBytes(toBinary(schema, message));
};

export const unpackMessage = (schema: DescMessage, bytes: Uint8Array): unknown =>
  fromMessage(fromBinary(schema, unpackBytes(bytes), { readUnknownFields: false }));
