import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // Vite's default `localhost` host binds IPv6-only on Windows, while Chromium
    // dials 127.0.0.1 — the app then dies with ERR_CONNECTION_REFUSED against a
    // server that is up and printing a ready banner. Pinning the loopback
    // address makes the URL handed to Electron unambiguous. strictPort turns a
    // busy port into a clear error instead of a silent slide to 5174.
    server: { host: "127.0.0.1", port: 5173, strictPort: true },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
    },
    plugins: [react()],
  },
});
