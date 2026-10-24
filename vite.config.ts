import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

const apiPort = process.env.API_PORT ?? "8787";

// HTTPS is required for phone camera/mic access over the LAN. Set HTTP=1 for laptop-only use.
const useHttps = process.env.HTTP !== "1";

export default defineConfig({
  root: "web",
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
    fs: { allow: [".."] },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
