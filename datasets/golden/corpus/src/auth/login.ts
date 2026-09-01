export function authenticateUser(email: string, secret: string): boolean {
  return email.length > 0 && secret.length > 0;
}
