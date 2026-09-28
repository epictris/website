import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";

// The editor builds to ONE self-contained HTML file: it works offline, and
// "Save working editor" can copy the running page into a portable file.
export default defineConfig({
  root: "orthographic",
  base: "/orthographic/",
  plugins: [solid(), viteSingleFile()],
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
