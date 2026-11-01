import { isInside, physicalPath } from '@mazz/tools';

/**
 * Checks access against filesystem-resolved paths, including existing junctions
 * and symlinks. `isInside` uses path-segment boundaries, so a sibling such as
 * `workspace-private` is never treated as a child of `workspace`.
 */
export function isPhysicallyInside(root: string, candidate: string): boolean {
  try {
    return isInside(physicalPath(root), physicalPath(candidate));
  } catch {
    return false;
  }
}

export function isPhysicallyInsideAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPhysicallyInside(root, candidate));
}
