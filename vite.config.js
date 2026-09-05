import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// بيئات المعاينة السحابية (Qwen / Codespaces / Gitpod / StackBlitz) لا يمرّ عبرها
// WebSocket الخاص بـ HMR على المنفذ 3000 — نعطّله هناك فيتوقف خطأ ERR_CONNECTION_TIMED_OUT.
// في التطوير المحلي يبقى HMR يعمل كالمعتاد.
const isPreviewEnv =
  ["PREVIEW", "QWEN_PREVIEW", "CODESPACE_NAME", "STACKBLITZ", "GITPOD_WORKSPACE_ID"].some(
    (k) => process.env[k]
  ) || process.env.HMR === "false";

export default defineConfig({
  // مسارات نسبية حتى يعمل الموقع من أي مجلد فرعي (مثل GitHub Pages: /milanochat/)
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    hmr: isPreviewEnv ? false : { port: 3000 },
  },
});
