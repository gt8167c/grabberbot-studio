import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: dist/index.html is fully self-contained, so it can be
// double-clicked on macOS or Windows with no server, and published as an artifact.
export default defineConfig({
  plugins: [viteSingleFile()],
  server: { port: 5173, strictPort: true },
  build: { chunkSizeWarningLimit: 10000, target: 'es2022' },
});
