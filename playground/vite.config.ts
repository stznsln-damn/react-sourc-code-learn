import path from 'path';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // react: path.resolve(
      //   __dirname,
      //   '../build/node_modules/react/cjs/react.development.js',
      // ),
      'react-dom/client': path.resolve(
        __dirname,
        '../build/node_modules/react-dom/cjs/react-dom-client.development.js',
      ),
      // 'react/jsx-dev-runtime': path.resolve(
      //   __dirname,
      //   '../build/node_modules/react/cjs/react-jsx-dev-runtime.development.js',
      // ),
      // 'react/jsx-runtime': path.resolve(
      //   __dirname,
      //   '../build/node_modules/react/cjs/react-jsx-runtime.development.js',
      // ),
    },
  },
});
