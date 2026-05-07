import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    {
        ignores: [
            "node_modules/**",
            "artifacts/**",
            "cache/**",
            "types/**",
            "coverage/**",
            "dist/**",
            "fhevmTemp/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        rules: {
            // Test fixtures hold ethers contract handles loosely typed via
            // the TypeChain output; tightening this would force a wide
            // refactor without a real type-safety win.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
        },
    },
    {
        // Chai property assertions (`expect(x).to.be.true`) read as bare
        // expressions to ESLint. Standard escape hatch for chai-style tests.
        files: ["test/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unused-expressions": "off",
        },
    },
    // Disables ESLint rules that would fight Prettier's formatter output.
    // Must come last so it overrides earlier rule entries.
    prettier,
);
