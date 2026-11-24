declare const self: ServiceWorkerGlobalScope;
declare const BUILD_REVISION: string;
declare const PRECACHE_PATHS: string[];

const scope = new URL(self.registration.scope);
const index = new URL("index.html", scope);
const cachePrefix = `slopemp:${scope.href}:`;
const cacheName = `${cachePrefix}${BUILD_REVISION}`;
const precacheURLs = new Set(PRECACHE_PATHS.map((path) => new URL(path, scope).href));

const install = async (): Promise<void> => {
  const cache = await caches.open(cacheName);
  await cache.addAll(Array.from(precacheURLs, (url) => new Request(url, { cache: "reload" })));
  // Online pages already use the latest build. Keep their offline fallback on
  // that build too, without waiting for every editor tab to close.
  await self.skipWaiting();
};

const activate = async (): Promise<void> => {
  const oldCaches = (await caches.keys()).filter(
    (name) => name.startsWith(cachePrefix) && name !== cacheName,
  );
  await Promise.all(oldCaches.map(async (name) => await caches.delete(name)));
  await self.clients.claim();
};

self.addEventListener("install", (event) => {
  event.waitUntil(install());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activate());
});

const serveNetworkFirst = async (request: Request, cacheURL: string): Promise<Response> => {
  try {
    return await fetch(request, { cache: "no-store" });
  } catch (error) {
    const cached = await caches.match(cacheURL, { cacheName });
    if (cached) {
      return cached;
    }
    throw error;
  }
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("Range")) {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== scope.origin) {
    return;
  }
  const appNavigation =
    request.mode === "navigate" &&
    (url.pathname === scope.pathname || url.pathname === index.pathname);
  const cacheURL = appNavigation ? index.href : url.href;
  if (precacheURLs.has(cacheURL)) {
    event.respondWith(serveNetworkFirst(request, cacheURL));
  }
});
