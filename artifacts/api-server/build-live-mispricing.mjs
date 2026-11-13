import { build } from 'esbuild';

await build({
  entryPoints: ['src/bot/btc/live-mispricing-index.cjs'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/live-mispricing.cjs',
  sourcemap: 'linked',
  packages: 'external',
});
