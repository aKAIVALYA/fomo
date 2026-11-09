import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// one .env at the repo root; the browser only sees VITE_* vars
export default defineConfig(({ mode }) => ({
  root: "web",
  envDir: process.cwd(),
  plugins: [react()],
  server: { proxy: { "/api": `http://localhost:${loadEnv(mode, process.cwd(), "").PORT || 3000}` } },
}));
