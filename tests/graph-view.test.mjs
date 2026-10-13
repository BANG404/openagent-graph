import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newGraph, writeGraph } from "../bin/graph-state.mjs";
import { readGraphView } from "../bin/graph-view.mjs";

test("diagram preserves dependency paths and exact parent/child branch scope without mutating state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "graph-view-"));
  try {
    const graph = newGraph("parent", "branch", "Diagram", [
      { id: "root", task: "Research" },
      { id: "left", task: "Implement", depends_on: ["root"] },
      { id: "right", task: "Review", depends_on: ["root"] },
      { id: "merge", task: "Deliver", depends_on: ["left", "right"] },
    ]);
    Object.assign(graph.nodes[1], { child_conv_id: "child", child_branch_id: "child-branch", status: "completed", result: "<script>result</script>" });
    writeGraph(root, graph);
    writeFileSync(path.join(root, "graphs", "broken.json"), "{");
    const before = JSON.stringify(graph);
    const parent = readGraphView(root, "parent", "branch");
    expect(parent.nodes[3].depends_on).toEqual(["left", "right"]);
    expect(parent.nodes[1].result).toBe("<script>result</script>");
    expect(readGraphView(root, "child", "child-branch")).toEqual(parent);
    expect(readGraphView(root, "parent", "sibling")).toBeNull();
    expect(readGraphView(root, "child", "sibling")).toBeNull();
    expect(readGraphView(root, "unrelated", "branch")).toBeNull();
    expect(JSON.stringify(graph)).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
