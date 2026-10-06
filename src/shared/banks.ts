/**
 * Memory banks: one account can keep several separate memories. The default bank, "main", is the
 * account's original memory and keeps its original agent name (the user id), so nothing moves.
 * Other banks are named "<user>.<bank>"; chat threads append ".<thread>" to either.
 */
export const DEFAULT_BANK = "main";
export const BANK = /^[a-z0-9_-]{1,32}$/;
export const MAX_BANKS = 10;

/** The MemoryAgent name for a user's bank. */
export const memoryName = (user: string, bank: string) => (bank === DEFAULT_BANK ? user : `${user}.${bank}`);

/** Split a MemoryAgent name back into user and bank. */
export function parseMemoryName(name: string): { user: string; bank: string } {
  const dot = name.indexOf(".");
  return dot < 0 ? { user: name, bank: DEFAULT_BANK } : { user: name.slice(0, dot), bank: name.slice(dot + 1) };
}
