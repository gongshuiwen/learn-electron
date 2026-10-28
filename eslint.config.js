import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default defineConfig([
  globalIgnores(['out/**', 'dist/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
  },
])
