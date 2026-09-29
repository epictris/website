import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

// manifold-3d imports node:module only when it runs under Node; the browser
// build gets an empty module for it rather than a compatibility warning.
const noNodeModule: Plugin = {
  name: "no-node-module",
  apply: "build",
  enforce: "pre",
  resolveId: (id) => (id === "node:module" ? "\0no-node-module" : null),
  load: (id) => (id === "\0no-node-module" ? "export {};" : null),
};

// As server.ts does: / and /orthographic redirect to /orthographic/ (query kept),
// so the editor has one address in development as in production.
const editorAddress: Plugin = {
  name: "orthographic-editor-address",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const [path, query] = (req.url ?? "").split(/\?(.*)/s);
      if (path !== "/" && path !== "/orthographic") return next();
      res.statusCode = 301;
      res.setHeader("Location", `/orthographic/${query ? `?${query}` : ""}`);
      res.end();
    });
  },
};

// The editor builds to ONE self-contained HTML file: it works offline, and
// "Save working editor" can copy the running page into a portable file.
export default defineConfig({
  root: "orthographic",
  base: "/orthographic/",
  plugins: [editorAddress, noNodeModule, solid(), viteSingleFile()],
  server: {
    port: 3200,
    strictPort: true,
    // The HTTP API and the spec files are served by server.ts (scripts/dev.ts runs both).
    // xfwd passes the browser's host along, so links the API returns point back at Vite.
    proxy: Object.fromEntries(
      ["/orthographic/api", "/orthographic/mcp", "/orthographic/llms.txt", "/orthographic/schema.json"].map((path) => [
        path,
        { target: "http://localhost:3201", xfwd: true },
      ]),
    ),
  },
  build: {
    outDir: "../dist/orthographic",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
});
