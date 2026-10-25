# Lumi frontend

The complete React UI for Lumi lives in this folder. It preserves the existing
camera, quest, voice, vision, and event-stream API contracts while replacing the
product journey and visual design.

## Run locally

```bash
npm install
npm run dev
```

Vite serves the app at `http://localhost:5173` and proxies the existing services:

- game API: `http://127.0.0.1:8787`
- camera service: `http://127.0.0.1:8000`

Set `API_PORT` or `CAMERA_LINK_URL` before starting Vite to override those defaults.

## Build

```bash
npm run build
```

The production bundle is written to `frontend/dist`.
