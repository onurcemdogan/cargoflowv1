import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees` iç içe git worktree'leri barındırır: aynı deponun
  // ikinci bir kopyası. Lint edilirse hem her dosya iki kez görülür hem de
  // ikinci bir tsconfig kökü ortaya çıkar.
  globalIgnores(['dist', '.claude/worktrees']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      // Kök AÇIKÇA sabitlenir; aksi hâlde birden çok aday tsconfig kökü
      // bulunduğunda parser hangisini kullanacağını bilemeyip patlar.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
])
