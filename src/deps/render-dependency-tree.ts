import { runtimeEdges, type DependencyGraph, type ResolvedNode } from './resolve-dependency-graph.js';

function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Render the resolved closure as a tree, printed before anything is vendored so
 * the pins can be reviewed first. A package that appears more than once is
 * expanded on its first occurrence only.
 */
export function renderDependencyTree(graph: DependencyGraph): string {
  const byName = new Map(graph.nodes.map((node) => [node.name, node] as const));
  const root = byName.get(graph.rootName);
  if (!root) return '';

  const lines: string[] = [
    `${root.name}${root.version == null ? '' : ` ${root.version}`} (${shortCommit(root.commit)})`,
  ];
  const expanded = new Set<string>([root.name]);

  const walk = (node: ResolvedNode, prefix: string, path: Set<string>): void => {
    const children = runtimeEdges(node.name, node.dependencies).filter((edge) =>
      byName.has(edge.dependency),
    );
    children.forEach((edge, index) => {
      const child = byName.get(edge.dependency);
      if (!child) return;
      const last = index === children.length - 1;
      const connector = last ? '└─ ' : '├─ ';
      const version = child.version == null ? '?' : child.version;
      const notes: string[] = [];
      if (child.reused) notes.push('already vendored');
      if (path.has(child.name)) notes.push('cycle');
      else if (expanded.has(child.name)) notes.push('deduped');
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

      lines.push(
        `${prefix}${connector}${child.name} ${edge.range} → ${version} (${shortCommit(child.commit)})${suffix}`,
      );

      if (path.has(child.name) || expanded.has(child.name)) return;
      expanded.add(child.name);
      walk(child, `${prefix}${last ? '   ' : '│  '}`, new Set([...path, child.name]));
    });
  };

  walk(root, '', new Set([root.name]));
  return lines.join('\n');
}
