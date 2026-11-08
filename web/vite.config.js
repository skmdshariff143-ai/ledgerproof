import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// strictPort: the API's CORS allow-list names http://localhost:5173, so the dev server must not drift to another port.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
});
