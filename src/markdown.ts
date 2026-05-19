import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Code } from "@tiptap/extension-code";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Document } from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import { Heading } from "@tiptap/extension-heading";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { Italic } from "@tiptap/extension-italic";
import { Link } from "@tiptap/extension-link";
import { BulletList, ListItem, OrderedList } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Strike } from "@tiptap/extension-strike";
import { Text } from "@tiptap/extension-text";
import { MarkdownManager } from "@tiptap/markdown";
import type { Doc, ProseMirrorDoc, TranscriptSegment } from "./granola.ts";

const markdownManager = new MarkdownManager({
  extensions: [
    Document,
    Text,
    Paragraph,
    Heading,
    Bold,
    Italic,
    Strike,
    Code,
    Link,
    BulletList,
    OrderedList,
    ListItem,
    Blockquote,
    CodeBlock,
    HardBreak,
    HorizontalRule,
  ],
});

function toMarkdown(doc: ProseMirrorDoc | string | null | undefined): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return markdownManager.serialize(doc);
}

function markdownPlainText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([`*_{}\[\]<>()#+.!|&])/g, "\\$1");
}

function plainTextHeading(text: string): string {
  return `# ${markdownPlainText(text.replace(/\r?\n/g, " "))}`;
}

function frontmatter(doc: Doc, folderNames: string[]): string {
  const lines = [
    "---",
    `id: ${JSON.stringify(doc.id)}`,
    `title: ${JSON.stringify(doc.title || "Untitled")}`,
    `created_at: ${JSON.stringify(doc.created_at)}`,
    `updated_at: ${JSON.stringify(doc.updated_at)}`,
  ];

  if (doc.workspace_id) lines.push(`workspace_id: ${JSON.stringify(doc.workspace_id)}`);
  if (folderNames.length) lines.push("folders:", ...folderNames.map((folder) => `  - ${JSON.stringify(folder)}`));

  return [...lines, "---"].join("\n");
}

export function noteMarkdown(doc: Doc, folderNames: string[]): string {
  const content = [plainTextHeading(doc.title || "Untitled"), toMarkdown(doc.last_viewed_panel?.content)].join("\n\n");
  return `${frontmatter(doc, folderNames)}\n\n${content}`;
}

function speakerLabel(source: string): string {
  if (source === "microphone") return "You";
  if (source === "system") return "System";
  return source;
}

export function transcriptMarkdown(doc: Doc, segments: readonly TranscriptSegment[]): string {
  const lines = segments.map(
    (segment) =>
      `[${segment.start_timestamp.slice(11, 19)}] ${speakerLabel(segment.source)}: ${segment.text}`
  );
  return [plainTextHeading(`${doc.title || "Untitled"} - Transcript`), "", ...lines].join("\n");
}
