import path from 'path';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    commonjsOptions: {
      include: ['react', 'react-dom/client'],
    },
  },
  resolve: {
    alias: {
      react: path.resolve(__dirname, '../build/oss-stable/react'),
      'react-dom': path.resolve(__dirname, '../build/oss-stable/react-dom'),
      scheduler: path.resolve(__dirname, '../build/oss-stable/scheduler'),
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom/client'],
    force: true,
  },
});
