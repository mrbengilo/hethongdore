export type DatabasePlatformKind = "cloudflare" | "sqlite";

export interface UploadsBucket {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface DatabasePlatform {
  kind: DatabasePlatformKind;
  database: D1Database;
  uploads?: UploadsBucket;
}

let platformPromise: Promise<DatabasePlatform> | undefined;

function nodeEnvironment(name: string) {
  return typeof process === "undefined" ? undefined : process.env[name];
}

function sqliteConfiguration() {
  const requestedPlatform = nodeEnvironment("DORE_DB_PLATFORM")?.trim().toLowerCase();
  const configuredPath = nodeEnvironment("DORE_DATABASE_PATH")?.trim();
  if (requestedPlatform === "sqlite" || configuredPath) {
    return configuredPath || "./data/dore.sqlite";
  }
  return null;
}

async function createPlatform(): Promise<DatabasePlatform> {
  const sqlitePath = sqliteConfiguration();
  if (sqlitePath) {
    const { getSqliteDatabase } = await import("./sqlite");
    return { kind: "sqlite", database: await getSqliteDatabase(sqlitePath) };
  }

  // Keep Sites/Cloudflare as the default when no Node SQLite path is set.
  // Dynamic loading prevents a self-hosted Node process from resolving the
  // Cloudflare-only module when DORE_DATABASE_PATH selects SQLite.
  const { env } = await import(/* webpackIgnore: true */ "cloudflare:workers");
  if (!env.DB) {
    throw new Error(
      "Database is unavailable. Configure the Cloudflare D1 `DB` binding or set DORE_DATABASE_PATH for self-hosted SQLite.",
    );
  }
  return {
    kind: "cloudflare",
    database: env.DB,
    uploads: env.UPLOADS as UploadsBucket | undefined,
  };
}

export function getDatabasePlatform() {
  platformPromise ??= createPlatform().catch((error) => {
    platformPromise = undefined;
    throw error;
  });
  return platformPromise;
}

export async function getDatabase() {
  return (await getDatabasePlatform()).database;
}
