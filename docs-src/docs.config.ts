import { defineDocsConfig } from "leadtype";

export default defineDocsConfig({
  // The shipped agent skill is hand-written at skills/inrepo/SKILL.md; keep
  // leadtype from generating (and overwriting) a generic root SKILL.md.
  agents: {
    skills: { docsSkill: false },
  },
  llms: {
    sections: [
      {
        body: [
          "- Pin upstream git repositories to exact commits.",
          "- Keep local package changes as reviewable overlay files.",
          "- Rebuild and verify generated checkouts from the same recipe.",
        ].join("\n"),
        heading: "Product Summary",
        type: "markdown",
      },
      {
        heading: "Best Starting Points",
        links: [
          {
            description: "Why inrepo exists and what files to commit.",
            title: "Overview",
            urlPath: "/docs",
          },
          {
            description:
              "Initialize inrepo, add a package, capture changes, and verify the result.",
            title: "Quickstart",
            urlPath: "/docs/quickstart",
          },
          {
            description:
              "The --json envelope, exit and error codes, the agent loop, and the update conflict loop.",
            title: "Using inrepo from agents and scripts",
            urlPath: "/docs/agents",
          },
          {
            description:
              "Every command's flags, writes, --dry-run support, JSON data shape, and error codes.",
            title: "Commands",
            urlPath: "/docs/commands",
          },
          {
            description:
              "Configuration fields, filtering, and generated files.",
            title: "Config",
            urlPath: "/docs/config",
          },
        ],
        type: "links",
      },
    ],
  },
  navigation: [
    "index",
    "quickstart",
    "agents",
    {
      pages: ["commands", "config"],
      title: "Reference",
    },
  ],
  product: {
    category: "DeveloperApplication",
    homepage: "https://github.com/inthhq/inrepo#readme",
    kind: "library",
    name: "inrepo",
    repository: "https://github.com/inthhq/inrepo",
    tagline:
      "Bring upstream source into your repo without submodules, forks, or mystery patches.",
  },
});
