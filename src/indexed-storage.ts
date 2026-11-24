const storeName = "state";
let database: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;

const openDatabase = async (): Promise<IDBDatabase> => {
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = globalThis.indexedDB.open("slopemp", 1);
      let blocked = false;
      request.addEventListener("blocked", () => {
        blocked = true;
        reject(new Error("Another tab is blocking browser storage."));
      });
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore(storeName);
      });
      request.addEventListener("error", () => {
        reject(request.error ?? new Error("Could not open browser storage."));
      });
      request.addEventListener("success", () => {
        const opened = request.result;
        if (blocked) {
          opened.close();
          return;
        }
        const forget = (): void => {
          if (database === opened) {
            database = null;
          }
        };
        opened.addEventListener("close", forget);
        opened.addEventListener("versionchange", () => {
          opened.close();
          forget();
        });
        database = opened;
        resolve(opened);
      });
    });
  } finally {
    opening = null;
  }
};

type Key =
  "asset-favorites" | "clipboard.instrument" | "clipboard.pattern" | "preferences" | "session";

const transact = async <Result>(
  mode: "readonly" | "readwrite",
  run: (store: IDBObjectStore) => IDBRequest<Result>,
): Promise<Result> => {
  // An open connection lets pagehide start the transaction before returning.
  const connection = database ?? (await (opening ??= openDatabase()));
  const transaction = connection.transaction(storeName, mode);
  const request = run(transaction.objectStore(storeName));
  return await new Promise<Result>((resolve, reject) => {
    transaction.addEventListener("complete", () => {
      resolve(request.result);
    });
    transaction.addEventListener("abort", () => {
      reject(transaction.error ?? new Error("Browser storage transaction was aborted."));
    });
    if (mode === "readwrite") {
      // Start committing even if navigation prevents request events from being delivered.
      transaction.commit();
    }
  });
};

export const readStoredValue = async (key: Key): Promise<unknown> =>
  await transact<unknown>("readonly", (store) => store.get(key));

export const writeStoredValue = async (key: Key, value: Uint8Array): Promise<void> => {
  await transact("readwrite", (store) => store.put(value, key));
};
