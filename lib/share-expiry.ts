export const ENTRY_SHARE_EXPIRIES = ["7d", "30d", "never"] as const;
export type EntryShareExpiry = (typeof ENTRY_SHARE_EXPIRIES)[number];
export const DEFAULT_ENTRY_SHARE_EXPIRY: EntryShareExpiry = "7d";

export function parseEntryShareExpiry(value: unknown): EntryShareExpiry | undefined | false {
  if (value === undefined) return undefined;
  return typeof value === "string" && ENTRY_SHARE_EXPIRIES.some((option) => option === value)
    ? value as EntryShareExpiry
    : false;
}

export function entryShareTtlSeconds(expiry: EntryShareExpiry = DEFAULT_ENTRY_SHARE_EXPIRY): number | null {
  if (expiry === "never") return null;
  return expiry === "7d" ? 7 * 86_400 : 30 * 86_400;
}
