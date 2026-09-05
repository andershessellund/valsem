import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'valsem',
  description:
    'Value semantics for JavaScript — structural equality, companion hashing, interning, and canonical value collections.',
  base: '/valsem/',
  lastUpdated: true,

  vite: {
    resolve: {
      alias: {
        // The demo imports the library exactly as an application would.
        // Run `pnpm build` first — the docs consume the compiled output.
        valsem: fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
      },
    },
  },

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Demo', link: '/demo' },
      { text: 'Benchmarks', link: '/benchmarks' },
      { text: 'API', link: '/api' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Equality, hashing, interning', link: '/guide/values' },
            { text: 'Value collections', link: '/guide/collections' },
            { text: 'produce', link: '/guide/produce' },
            { text: 'The mutable boundary', link: '/guide/boundary' },
            { text: 'Making your own types values', link: '/guide/extending' },
            { text: 'Hardening', link: '/guide/hardening' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'Undo-tree demo', link: '/demo' },
            { text: 'Benchmarks', link: '/benchmarks' },
            { text: 'API', link: '/api' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/andershessellund/valsem' }],

    search: { provider: 'local' },

    footer: {
      message: 'Apache-2.0 Licensed',
      copyright: '© Anders Hessellund Jensen',
    },

    outline: [2, 3],
  },
});
