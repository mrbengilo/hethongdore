import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const standaloneRoot = join(projectRoot, ".next", "standalone");

await stat(join(standaloneRoot, "server.js")).catch(() => {
  throw new Error("Next.js standalone server was not generated");
});

async function copyDirectory(source, destination) {
  const sourceExists = await stat(source).then(() => true, () => false);
  if (!sourceExists) return;
  await rm(destination, { force: true, recursive: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

await copyDirectory(join(projectRoot, "public"), join(standaloneRoot, "public"));
await copyDirectory(
  join(projectRoot, ".next", "static"),
  join(standaloneRoot, ".next", "static"),
);

console.log("Standalone runtime prepared with public and static assets.");
