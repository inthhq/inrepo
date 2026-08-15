import type { DependencyGraph, ResolvedNode } from './resolve-dependency-graph.js';

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Render the resolved closure as a tree, printed before anything is vendored so
 * the pins can be reviewed first. A package that appears more than once is
 * expanded on its first occurrence only.
 */
export function renderDependencyTree(graph: DependencyGraph): string {
  const byModule = new Map(graph.nodes.map((node) => [node.module, node] as const));
  const root = byModule.get(graph.rootModule);
  if (!root) return '';

  const lines: string[] = [
    `${root.name}${root.version == null ? '' : ` ${root.version}`} (${shortCommit(root.commit)})`,
  ];
  const expanded = new Set<string>([root.module]);

  const walk = (node: ResolvedNode, prefix: string, path: Set<string>): void => {
    const children = Object.entries(node.resolvedDependencies);
    children.forEach(([dependency, edge], index) => {
      const child = byModule.get(edge.module);
      if (!child) return;
      const last = index === children.length - 1;
      const connector = last ? '└─ ' : '├─ ';
      const version = child.version == null ? '?' : child.version;
      const notes: string[] = [];
      if (child.reused) notes.push('already vendored');
      if (path.has(child.module)) notes.push('cycle');
      else if (expanded.has(child.module)) notes.push('deduped');
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

      lines.push(
        `${prefix}${connector}${dependency} ${edge.range} → ${version} (${shortCommit(child.commit)})${suffix}`,
      );

      if (path.has(child.module) || expanded.has(child.module)) return;
      expanded.add(child.module);
      walk(child, `${prefix}${last ? '   ' : '│  '}`, new Set([...path, child.module]));
    });
  };

  walk(root, '', new Set([root.module]));
  return lines.join('\n');
}
