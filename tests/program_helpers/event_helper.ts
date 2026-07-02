import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";

/**
 * Returns every Anchor event emitted by a transaction, regardless of whether it
 * was emitted with `emit!` (data lands in "Program data:" log lines) or
 * `emit_cpi!` (data lands in a self-CPI inner instruction). Both channels carry
 * the same `event discriminator + serialized fields` payload, so once isolated
 * they are decoded identically via `program.coder.events.decode`.
 *
 * Events from other programs are skipped: their discriminators don't match this
 * program's coder, so `decode` returns null for them.
 */
export async function getEvents(program: Program<any>, signature: string): Promise<{ name: string; data: any }[]> {
  const tx = await program.provider.connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return [];

  const events: { name: string; data: any }[] = [];

  // emit!  → "Program data: <base64>" log lines.
  const PREFIX = "Program data: ";
  for (const line of tx.meta?.logMessages ?? []) {
    if (!line.startsWith(PREFIX)) continue;
    const decoded = program.coder.events.decode(line.slice(PREFIX.length));
    if (decoded) events.push(decoded);
  }

  // emit_cpi!  → self-CPI inner instructions. Strip the 8-byte self-CPI
  // instruction tag; the remainder is the same event payload as the emit! case.
  for (const set of tx.meta?.innerInstructions ?? []) {
    for (const ix of set.instructions) {
      const raw = anchor.utils.bytes.bs58.decode(ix.data);
      if (raw.length < 8) continue;
      const eventData = anchor.utils.bytes.base64.encode(raw.subarray(8));
      const decoded = program.coder.events.decode(eventData);
      if (decoded) events.push(decoded);
    }
  }

  return events;
}

/**
 * First event with the given `name` (camelCase, as returned by the event coder),
 * typed as `E`. Returns null when no matching event is present.
 */
export async function getEvent<E>(program: Program<any>, signature: string, name: string): Promise<E | null> {
  const match = (await getEvents(program, signature)).find((e) => e.name === name);
  return (match?.data as E) ?? null;
}
