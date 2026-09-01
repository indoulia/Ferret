export class SessionStore {
  #sessions = new Map<string, string>();
  open(user: string, token: string): void {
    this.#sessions.set(user, token);
  }
}
