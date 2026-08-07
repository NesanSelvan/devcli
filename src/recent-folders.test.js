import { describe, it, expect } from "vitest";
import { RECENTS_CAP, addRecent, shortenHome, splitPath } from "./recent-folders.js";

describe("addRecent", () => {
  it("puts the newest path first", () => {
    expect(addRecent(["/a"], "/b")).toEqual(["/b", "/a"]);
  });

  it("moves an existing path to the front instead of duplicating it", () => {
    expect(addRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: RECENTS_CAP }, (_, i) => `/p${i}`);
    const out = addRecent(many, "/new");
    expect(out).toHaveLength(RECENTS_CAP);
    expect(out[0]).toBe("/new");
    expect(out).not.toContain(`/p${RECENTS_CAP - 1}`);
  });

  it("ignores empty or non-absolute paths", () => {
    expect(addRecent(["/a"], "")).toEqual(["/a"]);
    expect(addRecent(["/a"], "relative/dir")).toEqual(["/a"]);
    expect(addRecent(["/a"], null)).toEqual(["/a"]);
  });

  it("strips a trailing slash so /a and /a/ are one entry", () => {
    expect(addRecent(["/a"], "/a/")).toEqual(["/a"]);
  });

  it("does not mutate the input", () => {
    const list = ["/a"];
    addRecent(list, "/b");
    expect(list).toEqual(["/a"]);
  });

  it("returns a new array even when rejecting an invalid path", () => {
    const list = ["/a"];
    const result = addRecent(list, "");
    expect(result).not.toBe(list);
  });
});

describe("shortenHome", () => {
  it("replaces the home prefix with ~", () => {
    expect(shortenHome("/Users/x/Projects", "/Users/x")).toBe("~/Projects");
  });

  it("leaves unrelated paths alone", () => {
    expect(shortenHome("/opt/tools", "/Users/x")).toBe("/opt/tools");
  });

  it("does not match a partial folder name", () => {
    expect(shortenHome("/Users/xavier/p", "/Users/x")).toBe("/Users/xavier/p");
  });
});

describe("splitPath", () => {
  it("separates the basename from its parent", () => {
    expect(splitPath("/Users/x/Projects/devcli")).toEqual({
      base: "devcli", parent: "/Users/x/Projects",
    });
  });

  it("handles a root-level folder", () => {
    expect(splitPath("/opt")).toEqual({ base: "opt", parent: "/" });
  });
});
