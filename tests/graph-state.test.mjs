import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendUpdate,
  newGraph,
  readGraph,
  reconcile,
  validateGraph,
  writeGraph,
} from "../bin/graph-state.mjs";

describe("Graph package state", () => {
  test("keeps sibling branch graphs independent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openagent-graph-"));
    try {
      const first = newGraph("conversation", "branch-a", "First", [
        { id: "one", task: "First task" },
      ]);
      const second = newGraph("conversation", "branch-b", "Second", [
        { id: "two", task: "Second task" },
      ]);
      first.nodes[0].status = "completed";
      reconcile(first);
      writeGraph(root, first);
      writeGraph(root, second);

      expect(readGraph(root, "conversation", "branch-a")).toMatchObject({
        objective: "First",
        status: "completed",
        nodes: [{ id: "one", status: "completed" }],
      });
      expect(readGraph(root, "conversation", "branch-b")).toMatchObject({
        objective: "Second",
        status: "running",
        nodes: [{ id: "two", status: "pending" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validates the DAG before execution and records opaque progress updates", () => {
    expect(() =>
      validateGraph([
        { id: "a", task: "A", depends_on: ["b"] },
        { id: "b", task: "B", depends_on: ["a"] },
      ]),
    ).toThrow("cycle");

    const graph = newGraph("conversation", "branch", "Objective", [
      { id: "a", task: "A" },
    ]);
    appendUpdate(graph, "created", { node_id: "a" });
    expect(graph.cursor).toBe(1);
    expect(graph.updates[0]).toMatchObject({
      type: "created",
      node_id: "a",
      graph: { title: "Objective", items: [{ id: "a", status: "pending" }] },
    });
  });
});
