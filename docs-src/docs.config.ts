import { defineDocsConfig } from 'leadtype';

export default defineDocsConfig({
  product: {
    name: 'inrepo',
    summary:
      'A small CLI for vendoring upstream git repositories into a repo as pinned, reviewable source.',
    bullets: [
      'Declare upstream packages in inrepo.json or package.json#inrepo.',
      'Rebuild generated checkouts from a lockfile plus committed overlay files.',
      'Verify in CI that vendored trees still match the recipe.',
    ],
    bestStartingPoints: [
      { urlPath: '/docs', title: 'Overview' },
      { urlPath: '/docs/quickstart', title: 'Quickstart' },
      { urlPath: '/docs/config', title: 'Config' },
    ],
  },
  groups: [
    {
      slug: 'get-started',
      title: 'Get Started',
      description: 'Core workflow and first commands.',
    },
    {
      slug: 'reference',
      title: 'Reference',
      description: 'Configuration fields and generated files.',
    },
  ],
});
