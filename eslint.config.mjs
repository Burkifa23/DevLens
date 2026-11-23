// Shared lint rules for the plain TypeScript packages. The Next.js apps add their
// own eslint.config.mjs (from create-next-app), which ESLint picks up first.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended);
