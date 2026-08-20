// BranchNavigator 仍会递归遍历，因此限制响应树深度。
const MAX_PROJECTED_TREE_DEPTH = 200;

export interface ProjectableTreeNode {
  entry: { id: string };
  children: ProjectableTreeNode[];
  compressedEntryIds?: string[];
}

function collectKeptNodes(nodes: ProjectableTreeNode[]): Set<ProjectableTreeNode> {
  const keep = new Set<ProjectableTreeNode>();
  const roots = new Set(nodes);
  const seen = new Set<ProjectableTreeNode>();
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (roots.has(node) || node.children.length !== 1) keep.add(node);
    for (const child of node.children) stack.push(child);
  }
  return keep;
}

function cloneNode(node: ProjectableTreeNode, compressedEntryIds?: string[]): ProjectableTreeNode {
  return {
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
  };
}

function flattenKeptDescendants(
  source: ProjectableTreeNode,
  keep: Set<ProjectableTreeNode>,
): ProjectableTreeNode[] {
  const result: ProjectableTreeNode[] = [];
  const pending = [{ node: source, compressedEntryIds: [] as string[] }];
  const seen = new Set<ProjectableTreeNode>();
  while (pending.length > 0) {
    const { node, compressedEntryIds } = pending.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    if (keep.has(node)) result.push(cloneNode(node, compressedEntryIds));
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({
        node: node.children[i],
        compressedEntryIds: keep.has(node) ? [] : [...compressedEntryIds, node.entry.id],
      });
    }
  }
  return result;
}

/** 将完整会话树投影为浅层导航树：保留根、分叉点和叶子，并压缩单子节点链。 */
export function projectSessionTree<T extends ProjectableTreeNode>(nodes: T[]): T[] {
  const keep = collectKeptNodes(nodes);
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks: Array<{ source: ProjectableTreeNode; projected: ProjectableTreeNode; depth: number }> =
    nodes.map((source, index) => ({ source, projected: projectedRoots[index], depth: 1 }));

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;
    for (const sourceChild of source.children) {
      let child = sourceChild;
      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        projected.children.push(...flattenKeptDescendants(child, keep));
        continue;
      }
      const compressedEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
      }
      if (!keep.has(child)) continue;
      const projectedChild = cloneNode(child, compressedEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots as T[];
}
