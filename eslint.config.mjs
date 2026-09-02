import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig(
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "main.js",
    "main.js.map",
    "coverage/**",
    "work/**",
    "outputs/**",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "versions.json",
  ]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "scripts/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "obsidianmd/ui/sentence-case": ["warn", {
        acronyms: ["API", "HTTP", "HTTPS", "IANA", "MCP", "OHS", "RAG", "STDIO", "UTC", "URL", "YAML"],
        brands: ["German", "Hybrid Chat", "Markdown", "Obsidian", "OpenAI", "SecretStorage"],
      }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
    },
  },
);
