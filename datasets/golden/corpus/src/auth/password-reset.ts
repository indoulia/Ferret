export function requestPasswordReset(email: string): string {
  return `reset-token-for-${email}`;
}
