import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.API_PORT ?? "8787";
const camera = process.env.CAMERA_LINK_URL ?? "http://127.0.0.1:8000";
const game = `http://127.0.0.1:${apiPort}`;

// One laptop address (http://localhost:5173) for everything: the hub, the camera server's QR code
// and frames, and the game API. The phone talks to the camera server directly.
// Order matters: the first matching prefix wins, so the camera server's /api routes come first.
export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api/info": camera,
      "/api/qr.svg": camera,
      "/api/frames": camera,
      "/api/analyze": camera,
      "/static": camera,
      "/ws/": { target: camera, ws: true },
      "/api": game,
    },
    fs: { allow: [".."] },
  },
  // three.js lives in the lazily loaded 3D Quest Map chunk (~580 kB), so the first page stays small.
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 650 },
});
