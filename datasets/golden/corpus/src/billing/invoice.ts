export interface Invoice {
  readonly id: string;
  readonly amountMinor: number;
}

export function createInvoice(id: string, amountMinor: number): Invoice {
  return { id, amountMinor };
}
