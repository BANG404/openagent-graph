import { context, createHostClient, requireConversationContext } from "./lib/openagent-host.mjs";

const client = createHostClient();

export const host = (operation, args = {}) => client.call(operation, args);
export { context, requireConversationContext };
export const conversation = client.conversation;
export const branch = client.branch;
export const agent = client.agent;
export const roles = client.roles;
export const event = client.event;
export const locale = client.locale;
