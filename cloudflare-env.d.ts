interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    changes?: number;
    duration?: number;
    last_row_id?: number;
    rows_read?: number;
    rows_written?: number;
    [key: string]: unknown;
  };
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface R2ObjectBody {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
}

interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    UPLOADS?: R2Bucket;
    ASSETS?: Fetcher;
    [key: string]: unknown;
  };
}
