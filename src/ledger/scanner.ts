import type { Ledger, DepositRecord } from "../types.js";
import { normalizeAddress, getOrCreateUser } from "./store.js";
import { ERC20_TRANSFER_TOPIC, USDC_DECIMALS, DEPOSIT_SCAN_CHUNK_SIZE, DEPOSIT_SCAN_LOOKBACK } from "./constants.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";

interface RpcLog {
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  topics: string[];
  data: string;
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await withRetry(
    async () => {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const json = (await r.json()) as { error?: { message: string }; result: unknown };
      if (json.error) throw new Error(`RPC error: ${json.error.message}`);
      return json.result;
    },
    { maxRetries: 3, label: `RPC ${method}` },
  );
  return res;
}

function parseTransferLog(log: RpcLog): { from: string; amount: string; txHash: string; logIndex: number; blockNumber: number } {
  const from = "0x" + (log.topics[1] ?? "").slice(26);
  const rawAmount = BigInt(log.data);
  const amount = (Number(rawAmount) / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
  return {
    from: normalizeAddress(from),
    amount,
    txHash: log.transactionHash,
    logIndex: parseInt(log.logIndex, 16),
    blockNumber: parseInt(log.blockNumber, 16),
  };
}

export async function scanDeposits(
  ledger: Ledger,
  agentAddress: string,
  rpcUrl: string,
  usdcContract: string,
): Promise<{ newDeposits: DepositRecord[] }> {
  const latestHex = (await rpcCall(rpcUrl, "eth_blockNumber", [])) as string;
  const latestBlock = parseInt(latestHex, 16);

  let fromBlock = ledger.lastScannedBlock > 0
    ? ledger.lastScannedBlock + 1
    : Math.max(0, latestBlock - DEPOSIT_SCAN_LOOKBACK);

  if (fromBlock > latestBlock) {
    return { newDeposits: [] };
  }

  const existingIds = new Set(ledger.deposits.map((d) => d.id));
  const agentPadded = "0x" + normalizeAddress(agentAddress).slice(2).padStart(64, "0");
  const newDeposits: DepositRecord[] = [];
  const now = new Date().toISOString();

  while (fromBlock <= latestBlock) {
    const toBlock = Math.min(fromBlock + DEPOSIT_SCAN_CHUNK_SIZE, latestBlock);
    const logs = (await rpcCall(rpcUrl, "eth_getLogs", [{
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      address: usdcContract,
      topics: [ERC20_TRANSFER_TOPIC, null, agentPadded],
    }])) as RpcLog[];

    for (const log of logs) {
      const parsed = parseTransferLog(log);
      const id = `${parsed.txHash}-${parsed.logIndex}`;
      if (existingIds.has(id)) continue;
      if (parseFloat(parsed.amount) <= 0) continue;

      const user = getOrCreateUser(ledger, parsed.from, now);
      user.usdcBalance = (parseFloat(user.usdcBalance) + parseFloat(parsed.amount)).toFixed(USDC_DECIMALS);
      user.totalDeposited = (parseFloat(user.totalDeposited) + parseFloat(parsed.amount)).toFixed(USDC_DECIMALS);
      user.lastActivity = now;

      const record: DepositRecord = {
        id,
        txHash: parsed.txHash,
        from: parsed.from,
        amount: parsed.amount,
        blockNumber: parsed.blockNumber,
        recordedAt: now,
      };
      ledger.deposits.push(record);
      existingIds.add(id);
      newDeposits.push(record);
    }

    fromBlock = toBlock + 1;
  }

  ledger.lastScannedBlock = latestBlock;

  if (newDeposits.length > 0) {
    logger.info(`Scanned ${newDeposits.length} new deposit(s) up to block ${latestBlock}`);
  }

  return { newDeposits };
}
