import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDemoData, serializeDemoFiles } from "../src/lib/demo/generate";

async function main() {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..", "demo-data");
  const data = generateDemoData();
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(serializeDemoFiles(data))) {
    await writeFile(resolve(directory, name), content);
    console.info(`${name}: ${content.length.toLocaleString("en-US")} bytes`);
  }
  console.info(`Generated ${data.users.length} synthetic users, ${data.usage.length} active user-days across ${data.manifest.days} days (seed ${data.manifest.seed}).`);
}

main().catch((error: unknown) => {
  console.error("Failed to generate demo data:", error);
  process.exitCode = 1;
});
