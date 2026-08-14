import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  dts: false,
  format: ['esm'],
  splitting: false,
  // Harness packages are peers resolved by the host profile.
  external: [/^@deepseek-ai\//],
  sourcemap: true,
  clean: true,
})
