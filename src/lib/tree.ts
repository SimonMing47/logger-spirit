import type { IndexedFile, TreeNode } from "@/types/logspace";
import { splitPath } from "@/lib/path";

type InternalNode = {
  name: string;
  path: string;
  kind: "dir" | "file";
  size?: number;
  textLike?: boolean;
  children: Map<string, InternalNode>;
};

function toTreeNode(node: InternalNode, rootId: string): TreeNode {
  const base: TreeNode = {
    id: `${rootId}:${node.path || "/"}`,
    name: node.name,
    path: node.path,
    kind: node.kind,
    size: node.size,
    textLike: node.textLike,
  };

  if (node.kind === "dir") {
    const children = Array.from(node.children.values())
      .map((child) => toTreeNode(child, rootId))
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "dir" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    base.children = children;
  }

  return base;
}

export function buildRootTree(rootId: string, rootName: string, files: IndexedFile[]): TreeNode {
  const root: InternalNode = {
    name: rootName,
    path: "",
    kind: "dir",
    children: new Map(),
  };

  for (const file of files) {
    const segments = splitPath(file.path);
    let current = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      const currentPath = segments.slice(0, index + 1).join("/");
      const existing = current.children.get(segment);

      if (existing) {
        current = existing;
        return;
      }

      const created: InternalNode = {
        name: segment,
        path: currentPath,
        kind: isLeaf ? "file" : "dir",
        size: isLeaf ? file.size : undefined,
        textLike: isLeaf ? file.textLike : undefined,
        children: new Map(),
      };

      current.children.set(segment, created);
      current = created;
    });
  }

  return toTreeNode(root, rootId);
}
