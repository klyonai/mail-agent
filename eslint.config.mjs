import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', '**/state/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest', sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', fetch: 'readonly', AbortSignal: 'readonly',
        AbortController: 'readonly', Response: 'readonly', Request: 'readonly',
        Headers: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly', structuredClone: 'readonly'
      }
    },
    rules: { complexity: ['error', 12] }
  }
];
