const root = new URL("../dist/web/", import.meta.url);
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env["SLOPEMP_PORT"] ?? 4173),
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    const prefix = "/slopemp/";
    const relative = pathname.startsWith(prefix)
      ? pathname.slice(prefix.length)
      : pathname.slice(1);
    const file = Bun.file(new URL(relative === "" ? "index.html" : relative, root));
    if (file.name?.startsWith(root.pathname) !== true || !(await file.exists())) {
      return new Response("Not found", { status: 404, headers });
    }
    return new Response(file, { headers });
  },
});
