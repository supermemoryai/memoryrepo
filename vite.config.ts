import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

// Alchemy appends its own Cloudflare plugin, so it is not listed here.
export default defineConfig({
  plugins: [agents(), react()],
});
