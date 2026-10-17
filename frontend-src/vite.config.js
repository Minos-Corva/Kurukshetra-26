import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Output to the frontend/ directory so the Express server can serve it at /app/
  build: {
    outDir: "../frontend",
    emptyOutDir: true,
  },
  // Vite dev server proxies API requests to the backend so you can develop without CORS issues
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  // Matches Express serving at /app/ — set base only for production build
  base: "/app/",
});
