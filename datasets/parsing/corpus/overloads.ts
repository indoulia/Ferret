export function format(value: number): string;
export function format(value: string): string;
export function format(value: number | string): string {
  return String(value);
}

export const arrow = (a: number): number => a + 1;
