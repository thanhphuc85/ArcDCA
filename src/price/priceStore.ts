import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PriceSnapshot } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PRICES_FILE_PATH = path.resolve(__dirname, "../../data/prices.json");

// Keep the on-disk series bounded (3 runs/day × ~6 months).
const MAX_SNAPSHOTS = 600;

export async function readPrices(): Promise<PriceSnapshot[]> {
  try {
    const raw = await readFile(PRICES_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PriceSnapshot[]) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function appendPrice(snapshot: PriceSnapshot): Promise<void> {
  const prices = await readPrices();
  prices.push(snapshot);
  const trimmed = prices.slice(-MAX_SNAPSHOTS);
  await writeFile(PRICES_FILE_PATH, `${JSON.stringify(trimmed, null, 2)}\n`, "utf-8");
}
