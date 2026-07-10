import Anthropic from "@anthropic-ai/sdk";
import type { MarketData, FearGreedData, OnChainVolume, MarketBrief } from "../types.js";
import { withRetry } from "../retry.js";
import { logger } from "../logger.js";

const ANALYST_MODEL = "claude-haiku-4-5-20251001";

const ANALYST_SYSTEM = `You are a crypto market analyst agent. Your job is to digest raw market data into a concise market brief for a DCA execution agent.

Analyze the provided data and produce a structured assessment using the record_market_brief tool. Be data-driven and specific. Reference actual numbers.

Sentiment scale: very_bearish / bearish / neutral / bullish / very_bullish
On-chain activity: low (<10 transfers/period) / moderate (10-50) / high (>50)
Allocation bias: specific recommendation like "increase 15-20%" or "decrease 10%" or "standard (no adjustment)"

Key insights should be 2-4 bullet points highlighting the most decision-relevant facts.`;

const MARKET_BRIEF_TOOL = {
  name: "record_market_brief",
  description: "Record your market analysis as a structured brief.",
  input_schema: {
    type: "object" as const,
    properties: {
      sentiment: {
        type: "string" as const,
        enum: ["very_bearish", "bearish", "neutral", "bullish", "very_bullish"],
        description: "Overall market sentiment assessment.",
      },
      confidence: {
        type: "number" as const,
        description: "Confidence in this assessment, 0-100.",
      },
      fearGreedLabel: {
        type: "string" as const,
        description: "Human-readable fear/greed label, e.g. 'Fear (35)' or 'Greed (72)'.",
      },
      onChainActivity: {
        type: "string" as const,
        enum: ["low", "moderate", "high"],
        description: "On-chain trading activity level.",
      },
      keyInsights: {
        type: "array" as const,
        items: { type: "string" as const },
        description: "2-4 bullet points of decision-relevant market observations.",
      },
      allocationBias: {
        type: "string" as const,
        description: "Specific allocation adjustment recommendation, e.g. 'increase 15-20%', 'standard', 'decrease 10-15%'.",
      },
    },
    required: ["sentiment", "confidence", "fearGreedLabel", "onChainActivity", "keyInsights", "allocationBias"],
  },
};

function buildAnalystPrompt(
  market: MarketData | null,
  fearGreed: FearGreedData | null,
  onChainVolume: OnChainVolume | null,
): string {
  const sections: string[] = ["# Raw Market Data\n"];

  if (market) {
    sections.push(`## BTC Market (CoinGecko)
- Price: $${market.btcPriceUsd.toLocaleString()}
- 24h Change: ${market.btcChange24h.toFixed(2)}%
- 24h Volume: $${(market.btcVolume24h / 1e9).toFixed(2)}B
- Market Cap: $${(market.btcMarketCap / 1e12).toFixed(3)}T
- 7-day price range: $${Math.min(...market.priceHistory7d.map((p) => p.price)).toLocaleString()} — $${Math.max(...market.priceHistory7d.map((p) => p.price)).toLocaleString()}
- 7-day trend: ${market.priceHistory7d.length} data points from ${new Date(market.priceHistory7d[0]?.timestamp ?? 0).toISOString().slice(0, 10)} to ${new Date(market.priceHistory7d[market.priceHistory7d.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}`);
  } else {
    sections.push("## BTC Market\nData unavailable — CoinGecko API failed.");
  }

  if (fearGreed) {
    sections.push(`\n## Crypto Fear & Greed Index
- Value: ${fearGreed.value}/100
- Classification: ${fearGreed.classification}
- Timestamp: ${fearGreed.timestamp}`);
  } else {
    sections.push("\n## Crypto Fear & Greed Index\nData unavailable.");
  }

  if (onChainVolume) {
    sections.push(`\n## On-Chain Activity (Arc Testnet, last ~${onChainVolume.periodHours}h)
- USDC transfers: ${onChainVolume.usdcTransferCount} (total: ${onChainVolume.usdcVolumeTotal} USDC)
- cirBTC transfers: ${onChainVolume.cirBtcTransferCount} (total: ${onChainVolume.cirBtcVolumeTotal} cirBTC)
- Block range: ${onChainVolume.blockRange.from} → ${onChainVolume.blockRange.to}`);
  } else {
    sections.push("\n## On-Chain Activity\nData unavailable — RPC scan failed.");
  }

  sections.push("\nAnalyze this data and record your market brief.");
  return sections.join("\n");
}

export async function runMarketAnalyst(
  apiKey: string,
  market: MarketData | null,
  fearGreed: FearGreedData | null,
  onChainVolume: OnChainVolume | null,
): Promise<MarketBrief | null> {
  if (!market && !fearGreed && !onChainVolume) {
    logger.warn("No market data available — skipping analyst agent");
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });
    const prompt = buildAnalystPrompt(market, fearGreed, onChainVolume);

    const response = await withRetry(
      () =>
        client.messages.create({
          model: ANALYST_MODEL,
          max_tokens: 1024,
          system: ANALYST_SYSTEM,
          messages: [{ role: "user", content: prompt }],
          tools: [MARKET_BRIEF_TOOL] as Anthropic.Tool[],
          tool_choice: { type: "tool" as const, name: "record_market_brief" },
        }),
      { maxRetries: 2, label: "Analyst agent" },
    );

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      logger.warn("Analyst agent did not produce a tool call");
      return null;
    }

    const input = toolBlock.input as {
      sentiment: MarketBrief["sentiment"];
      confidence: number;
      fearGreedLabel: string;
      onChainActivity: MarketBrief["onChainActivity"];
      keyInsights: string[];
      allocationBias: string;
    };

    const brief: MarketBrief = {
      sentiment: input.sentiment,
      confidence: Math.min(100, Math.max(0, input.confidence)),
      btcPrice: market ? `$${market.btcPriceUsd.toLocaleString()}` : "unknown",
      btcChange24h: market ? `${market.btcChange24h.toFixed(2)}%` : "unknown",
      fearGreedIndex: fearGreed?.value ?? null,
      fearGreedLabel: input.fearGreedLabel,
      onChainActivity: input.onChainActivity,
      keyInsights: input.keyInsights,
      allocationBias: input.allocationBias,
      rawData: { market: market ?? undefined, fearGreed: fearGreed ?? undefined, onChainVolume: onChainVolume ?? undefined },
      generatedAt: new Date().toISOString(),
      model: ANALYST_MODEL,
    };

    logger.info(`Market analyst: ${brief.sentiment} (confidence ${brief.confidence}%) — ${brief.allocationBias}`);
    return brief;
  } catch (err) {
    logger.warn(`Market analyst agent failed: ${(err as Error).message}`);
    return null;
  }
}
