import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      // 로컬 개발: wrangler dev (8787) 로 프록시 → 브라우저가 외부 소스를 직접 치지 않는다(§1.3)
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
});
