import adapter from '@sveltejs/adapter-static';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html'
    }),
    version: {
      name: pkg.version
    },
    serviceWorker: {
      register: false
    },
    alias: {
      $lib: 'src/lib'
    }
  }
};

export default config;
