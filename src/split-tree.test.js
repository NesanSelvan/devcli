import { describe, it, expect } from "vitest";
import {
  isLeafNode, leafIdsOf, findLeaf, visibleLeafIds,
  canCollapse, setCollapsed, nextFocusAfterCollapse,
} from "./split-tree.js";

// a row split of two leaves: [1 | 2]
const pair = () => ({ dir: "row", sizeA: 0.5, a: { paneId: "1" }, b: { paneId: "2" } });
// [1 | [2 / 3]]
const nested = () => ({
  dir: "row", sizeA: 0.5,
  a: { paneId: "1" },
  b: { dir: "col", sizeA: 0.5, a: { paneId: "2" }, b: { paneId: "3" } },
});

describe("isLeafNode", () => {
  it("is true for a leaf and false for a split", () => {
    expect(isLeafNode({ paneId: "1" })).toBe(true);
    expect(isLeafNode(pair())).toBe(false);
    expect(isLeafNode(null)).toBe(false);
  });
});

describe("leafIdsOf", () => {
  it("walks the tree left to right", () => {
    expect(leafIdsOf(nested())).toEqual(["1", "2", "3"]);
  });
});

describe("findLeaf", () => {
  it("returns the leaf node itself so callers can mutate it", () => {
    const root = nested();
    expect(findLeaf(root, "3")).toBe(root.b.b);
  });

  it("returns null for an unknown id", () => {
    expect(findLeaf(nested(), "nope")).toBe(null);
  });
});

describe("visibleLeafIds", () => {
  it("omits collapsed leaves", () => {
    const root = nested();
    root.b.a.collapsed = true;
    expect(visibleLeafIds(root)).toEqual(["1", "3"]);
  });
});

describe("canCollapse", () => {
  it("is false when the tab has a single pane", () => {
    expect(canCollapse({ paneId: "1" }, "1")).toBe(false);
  });

  it("is true when a sibling would stay visible", () => {
    expect(canCollapse(pair(), "1")).toBe(true);
  });

  it("is false when it would hide the last visible pane", () => {
    const root = pair();
    root.a.collapsed = true;
    expect(canCollapse(root, "2")).toBe(false);
  });

  it("is false for an unknown pane", () => {
    expect(canCollapse(pair(), "nope")).toBe(false);
  });
});

describe("setCollapsed", () => {
  it("sets and clears the flag on the right leaf", () => {
    const root = pair();
    setCollapsed(root, "2", true);
    expect(root.b.collapsed).toBe(true);
    setCollapsed(root, "2", false);
    expect(root.b.collapsed).toBe(false);
  });
});

describe("nextFocusAfterCollapse", () => {
  it("picks a still-visible leaf", () => {
    const root = nested();
    expect(nextFocusAfterCollapse(root, "1")).toBe("2");
  });

  it("skips leaves that are already collapsed", () => {
    const root = nested();
    root.b.a.collapsed = true;
    expect(nextFocusAfterCollapse(root, "1")).toBe("3");
  });

  it("returns null when nothing else is visible", () => {
    expect(nextFocusAfterCollapse({ paneId: "1" }, "1")).toBe(null);
  });
});
