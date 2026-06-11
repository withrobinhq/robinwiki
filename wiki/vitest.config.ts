import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      // Monorepo subpath exports — map to source for direct ts resolution
      // (mirrors core/vitest.config.ts). The shared package ships via
      // compiled dist at runtime, but tests resolve source so an unbuilt
      // workspace still runs.
      '@robin/shared/schemas/sidecar': resolve(
        __dirname,
        '../packages/shared/src/schemas/sidecar.ts',
      ),
      '@robin/shared/fixtures': resolve(
        __dirname,
        '../packages/shared/src/fixtures/index.ts',
      ),
      '@robin/shared/browser': resolve(__dirname, '../packages/shared/src/browser.ts'),
      '@robin/shared': resolve(__dirname, '../packages/shared/src/index.ts'),
      // Next.js-style path alias for wiki-local imports
      '@': resolve(__dirname, './src'),
    },
  },
})
