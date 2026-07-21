import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          root: "./apps/server",
        },
      },
      {
        extends: "./apps/web/vitest.config.ts",
        test: {
          name: "web",
          root: "./apps/web",
        },
      },
      {
        test: {
          name: "contracts",
          root: "./packages/contracts",
        },
      },
    ],
  },
});
