import { defineDocsConfig } from 'leadtype';

export default defineDocsConfig({
  product: {
    name: 'inrepo',
    tagline:
      'Bring upstream source into your repo without submodules, forks, or mystery patches.',
    homepage: 'https://github.com/inthhq/inrepo#readme',
    repository: 'https://github.com/inthhq/inrepo',
    kind: 'library',
    category: 'DeveloperApplication',
  },
  llms: {
    sections: [
      {
        type: 'markdown',
        heading: 'Product Summary',
        body: [
          '- Pin upstream git repositories to exact commits.',
          '- Keep local package changes as reviewable overlay files.',
          '- Rebuild and verify generated checkouts from the same recipe.',
        ].join('\n'),
      },
      {
        type: 'links',
        heading: 'Best Starting Points',
        links: [
          {
            urlPath: '/docs',
            title: 'Overview',
            description: 'Why inrepo exists and what files to commit.',
          },
          {
            urlPath: '/docs/quickstart',
            title: 'Quickstart',
            description: 'Initialize inrepo, add a package, capture changes, and verify the result.',
          },
          {
            urlPath: '/docs/config',
            title: 'Config',
            description: 'Configuration fields, filtering, and generated files.',
          },
        ],
      },
    ],
  },
  navigation: [
    'index',
    'quickstart',
    {
      title: 'Reference',
      pages: ['config'],
    },
  ],
});
