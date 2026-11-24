import { transformAsync } from "@babel/core";
import type { BunPlugin } from "bun";

// Bun handles bundling and TypeScript; Solid's compiler turns JSX into DOM operations.
export const solidPlugin: BunPlugin = {
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/u }, async ({ path }) => {
      const result = await transformAsync(await Bun.file(path).text(), {
        filename: path,
        configFile: false,
        babelrc: false,
        presets: [
          ["babel-preset-solid", { generate: "dom" }],
          ["@babel/preset-typescript", { onlyRemoveTypeImports: true }],
        ],
      });
      if (result?.code === undefined || result.code === null || result.code.length === 0) {
        throw new Error(`Could not compile Solid component: ${path}`);
      }
      return { contents: result.code, loader: "js" };
    });
  },
};
