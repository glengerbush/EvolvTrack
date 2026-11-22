import adapter from '@sveltejs/adapter-static';
/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html'
    }),
    // Use SvelteKit's per-build version so cached HTML and chunks update together.
    serviceWorker: {
      register: false
    },
    alias: {
      $lib: 'src/lib'
    }
  }
};

export default config;
