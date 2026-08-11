import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const CCCD_UPLOAD_KEY_PATTERN = /^cccd\/[a-f0-9-]+\.(jpg|png|webp)$/u;

const IMAGE_CONTENT_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);

export type StoredCccdObject = {
  body: BodyInit;
  contentType: string;
};

export type CccdUploadMetadata = {
  contentType: string;
  originalName: string;
  uploadedBy: string;
};

export type CccdStorage = {
  put: (key: string, value: ArrayBuffer, metadata: CccdUploadMetadata) => Promise<void>;
  get: (key: string) => Promise<StoredCccdObject | null>;
  delete: (key: string) => Promise<void>;
};

type R2StoredObject = {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
};

type UploadBucket = {
  put: (key: string, value: ArrayBuffer, options?: {
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  }) => Promise<unknown>;
  get: (key: string) => Promise<R2StoredObject | null>;
  delete: (key: string) => Promise<unknown>;
};

function localPath(root: string, key: string) {
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, ...key.split("/"));
  const childPath = relative(normalizedRoot, target);
  if (!childPath || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error("Upload key resolves outside DORE_UPLOAD_DIR");
  }
  return target;
}

function localStorage(root: string): CccdStorage {
  return {
    async put(key, value) {
      const target = localPath(root, key);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, new Uint8Array(value), { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    async get(key) {
      const target = localPath(root, key);
      const bytes = await readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!bytes) return null;
      const extension = key.slice(key.lastIndexOf(".") + 1);
      return {
        body: new Uint8Array(bytes),
        contentType: IMAGE_CONTENT_TYPES.get(extension) ?? "application/octet-stream",
      };
    },
    async delete(key) {
      const target = localPath(root, key);
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}

async function cloudflareStorage(): Promise<CccdStorage | null> {
  // Webpack must leave this runtime module untouched. Vinext resolves it on
  // Cloudflare Sites, while the self-hosted Node path never imports it.
  const cloudflare = await import(/* webpackIgnore: true */ "cloudflare:workers").catch(() => null);
  const bucket = (cloudflare?.env as unknown as { UPLOADS?: UploadBucket } | undefined)?.UPLOADS;
  if (!bucket) return null;
  return {
    async put(key, value, metadata) {
      await bucket.put(key, value, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: { originalName: metadata.originalName, uploadedBy: metadata.uploadedBy },
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      const extension = key.slice(key.lastIndexOf(".") + 1);
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType
          ?? IMAGE_CONTENT_TYPES.get(extension)
          ?? "application/octet-stream",
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export async function getCccdStorage() {
  const root = process.env.DORE_UPLOAD_DIR?.trim();
  if (root) {
    if (!isAbsolute(root)) throw new Error("DORE_UPLOAD_DIR must be an absolute path");
    return localStorage(root);
  }
  return cloudflareStorage();
}
