import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/ftp/app/',
  plugins: [react(), {
    name: 'publish-runtime-art-only',
    closeBundle() {
      const directory = resolve('public/art');
      const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
      const destination = resolve('dist/art');
      mkdirSync(destination, { recursive: true });
      for (const name of ['manifest.json', ...manifest.scenes.map((item: { src: string }) => item.src), ...manifest.characters.map((item: { src: string }) => item.src), manifest.pet.src]) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Unexpected artwork filename');
        copyFileSync(resolve(directory, name), resolve(destination, name));
      }
    },
  }],
  server: { proxy: { '/ftp/api': { target: 'http://127.0.0.1:9090', changeOrigin: false } } },
  build: { target: 'es2022', sourcemap: true, copyPublicDir: false },
});
