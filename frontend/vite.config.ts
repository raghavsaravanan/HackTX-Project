import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.API_PORT ?? "8787";
const camera = process.env.CAMERA_LINK_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/info": camera,
      "/api/pairing": camera,
      "/api/qr.svg": camera,
      "/api/frames": camera,
      "/api/analyze": camera,
      "/viewer": camera,
      "/static": camera,
      "/ws/": { target: camera, ws: true },
      "/api": `http://127.0.0.1:${apiPort}`
    }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
