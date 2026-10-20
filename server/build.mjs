// Bundles the server (and @gb/shared) into a single ESM file with no runtime node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: { server: 'src/index.ts', backup: 'src/backup.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
  // Some CommonJS deps (fastify's) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
