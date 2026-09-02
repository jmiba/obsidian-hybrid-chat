import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  platform: "node",
  target: "es2020",
  external: ["obsidian", "electron", "@codemirror/*", ...builtinModules],
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
