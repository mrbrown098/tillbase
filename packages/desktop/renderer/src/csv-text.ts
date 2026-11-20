/** Plain-words sentence about the stock log for the CSV screen (before the import, or after it). */
export function stockLogText(entries: number, fixStock: boolean, done: boolean): string {
  const noun = entries === 1 ? "entry" : "entries";
  // New items start with the stock written in the file. Corrections to items you already have
  // are only made when the person ticked the box for it.
  const why = fixStock ? "for the opening stock of new items and the corrections you chose" : "for the opening stock of new items";
  return done
    ? `${entries} stock log ${noun} ${entries === 1 ? "was" : "were"} added ${why}.`
    : `${entries} stock log ${noun} will be added ${why}.`;
}
