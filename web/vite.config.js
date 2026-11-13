import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import { resolveApiUrl } from "./src/apiUrl.js";

// strictPort: the API's CORS allow-list names http://localhost:5173, so the dev server must not drift to another port.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_"), ...process.env };
  const apiUrl = resolveApiUrl({ vercelEnv: env.VERCEL_ENV, apiUrl: env.VITE_API_URL });
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    define: { __API_URL__: JSON.stringify(apiUrl) },
  };
});
