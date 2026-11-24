import { encodeWire } from "@slopemp/song";
import type { Transaction } from "@slopemp/song";
import { decodeServerPacket } from "@slopemp/song/protocol";
import type { ClientPacket, ServerPacket } from "@slopemp/song/protocol";

type PacketType = ServerPacket["type"];
export type Packet<T extends PacketType> = Extract<ServerPacket, { type: T }>;
export type Peer = {
  packets: ServerPacket[];
  send: (packet: ClientPacket) => void;
  next: <T extends PacketType>(
    type: T,
    match?: (packet: Packet<T>) => boolean,
  ) => Promise<Packet<T>>;
  close: () => void;
  closed: Promise<CloseEvent>;
};

const isPacket = <T extends PacketType>(packet: ServerPacket, type: T): packet is Packet<T> =>
  packet.type === type;

export const connect = async (url: URL): Promise<Peer> => {
  const address = new URL(url);
  address.protocol = "ws:";
  const socket = new WebSocket(address);
  const packets: ServerPacket[] = [];
  const closed = Promise.withResolvers<CloseEvent>();
  socket.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (typeof data !== "string") {
      throw new TypeError("Expected a text packet.");
    }
    packets.push(decodeServerPacket(data));
  });
  socket.addEventListener("close", (event) => {
    closed.resolve(event);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        reject(new Error("WebSocket open failed."));
      },
      {
        once: true,
      },
    );
  });
  const send = (packet: ClientPacket): void => {
    socket.send(encodeWire(packet));
  };
  const next = async <T extends PacketType>(
    type: T,
    match: (packet: Packet<T>) => boolean = () => true,
  ): Promise<Packet<T>> => {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const packet = packets.find((entry): entry is Packet<T> => isPacket(entry, type));
      if (packet === undefined) {
        await Bun.sleep(1);
      } else {
        packets.splice(packets.indexOf(packet), 1);
        if (match(packet)) {
          return packet;
        }
      }
    }
    throw new Error(
      `Expected ${type}. Received ${packets.map((packet) => packet.type).join(", ")}.`,
    );
  };
  return {
    packets,
    send,
    next,
    close: (): void => {
      socket.close();
    },
    closed: closed.promise,
  };
};

export const join = async (
  url: URL,
  password = "",
): Promise<{ peer: Peer; welcome: Packet<"welcome"> }> => {
  const peer = await connect(url);
  peer.send({ type: "hello", password });
  return { peer, welcome: await peer.next("welcome") };
};

export const submit = (
  peer: Peer,
  id: string,
  baseRevision: number,
  transaction: Transaction,
): void => {
  peer.send({ type: "submit", id, baseRevision, transaction });
};
