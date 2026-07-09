import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Ledger, UserAccount } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER_FILE_PATH = path.resolve(__dirname, "../../data/ledger.json");

function emptyLedger(): Ledger {
  return { version: 1, lastScannedBlock: 0, users: {}, deposits: [], distributions: [], withdrawals: [] };
}

export function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

export async function readLedger(): Promise<Ledger> {
  try {
    const raw = await readFile(LEDGER_FILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.version === 1 ? (parsed as Ledger) : emptyLedger();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
    throw err;
  }
}

export async function writeLedger(ledger: Ledger): Promise<void> {
  await writeFile(LEDGER_FILE_PATH, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
}

function emptyUser(address: string, now: string): UserAccount {
  return {
    address,
    usdcBalance: "0",
    cirBtcBalance: "0",
    totalDeposited: "0",
    totalSwapped: "0",
    totalWithdrawnCirBtc: "0",
    totalWithdrawnUsdc: "0",
    firstSeen: now,
    lastActivity: now,
  };
}

export function getOrCreateUser(ledger: Ledger, address: string, now?: string): UserAccount {
  const key = normalizeAddress(address);
  if (!ledger.users[key]) {
    ledger.users[key] = emptyUser(key, now ?? new Date().toISOString());
  }
  return ledger.users[key];
}
