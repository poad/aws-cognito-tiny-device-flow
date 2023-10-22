module.exports = {
  env: {
    browser: true,
    es2022: true,
  },
  extends: ['plugin:import/typescript', 'prettier'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    'max-len': ['error', { code: 150 }],
    'prefer-destructuring': ['off'],
    'import/no-unresolved': ['off'],
    'import/extensions': ['off'],
    'import/prefer-default-export': ['off'],
  },
};
