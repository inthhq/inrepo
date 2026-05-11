import { defineDocsConfig } from 'leadtype';

export default defineDocsConfig({
  product: {
    name: 'inrepo',
    summary:
      'Bring upstream source into your repo without submodules, forks, or mystery patches.',
    bullets: [
      'Pin upstream git repositories to exact commits.',
      'Keep local package changes as reviewable overlay files.',
      'Rebuild and verify generated checkouts from the same recipe.',
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
      description: 'Configuration fields, filtering, and generated files.',
    },
  ],
});
