import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Honor the established `_` prefix convention for intentionally-unused
      // names — used across callback signatures (e.g. `(state, _dsId) => ...`)
      // where a parameter must keep its position but isn't read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Controls are built from src/ui/ (or React Aria), which gives them the
    // keyboard and screen-reader behavior a raw element lacks. The few raw
    // elements that must stay each carry a disable comment saying why; that
    // grep is the allowlist.
    files: ['src/**/*.tsx'],
    ignores: ['src/ui/**', 'src/**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]',
          message:
            'Use a control from src/ui/ (Button, IconButton, UnstyledButton, TextField, NumberField, Select, Checkbox, Switch, Slider) instead of a raw element.',
        },
        {
          selector:
            'JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name="role"][value.value=/^(button|checkbox|combobox|link|listbox|menu|menuitem|menuitemcheckbox|menuitemradio|option|radio|slider|spinbutton|switch|tab|textbox)$/]',
          message:
            'A raw element given a control role lacks the keyboard behavior the role promises. Use a control from src/ui/.',
        },
      ],
    },
  },
  {
    // The entry point is never hot-reloaded, so the fast-refresh export rule does not apply to it.
    files: ['src/main.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
])
