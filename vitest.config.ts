import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test-only: the real `vscode` module exists only inside the extension host; the bundle keeps it external.
    alias: { vscode: path.resolve(__dirname, "src/test/vscodeMock.ts") },
  },
  test: {
    include: ["src/test/**/*.test.ts"],
    environment: "node",
  },
});
