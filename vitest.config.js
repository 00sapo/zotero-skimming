import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["bootstrap.js", "content/**/*.js"],
      thresholds: { perFile: true, lines: 90, functions: 90, statements: 90 }
    }
  }
});
