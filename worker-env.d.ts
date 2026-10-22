// Import only the Worker types used by this shared browser/server project.
// Loading all Worker globals would replace DOM Response.json with unknown.
type D1Database = import("@cloudflare/workers-types").D1Database;

declare module "cloudflare:workers" {
  // Configured by .openai/hosting.json and vite.config.ts.
  export const env: { DB: D1Database };
}
