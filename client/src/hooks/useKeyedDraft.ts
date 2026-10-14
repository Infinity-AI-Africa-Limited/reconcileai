import { useCallback, useState } from "react";
import { readKeyedDraft, writeKeyedDraft, type KeyedDrafts } from "@/lib/keyedDraft";

/**
 * `useState` for a text draft that belongs to `key` (see lib/keyedDraft.ts).
 * The setter is bound to the key current when it was created, so a write that
 * lands after the subject changed — the end of an earlier case's request —
 * stays with the subject it was meant for.
 */
export function useKeyedDraft(key: string): [string, (next: string | ((current: string) => string)) => void] {
  const [drafts, setDrafts] = useState<KeyedDrafts>({});
  const setText = useCallback(
    (next: string | ((current: string) => string)) => setDrafts(stored => writeKeyedDraft(stored, key, next)),
    [key]
  );
  return [readKeyedDraft(drafts, key), setText];
}
