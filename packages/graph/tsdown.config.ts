import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts'],
  format: 'esm',
  dts: true,
  unbundle: true,
  outDir: 'dist',
  clean: false,
})
