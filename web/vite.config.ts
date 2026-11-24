import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :4200; the browser talks to Vite, which forwards /api and /media.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    proxy: { "/api": { target: "http://127.0.0.1:4200", changeOrigin: false }, "/media": { target: "http://127.0.0.1:4200", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: false },
});
