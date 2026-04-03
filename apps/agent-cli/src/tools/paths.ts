import path from "node:path";

/** 解析路径并确保落在 workspaceRoot 之下（防越界读写） */
export function resolveInWorkspace(
  relOrAbs: string,
  workspaceRoot: string,
): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(relOrAbs)
    ? path.normalize(relOrAbs)
    : path.resolve(root, relOrAbs);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`拒绝访问工作区外的路径: ${relOrAbs}`);
  }
  return resolved;
}
