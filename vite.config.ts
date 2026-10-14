import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Prefix og/twitter image paths when VITE_SITE_ORIGIN is set (crawlers want https). */
function absoluteShareUrls(): Plugin {
  return {
    name: "absolute-share-urls",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const origin = (process.env.VITE_SITE_ORIGIN ?? "").replace(/\/$/, "");
        if (!origin) return html;
        return html.replace(
          /(content=")(\/[^"]*og\.jpg")/g,
          `$1${origin}$2`,
        );
      },
    },
  };
}

// COOP/COEP help DuckDB / wllama wasm threads where supported.
export default defineConfig({
  // VITE_BASE=./ for GitHub Pages (project or user site). Dev stays at /.
  base: process.env.VITE_BASE || "/",
  plugins: [react(), absoluteShareUrls()],
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm", "@wllama/wllama"],
  },
  assetsInclude: ["**/*.wasm"],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
