/**
 * @cm/shared — domain + wire types and zod schemas shared by @cm/server and
 * @cm/client. Zod is the single source of truth; every TS type is `z.infer`-ed
 * from its schema so validation and typing can never drift.
 */
export * from "./common.js";
export * from "./domain.js";
export * from "./project-config.js";
export * from "./mcp.js";
export * from "./messages.js";
export * from "./wire.js";
