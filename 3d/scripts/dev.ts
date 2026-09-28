// Development: Vite serves the editor with hot reload on :3200 and proxies the
// API and spec files to server.ts on :3201, whose renderer drives Vite's page.

import { spawn } from "bun";

const api = spawn(["bun", "--watch", "server.ts"], {
  env: { ...process.env, PORT: "3201", API_ONLY: "1", EDITOR_URL: "http://localhost:3200/orthographic/" },
  stdout: "inherit",
  stderr: "inherit",
});
const vite = spawn(["bunx", "vite"], { stdout: "inherit", stderr: "inherit" });

const stop = () => {
  api.kill();
  vite.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([api.exited, vite.exited]);
stop();
