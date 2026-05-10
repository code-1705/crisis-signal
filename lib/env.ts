import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let loaded = false;

export function loadProjectEnv() {
  if (loaded) return;
  loaded = true;

  const projectRoot = process.cwd();
  const envFiles = [".env", ".env.local"];

  for (const envFile of envFiles) {
    const path = join(projectRoot, envFile);
    if (!existsSync(path)) continue;

    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      process.env[key] = value;
    }
  }
}

function parseEnvFile(input: string) {
  const output: Record<string, string> = {};

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    output[key] = value;
  }

  return output;
}
