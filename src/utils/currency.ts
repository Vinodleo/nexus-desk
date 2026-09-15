export const CURRENCY_SYMBOL = "₹";
export const CURRENCY_CODE = "INR";

/**
 * Formats a numeric value into an Indian Rupee (INR) currency representation.
 * Standardizes on the Indian Numbering System (Lakhs and Crores, e.g. ₹10,00,000.00).
 */
export function formatINR(
  amount: number,
  options?: {
    showSign?: boolean;
    decimals?: number;
    showSymbol?: boolean;
  }
): string {
  if (isNaN(amount) || amount === null || amount === undefined) {
    return options?.showSymbol !== false ? "₹0.00" : "0.00";
  }

  const decimals = options?.decimals ?? 2;
  const showSymbol = options?.showSymbol !== false;
  const isNegative = amount < 0;
  const absVal = Math.abs(amount);

  const formattedNum = absVal.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  const symbol = showSymbol ? CURRENCY_SYMBOL : "";

  if (options?.showSign) {
    if (amount > 0) return `+${symbol}${formattedNum}`;
    if (amount < 0) return `-${symbol}${formattedNum}`;
    return `${symbol}${formattedNum}`;
  }

  return isNegative ? `-${symbol}${formattedNum}` : `${symbol}${formattedNum}`;
}

/**
 * Format raw price in INR
 */
export function formatINRPrice(price: number, decimals: number = 2): string {
  return `${CURRENCY_SYMBOL}${price.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
