import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Reflection } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REFLECTIONS_FILE_PATH = path.resolve(__dirname, "../../data/reflections.json");

export async function readReflections(): Promise<Reflection[]> {
  try {
    const raw = await readFile(REFLECTIONS_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Reflection[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function appendReflection(reflection: Reflection): Promise<void> {
  const reflections = await readReflections();
  reflections.push(reflection);
  await writeFile(REFLECTIONS_FILE_PATH, `${JSON.stringify(reflections, null, 2)}\n`, "utf-8");
}

export function recentReflections(reflections: Reflection[], limit = 5): Reflection[] {
  return reflections.slice(-limit);
}

export function searchByTags(reflections: Reflection[], tags: string[], limit = 5): Reflection[] {
  if (!tags.length) return recentReflections(reflections, limit);
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const matched = reflections.filter((r) => r.tags.some((t) => tagSet.has(t.toLowerCase())));
  return matched.slice(-limit);
}
