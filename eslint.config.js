import js from "@eslint/js";
import tseslint from "typescript-eslint";

import productRules from "./eslint.product.js";

const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
const baseRules = new Set(
  base.flatMap((config) => Object.keys(config.rules ?? {})),
);

// The product's rules come first and the base rules last, and a product setting
// for a rule the base sets is left out. So the base rules win.
const product = tseslint.config(...productRules).map((config) =>
  config.rules
    ? {
        ...config,
        rules: Object.fromEntries(
          Object.entries(config.rules).filter(([rule]) => !baseRules.has(rule)),
        ),
      }
    : config,
);

export default [
  { ignores: ["node_modules/", "dist/", "coverage/", ".forge/"] },
  ...product,
  ...base,
];
