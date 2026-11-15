import { defineConfig } from "astro/config";

// A static site. The language server runs in a module worker that Vite bundles.
export default defineConfig({
  output: "static",
  devToolbar: { enabled: false },
  vite: {
    worker: { format: "es" },
  },
});
