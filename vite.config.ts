import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [vue()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // libsodium-wrappers ESM build references a non-existent libsodium.mjs;
      // use the CJS build instead which Vite will commonjs-transform correctly.
      "libsodium-wrappers": path.resolve("node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js"),
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
