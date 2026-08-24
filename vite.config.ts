import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

type HostingBindings = {
  d1?: string;
  r2?: string;
};

function loadHostingBindings(): HostingBindings {
  // Vite bundles this config into a temporary directory before evaluating it,
  // so import.meta.url is not a stable anchor for project-owned metadata.
  const configPath = resolve(process.cwd(), ".openai", "hosting.json");
  if (!existsSync(configPath)) return {};

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return {
    d1: typeof parsed.d1 === "string" && parsed.d1.trim() ? parsed.d1 : undefined,
    r2: typeof parsed.r2 === "string" && parsed.r2.trim() ? parsed.r2 : undefined,
  };
}

// Sites supplies these logical bindings through .openai/hosting.json. A
// self-host source package intentionally omits .openai, so its Next.js build
// must still be type-checkable without copying hosting metadata or secrets.
const { d1, r2 } = loadHostingBindings();

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
