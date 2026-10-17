// Forge owns this file and replaces it on repair. The code scan command names it, so ESLint
// reads these settings and none from a file of the product. The command also does not honour
// an `eslint-disable` comment, so no comment in the code hides a finding.
import security from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/", ".next/", "dist/", "coverage/", ".forge/"] },
  {
    // The TypeScript parser reads the TypeScript and JSX files too.
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser },
  },
  // Only the security rules (eslint-plugin-security). A style rule never fails the code scan.
  security.configs.recommended,
  {
    rules: {
      // The one rule that is off: "security/detect-object-injection". It reports every
      // object[key] read, which is most indexing in TypeScript, so a person could not tell the
      // real findings from the rest. Every other rule of the plugin is on, except as below.
      "security/detect-object-injection": "off",
    },
  },
  {
    // Tests write and read temporary files by design, so a path in a test file is not a
    // finding. "security/detect-non-literal-fs-filename" stays on for the source of the product.
    files: ["test/**", "tests/**", "**/*.{test,spec}.*"],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
  {
    // A command-line app reads the paths its own user types, so that user is the trust boundary
    // and a path in its source is not a finding.
    files: ["src/**"],
    rules: { "security/detect-non-literal-fs-filename": "off" },
  },
];
