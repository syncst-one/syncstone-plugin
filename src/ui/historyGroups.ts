import type { FileRevisionItem, RevisionEntry } from "@websync/shared";

/** One author of a version: the device, and the account it belongs to when the server says so. */
export interface RevisionAuthor {
  deviceName: string | null;
  username: string | null;
}

/** A version as the history panels show it: who wrote it (several people when it was co-edited live). */
export interface HistoryEntry extends RevisionEntry {
  /** Set by the server for a version co-edited live; otherwise the uploading device is the author. */
  contributors?: RevisionAuthor[];
}

/** Edits of one note with no pause longer than this between them read as one sitting and are shown as one block. */
export const EDIT_BLOCK_GAP_MS = 30 * 60 * 1000;

/**
 * Splits a newest-first history list into blocks: neighbouring edits ("modify") of the same note, on the same day, with
 * no pause longer than `EDIT_BLOCK_GAP_MS`, become one block; everything else (create, rename, delete, restore) stays on
 * its own, so it is never hidden inside a block. A block of one is just that entry.
 */
export function groupEdits<E extends Pick<RevisionEntry, "fileId" | "action" | "createdAt">>(entries: readonly E[], gapMs = EDIT_BLOCK_GAP_MS): E[][] {
  const blocks: E[][] = [];
  let current: E[] | null = null;
  for (const entry of entries) {
    const last = current?.[current.length - 1];
    const joins =
      current !== null &&
      last !== undefined &&
      entry.action === "modify" &&
      last.action === "modify" &&
      entry.fileId === last.fileId &&
      sameDay(entry.createdAt, last.createdAt) &&
      Date.parse(last.createdAt) - Date.parse(entry.createdAt) <= gapMs;
    if (joins && current) current.push(entry);
    else {
      current = [entry];
      blocks.push(current);
    }
  }
  return blocks;
}

function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The authors of one version: its contributors when co-edited, else the device that wrote it. */
export function authorsOf(entry: HistoryEntry): RevisionAuthor[] {
  if (entry.contributors?.length) return entry.contributors;
  return [{ deviceName: entry.deviceName, username: entry.username }];
}

/**
 * "Pixel 7, MacBook" for one version or a whole block, without repeats. The account is added only when the list mixes
 * accounts (a shared vault), like the single-version label always did. Long lists end in "+2".
 */
export function authorsLabel(entries: readonly HistoryEntry[], showAccount: boolean, unknownDevice: string, max = 3): string {
  const names: string[] = [];
  for (const entry of entries) {
    for (const author of authorsOf(entry)) {
      const device = author.deviceName || unknownDevice;
      const name = showAccount && author.username ? `${device} · ${author.username}` : device;
      if (!names.includes(name)) names.push(name);
    }
  }
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max}`;
}

/** True when the versions come from more than one account (then names carry the account). */
export function mixesAccounts(entries: readonly HistoryEntry[]): boolean {
  const accounts = new Set<string>();
  for (const entry of entries) for (const author of authorsOf(entry)) if (author.username) accounts.add(author.username);
  return accounts.size > 1;
}

/**
 * A history item from the server, with its path already decrypted. Self-hosted servers name the account `username`, the
 * hosted service `userEmail`; contributors only come from servers that know co-edited versions.
 */
export function toHistoryEntry(r: FileRevisionItem & { userEmail?: string | null; contributors?: Array<{ deviceName: string | null; username?: string | null; userEmail?: string | null }> }, path: string | null): HistoryEntry {
  return {
    id: r.id,
    fileId: r.fileId,
    version: r.version,
    action: r.action,
    path,
    size: r.contentSize,
    hash: r.contentHashBlinded,
    hasContent: r.hasContent,
    deviceName: r.deviceName,
    username: r.username ?? r.userEmail ?? null,
    createdAt: r.createdAt,
    ...(r.contributors?.length
      ? { contributors: r.contributors.map((c) => ({ deviceName: c.deviceName ?? null, username: c.username ?? c.userEmail ?? null })) }
      : {}),
  };
}
