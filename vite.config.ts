import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const cwd = process.cwd();

export default defineConfig({
  root: path.resolve(cwd, "client"),
  build: {
    outDir: path.resolve(cwd, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Two HTML entry points: landing page (/) and the React app (/app)
        index: path.resolve(cwd, 'client/index.html'),
        app: path.resolve(cwd, 'client/app.html'),
      },
      output: {
        manualChunks: {
          // Vendor chunks: long-term cacheable, only re-downloaded when their versions change
          'vendor-react': ['react', 'react-dom'],
          // @google/genai is dynamically imported in useLiveSession — Rollup
          // splits it automatically and it is NOT added to <link rel="modulepreload">,
          // so it does not block first paint or Time to Interactive on slow networks.
        },
      },
    },
  },
  server: {
    port: 5000,
    host: '0.0.0.0',
    strictPort: true,
  },
  plugins: [react()],
  define: {
    'process.env.API_KEY': JSON.stringify(process.env.GEMINI_API_KEY),
    'process.env.GEMINI_API_KEY': JSON.stringify(process.env.GEMINI_API_KEY)
  },
  resolve: {
    alias: {
      '@': path.resolve(cwd, 'client/src'),
    }
  }
});
