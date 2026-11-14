import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test-only: the real `vscode` module exists only inside the extension host; the bundle keeps it external.
    alias: { vscode: fileURLToPath(new URL("src/test/vscodeMock.ts", import.meta.url)) },
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node",
  },
});
