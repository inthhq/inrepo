import { defineConfig } from 'rolldown';

export default defineConfig({
  input: './src/cli.ts',
  output: {
    file: 'dist/cli.mjs',
    format: 'esm',
  },
  platform: 'node',
});
