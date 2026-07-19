export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.network";
export const ARC_USDC_CONTRACT = "0x3600000000000000000000000000000000000000";
export const ARC_CIRBTC_CONTRACT = "0xf0c4a4ce82a5746abaad9425360ab04fbba432bf";
export const ARC_AGENT_ADDRESS = "0x00Ebbd3aFCCaD08970ED8FdaE591244c8475a0aC";
export const USDC_DECIMALS = 6;
export const CIRBTC_DECIMALS = 8;
export const EURC_DECIMALS = 6;

/**
 * Tokens the agent can DCA into on Arc Testnet. USDC is the input, never a
 * target. `symbol` is what Circle Swap Kit resolves for the swap; `decimals`
 * governs ledger rounding of the received amount. This is the honest, current
 * set the network's Swap Kit actually supports — it grows as Arc wires more
 * assets, not as we hard-code them.
 */
export interface DcaTokenInfo {
  symbol: string;
  decimals: number;
  label: string;
  note?: string;
}
export const SUPPORTED_DCA_TOKENS: DcaTokenInfo[] = [
  { symbol: "cirBTC", decimals: CIRBTC_DECIMALS, label: "cirBTC — tokenized BTC", note: "volatile; route in outage on Arc Testnet" },
  { symbol: "EURC", decimals: EURC_DECIMALS, label: "EURC — euro stablecoin", note: "live route" },
];
export const DEFAULT_DCA_TOKEN = "cirBTC";

export function dcaTokenInfo(symbol: string | undefined | null): DcaTokenInfo {
  return SUPPORTED_DCA_TOKENS.find((t) => t.symbol === symbol) ?? SUPPORTED_DCA_TOKENS[0]!;
}
export function isSupportedDcaToken(symbol: string | undefined | null): boolean {
  return !!symbol && SUPPORTED_DCA_TOKENS.some((t) => t.symbol === symbol);
}
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const DEPOSIT_SCAN_CHUNK_SIZE = 9999;
export const DEPOSIT_SCAN_LOOKBACK = 200_000;
