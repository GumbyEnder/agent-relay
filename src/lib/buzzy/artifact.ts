/**
 * Buzzy artifact renderer — Phase 1 proving slice (plan doc 23).
 *
 * ARTIFACT RULE (non-negotiable): the model NEVER writes file bytes. It emits
 * a typed content object; this module validates it against a schema and
 * renders it deterministically with the docx library. The render output is
 * byte-identical for identical input.
 *
 * Phase 1 scope: render_document ({ title, sections }) -> real .docx.
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** A section of the document: heading + paragraph list. */
export interface DocSection {
  heading: string;
  paragraphs: string[];
}

/** Typed content the model must emit for render_document. */
export interface DocumentContent {
  title: string;
  sections: DocSection[];
}

export interface RenderResult {
  ok: boolean;
  /** Human-readable reason when ok=false (feeds the loop's failure behavior). */
  error?: string;
  /** The rendered file, when ok=true. */
  bytes?: Uint8Array;
  filename?: string;
  contentType?: string;
}

/** Deterministic validation — not an LLM judgment call. */
function validateDocumentContent(raw: unknown): { ok: true; content: DocumentContent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "content is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    return { ok: false, error: "sections must be a non-empty array" };
  }
  const sections: DocSection[] = [];
  for (const s of obj.sections.slice(0, 25)) {
    if (!s || typeof s !== "object") return { ok: false, error: "section is not an object" };
    const so = s as Record<string, unknown>;
    if (typeof so.heading !== "string" || !so.heading.trim()) {
      return { ok: false, error: "section.heading must be a non-empty string" };
    }
    const paras = so.paragraphs;
    if (!Array.isArray(paras) || paras.length === 0 ||
        !paras.every((p) => typeof p === "string" && p.trim())) {
      return { ok: false, error: "section.paragraphs must be a non-empty array of strings" };
    }
    sections.push({
      heading: so.heading.trim().slice(0, 200),
      paragraphs: (paras as string[]).slice(0, 40).map((p) => p.trim().slice(0, 4000)),
    });
  }
  return { ok: true, content: { title: obj.title.trim().slice(0, 200), sections } };
}

/** Sanitize a title into a safe download filename. */
function safeFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "document"}.docx`;
}

/**
 * Render a typed document content object into a real .docx file.
 * Deterministic: same input, same bytes. Throws nothing — returns ok:false
 * with a reason the loop can surface in plain language.
 */
export async function renderDocument(raw: unknown): Promise<RenderResult> {
  const v = validateDocumentContent(raw);
  if (!v.ok) return { ok: false, error: v.error };

  const { title, sections } = v.content;
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];
  for (const s of sections) {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }));
    for (const p of s.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(p)] }));
    }
  }

  const doc = new Document({
    creator: "BeeZilla",
    title,
    sections: [{ children }],
  });

  try {
    const bytes = await Packer.toBuffer(doc);
    return {
      ok: true,
      bytes: new Uint8Array(bytes),
      filename: safeFilename(title),
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  } catch (err) {
    return {
      ok: false,
      error: `renderer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** JSON schema for the render_document tool (passed to chatCompletionFull). */
export const RENDER_DOCUMENT_TOOL = {
  type: "function",
  function: {
    name: "render_document",
    description:
      "Render the finished document the owner asked for as a real Word file. " +
      "Call this ONLY when the full deliverable is ready and the owner has asked for it. " +
      "Provide the complete document content — never placeholders or summaries. " +
      "Content must be an object: { title: string, sections: [{ heading: string, paragraphs: string[] }] } " +
      "with 1-25 sections, each with 1-40 non-empty paragraphs.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title, shown as the main heading and the filename." },
        sections: {
          type: "array",
          description: "The document body, in order.",
          items: {
            type: "object",
            properties: {
              heading: { type: "string", description: "Section heading." },
              paragraphs: { type: "array", items: { type: "string" }, description: "Full paragraphs of body text." },
            },
            required: ["heading", "paragraphs"],
          },
        },
      },
      required: ["title", "sections"],
    },
  },
};

/** Extract the typed content object from a tool call's arguments string. */
export function parseToolArguments(argumentsJson: string): unknown {
  let s = argumentsJson.trim();
  // Strip code fences if the model wrapped the JSON despite instructions.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}
