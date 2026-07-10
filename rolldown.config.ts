import { defineConfig } from 'rolldown';

export default defineConfig({
  input: './src/cli.ts',
  output: {
    codeSplitting: false,
    file: 'dist/cli.mjs',
    format: 'esm',
  },
  platform: 'node',
});
