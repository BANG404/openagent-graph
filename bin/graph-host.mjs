export async function host(operation, args = {}) {
  const url = String(process.env.OPENAGENT_PLUGIN_HOST_URL ?? "").trim();
  const token = String(process.env.OPENAGENT_PLUGIN_HOST_TOKEN ?? "").trim();
  const pluginId = String(process.env.OPENAGENT_PLUGIN_ID ?? "graph").trim();
  if (!url || !token) throw new Error("OpenAgent plugin host bridge is unavailable");
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation, args: { plugin_id: pluginId, ...args } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) throw new Error(body.error || `host operation failed: ${response.status}`);
  return body.result;
}

export function context(args) {
  const openagent = args?._openagent;
  const conversationId = String(openagent?.conversation_id ?? "").trim();
  if (!conversationId) throw new Error("OpenAgent did not provide a conversation context");
  return { conversationId, branchId: openagent?.branch_id ? String(openagent.branch_id) : null };
}

