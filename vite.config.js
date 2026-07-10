import { defineConfig } from "vite";

// Tauri expects a fixed dev port and un-cleared console so Rust logs stay visible.
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "esnext", outDir: "dist", emptyOutDir: true },
});
