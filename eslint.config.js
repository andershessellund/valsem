import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'docs/.vitepress/dist/', 'docs/.vitepress/cache/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The interning machinery reads/writes well-known symbols on foreign
      // objects; `as any` at those seams is deliberate and localized.
      '@typescript-eslint/no-explicit-any': 'off',
      // Registries are keyed by constructors, and `obj.constructor` is typed
      // `Function` in lib.d.ts — that is the honest type for those maps.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // Generator methods on the collections capture `this` in closures;
      // aliasing is the idiom (arrow generators do not exist).
      '@typescript-eslint/no-this-alias': 'off',
      // The `readonly [interned]: true = true` markers use a literal type
      // annotation deliberately: the annotation is the declared contract.
      '@typescript-eslint/prefer-as-const': 'off',
    },
  },
  {
    // The shipped source is held to the published feature floor
    // (docs/guide/requirements.md). `lib` in tsconfig.json keeps newer
    // built-ins out; these are the two pieces of ES2022 SYNTAX the floor
    // leaves out, which only lint can hold off: static blocks arrived later
    // than the rest of ES2022 (Safari 16.4), and top-level await is still
    // marked partial in Safari, and would break `require('valsem')`.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test-helpers.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'StaticBlock', message: 'Static blocks are outside the feature floor (docs/guide/requirements.md).' },
        {
          selector: 'AwaitExpression:not(:function AwaitExpression)',
          message: 'Top-level await is outside the feature floor (docs/guide/requirements.md).',
        },
      ],
    },
  },
);
