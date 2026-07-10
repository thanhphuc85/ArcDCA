import type { MarketData, FearGreedData, OnChainVolume } from "../types.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";
import {
  ARC_TESTNET_RPC,
  ARC_USDC_CONTRACT,
  ARC_CIRBTC_CONTRACT,
  USDC_DECIMALS,
  CIRBTC_DECIMALS,
  ERC20_TRANSFER_TOPIC,
} from "../ledger/constants.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const FEAR_GREED_API = "https://api.alternative.me/fng/?limit=1";
const VOLUME_SCAN_BLOCKS = 5000;

async function fetchJson<T>(url: string, label: string): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    },
    { maxRetries: 2, label },
  );
}

export async function fetchBtcMarketData(): Promise<MarketData | null> {
  try {
    interface CoinGeckoPrice {
      bitcoin: {
        usd: number;
        usd_24h_change: number;
        usd_24h_vol: number;
        usd_market_cap: number;
      };
    }
    const priceData = await fetchJson<CoinGeckoPrice>(
      `${COINGECKO_BASE}/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`,
      "CoinGecko price",
    );

    interface CoinGeckoChart {
      prices: Array<[number, number]>;
    }
    const chartData = await fetchJson<CoinGeckoChart>(
      `${COINGECKO_BASE}/coins/bitcoin/market_chart?vs_currency=usd&days=7`,
      "CoinGecko chart",
    );

    const btc = priceData.bitcoin;
    return {
      btcPriceUsd: btc.usd,
      btcChange24h: btc.usd_24h_change,
      btcVolume24h: btc.usd_24h_vol,
      btcMarketCap: btc.usd_market_cap,
      priceHistory7d: chartData.prices.map(([ts, price]) => ({ timestamp: ts, price })),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`Failed to fetch BTC market data: ${(err as Error).message}`);
    return null;
  }
}

export async function fetchFearGreedIndex(): Promise<FearGreedData | null> {
  try {
    interface FngResponse {
      data: Array<{ value: string; value_classification: string; timestamp: string }>;
    }
    const res = await fetchJson<FngResponse>(FEAR_GREED_API, "Fear & Greed");
    const entry = res.data[0];
    if (!entry) return null;
    return {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: new Date(parseInt(entry.timestamp, 10) * 1000).toISOString(),
    };
  } catch (err) {
    logger.warn(`Failed to fetch Fear & Greed index: ${(err as Error).message}`);
    return null;
  }
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  return withRetry(
    async () => {
      const r = await fetch(ARC_TESTNET_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const json = (await r.json()) as { error?: { message: string }; result: unknown };
      if (json.error) throw new Error(`RPC error: ${json.error.message}`);
      return json.result;
    },
    { maxRetries: 2, label: `RPC ${method}` },
  );
}

interface RpcLog {
  data: string;
}

async function countTransfers(
  contract: string,
  fromBlock: number,
  toBlock: number,
  decimals: number,
): Promise<{ count: number; volume: string }> {
  const logs = (await rpcCall("eth_getLogs", [
    {
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      address: contract,
      topics: [ERC20_TRANSFER_TOPIC],
    },
  ])) as RpcLog[];

  let totalRaw = 0n;
  for (const log of logs) {
    totalRaw += BigInt(log.data);
  }
  return {
    count: logs.length,
    volume: (Number(totalRaw) / 10 ** decimals).toFixed(decimals),
  };
}

export async function scanOnChainVolume(): Promise<OnChainVolume | null> {
  try {
    const latestHex = (await rpcCall("eth_blockNumber", [])) as string;
    const latestBlock = parseInt(latestHex, 16);
    const fromBlock = Math.max(0, latestBlock - VOLUME_SCAN_BLOCKS);

    const [usdc, cirBtc] = await Promise.all([
      countTransfers(ARC_USDC_CONTRACT, fromBlock, latestBlock, USDC_DECIMALS),
      countTransfers(ARC_CIRBTC_CONTRACT, fromBlock, latestBlock, CIRBTC_DECIMALS),
    ]);

    const blockTime = 2;
    const periodHours = Math.round((VOLUME_SCAN_BLOCKS * blockTime) / 3600);

    return {
      usdcTransferCount: usdc.count,
      usdcVolumeTotal: usdc.volume,
      cirBtcTransferCount: cirBtc.count,
      cirBtcVolumeTotal: cirBtc.volume,
      blockRange: { from: fromBlock, to: latestBlock },
      periodHours,
    };
  } catch (err) {
    logger.warn(`Failed to scan on-chain volume: ${(err as Error).message}`);
    return null;
  }
}

export async function fetchAllMarketData(): Promise<{
  market: MarketData | null;
  fearGreed: FearGreedData | null;
  onChainVolume: OnChainVolume | null;
}> {
  const [market, fearGreed, onChainVolume] = await Promise.all([
    fetchBtcMarketData(),
    fetchFearGreedIndex(),
    scanOnChainVolume(),
  ]);
  return { market, fearGreed, onChainVolume };
}
