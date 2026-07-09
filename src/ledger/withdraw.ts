import type { Ledger, WithdrawalRequest, WithdrawalToken } from "../types.js";
import type { Wallet } from "../wallet.js";
import { normalizeAddress } from "./store.js";
import { ARC_USDC_CONTRACT, ARC_CIRBTC_CONTRACT, USDC_DECIMALS, CIRBTC_DECIMALS } from "./constants.js";
import { logger } from "../logger.js";

export function requestWithdrawal(
  ledger: Ledger,
  address: string,
  token: WithdrawalToken,
  amount: string,
): WithdrawalRequest {
  const key = normalizeAddress(address);
  const user = ledger.users[key];
  if (!user) throw new Error(`No account found for ${address}`);

  const requested = parseFloat(amount);
  if (requested <= 0) throw new Error("Withdrawal amount must be positive");

  const balanceField = token === "USDC" ? "usdcBalance" : "cirBtcBalance";
  const available = parseFloat(user[balanceField]);
  if (requested > available) {
    throw new Error(`Insufficient ${token} balance: requested ${amount}, available ${available}`);
  }

  // Deduct immediately to prevent double-spend
  const decimals = token === "USDC" ? USDC_DECIMALS : CIRBTC_DECIMALS;
  user[balanceField] = (available - requested).toFixed(decimals);
  user.lastActivity = new Date().toISOString();

  const request: WithdrawalRequest = {
    id: `wd-${Date.now()}-${key.slice(-6)}`,
    address: key,
    token,
    amount,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  ledger.withdrawals.push(request);

  logger.info(`Withdrawal request created: ${amount} ${token} for ${key}`);
  return request;
}

export async function processPendingWithdrawals(
  ledger: Ledger,
  wallet: Wallet,
): Promise<number> {
  const pending = ledger.withdrawals.filter((w) => w.status === "pending");
  if (pending.length === 0) return 0;

  let processed = 0;
  for (const req of pending) {
    req.status = "processing";
    try {
      const tokenAddress = req.token === "USDC" ? ARC_USDC_CONTRACT : ARC_CIRBTC_CONTRACT;
      const result = await wallet.sendTokens({
        tokenAddress,
        destinationAddress: req.address,
        amount: req.amount,
      });
      req.status = "completed";
      req.processedAt = new Date().toISOString();
      req.txHash = result.txHash;
      processed++;

      // Update cumulative withdrawal totals
      const user = ledger.users[req.address];
      if (user) {
        if (req.token === "USDC") {
          user.totalWithdrawnUsdc = (parseFloat(user.totalWithdrawnUsdc) + parseFloat(req.amount)).toFixed(USDC_DECIMALS);
        } else {
          user.totalWithdrawnCirBtc = (parseFloat(user.totalWithdrawnCirBtc) + parseFloat(req.amount)).toFixed(CIRBTC_DECIMALS);
        }
      }

      logger.info(`Withdrawal ${req.id} completed: ${req.amount} ${req.token} → ${req.address}`);
    } catch (err) {
      req.status = "failed";
      req.processedAt = new Date().toISOString();
      req.error = err instanceof Error ? err.message : String(err);
      logger.error(`Withdrawal ${req.id} failed`, err);
    }
  }

  return processed;
}
