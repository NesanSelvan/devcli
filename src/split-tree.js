// Pure queries and transforms over a tab's binary split tree.
// Internal node: { dir: "row"|"col", sizeA, a, b }.  Leaf: { paneId, collapsed? }.
// Kept DOM-free so the collapse rules can be unit-tested on plain objects.

export const isLeafNode = (n) => !!n && n.paneId != null;

export const leafIdsOf = (node) =>
  isLeafNode(node) ? [node.paneId] : node ? [...leafIdsOf(node.a), ...leafIdsOf(node.b)] : [];

// return the leaf OBJECT (not a copy) so callers can flip flags on it in place
export function findLeaf(node, paneId) {
  if (!node) return null;
  if (isLeafNode(node)) return node.paneId === paneId ? node : null;
  return findLeaf(node.a, paneId) || findLeaf(node.b, paneId);
}

export const visibleLeafIds = (node) =>
  isLeafNode(node)
    ? node.collapsed ? [] : [node.paneId]
    : node ? [...visibleLeafIds(node.a), ...visibleLeafIds(node.b)] : [];

// a pane may collapse only while some OTHER pane stays visible — otherwise the
// tab would show nothing but strips and there'd be no way back except the menu
export function canCollapse(root, paneId) {
  const leaf = findLeaf(root, paneId);
  if (!leaf || leaf.collapsed) return false;
  return visibleLeafIds(root).some((id) => id !== paneId);
}

export function setCollapsed(root, paneId, value) {
  const leaf = findLeaf(root, paneId);
  if (leaf) leaf.collapsed = !!value;
}

// where focus should land when `paneId` collapses: the first still-visible leaf
export function nextFocusAfterCollapse(root, paneId) {
  return visibleLeafIds(root).find((id) => id !== paneId) ?? null;
}
