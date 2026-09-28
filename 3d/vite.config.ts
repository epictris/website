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
    proxy: {
      "/orthographic/api": "http://localhost:3201",
      "/orthographic/llms.txt": "http://localhost:3201",
      "/orthographic/schema.json": "http://localhost:3201",
    },
  },
  build: {
    outDir: "../dist/orthographic",
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
});
