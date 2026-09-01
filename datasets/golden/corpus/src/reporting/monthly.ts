export function monthlyTotal(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + amount, 0);
}
