/**
 * What a turn says while it is running.
 *
 * The typed/voice lanes stream their words, so the text itself is the progress
 * and no stage is needed before the first token. A buffered turn (a draft, an
 * explicit file request, or a browser job — anything that needs a tool surface)
 * paints nothing until the whole answer exists. It used to show only the
 * seconds counter, which reads the same whether the document is being written
 * or the turn is hung.
 *
 * So: the buffered path announces one stage at the moment it starts, and the
 * label distinguishes a document being written from a chat reply being written.
 * The streaming path announces nothing — a label before the first token would
 * be a claim about work the page cannot see yet.
 */

export interface TurnStage {
  phase: string;
  label: string;
  etaMs: number;
}

export type TurnLane = "stream" | "buffered";

export function turnStageFor(
  lane: TurnLane,
  opts: { expectsDocument?: boolean } = {},
): TurnStage | null {
  if (lane === "stream") return null;
  if (opts.expectsDocument) {
    return { phase: "document", label: "Writing your document", etaMs: 20_000 };
  }
  return { phase: "reply", label: "Writing your reply", etaMs: 8_000 };
}
