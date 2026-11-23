import { defineConfig } from "vitest/config";

// The browser SDK uses window, location and navigator, so tests run in jsdom.
export default defineConfig({ test: { environment: "jsdom" } });
