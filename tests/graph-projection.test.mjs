import { newGraph } from "../bin/graph-state.mjs";
import { publishGraph } from "../bin/lib/graph-bridge.mjs";

test("a missing child does not block other branches; events follow successful persistence", async () => {
  const graph = newGraph("parent", "parent-branch", "Objective", [{ id: "one", task: "One" }, { id: "two", task: "Two" }]);
  Object.assign(graph.nodes[0], { child_conv_id: "deleted", child_branch_id: "deleted-branch" });
  Object.assign(graph.nodes[1], { child_conv_id: "child", child_branch_id: "original-branch" });
  const saved = [], events = [];
  await expect(publishGraph({
    conversation: { async setFlow(convId, branchId, flow) {
      if (convId === "deleted") throw new Error("not found");
      saved.push({ convId, branchId, flow });
    } },
    event: { async emit(name, payload) {
      expect(saved.some((item) => item.convId === payload.conv_id && item.branchId === payload.branch_id)).toBe(true);
      events.push(payload);
    } },
  }, graph)).rejects.toThrow("publication failed");
  expect(saved.map((item) => [item.convId, item.branchId])).toEqual([["parent", "parent-branch"], ["child", "original-branch"]]);
  expect(saved[0].flow).toEqual(saved[1].flow);
  expect(events.map((item) => item.conv_id)).toEqual(["parent", "child"]);
});
