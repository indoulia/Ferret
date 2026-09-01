export function calculateTax(amountMinor: number, rate: number): number {
  return Math.round(amountMinor * rate);
}
