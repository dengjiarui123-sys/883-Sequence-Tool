import { defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  server: {
    port: 8788,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
