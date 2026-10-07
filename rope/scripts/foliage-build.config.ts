import { defineConfig, mergeConfig } from "vite";
import config from "../vite.config";

// Verify the production bundles without copying unrelated, locked background exports.
export default mergeConfig(config, defineConfig({
  build: { copyPublicDir: false, outDir: "artifacts/foliage-bundle-check" },
}));
