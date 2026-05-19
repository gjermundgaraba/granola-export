import test from "node:test";
import assert from "node:assert/strict";
import { noteMarkdown, transcriptMarkdown } from "../src/markdown.ts";
import type { Doc, TranscriptSegment } from "../src/granola.ts";

const doc: Doc = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  title: "Planning *Notes*",
  created_at: "2026-03-17T12:00:06.092Z",
  updated_at: "2026-03-17T12:45:10.123Z",
  workspace_id: "workspace-1",
  last_viewed_panel: {
    content: {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Agenda" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Ship ", marks: [{ type: "bold" }] },
            { type: "text", text: "https://example.com?a=(b)", marks: [{ type: "link", attrs: { href: "https://example.com/a(b)" } }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item *one*" }] }] },
          ],
        },
      ],
    },
  },
};

test("noteMarkdown renders frontmatter and core ProseMirror nodes", () => {
  const markdown = noteMarkdown(doc, ["Shared / Planning"]);

  assert.match(markdown, /title: "Planning \*Notes\*"/);
  assert.match(markdown, /folders:\n  - "Shared \/ Planning"/);
  assert.match(markdown, /^# Planning \\\*Notes\\\*/m);
  assert.match(markdown, /^## Agenda/m);
  assert.match(markdown, /\*\*Ship\*\* \[https:\/\/example\.com\?a=\(b\)\]\(https:\/\/example\.com\/a\(b\)\)/);
  assert.match(markdown, /^- item \*one\*/m);
});

test("noteMarkdown preserves HTML note content", () => {
  const markdown = noteMarkdown({
    ...doc,
    last_viewed_panel: {
      content: "<h3>Summary</h3>\n<ul><li>item</li></ul>",
    },
  }, []);

  assert.match(markdown, /<h3>Summary<\/h3>\n<ul><li>item<\/li><\/ul>/);
});

test("noteMarkdown renders empty ProseMirror documents", () => {
  const markdown = noteMarkdown({
    ...doc,
    last_viewed_panel: {
      content: { type: "doc" },
    },
  }, []);

  assert.match(markdown, /^# Planning \\\*Notes\\\*$/m);
});

test("noteMarkdown renders generated headings as literal text", () => {
  const markdown = noteMarkdown({
    ...doc,
    title: "Line [one]\n`two` & <three>",
    last_viewed_panel: {
      content: { type: "doc" },
    },
  }, []);

  assert.match(markdown, /^# Line \\\[one\\\] \\\`two\\\` \\& \\<three\\>$/m);
});

test("transcriptMarkdown labels speaker sources", () => {
  const segments: TranscriptSegment[] = [
    { source: "microphone", text: "from mic", start_timestamp: "2026-03-17T12:00:10.000Z" },
    { source: "system", text: "from system", start_timestamp: "2026-03-17T12:00:11.000Z" },
    { source: "external_provider", text: "from provider", start_timestamp: "2026-03-17T12:00:12.000Z" },
  ];

  assert.equal(
    transcriptMarkdown(doc, segments),
    "# Planning \\*Notes\\* - Transcript\n\n[12:00:10] You: from mic\n[12:00:11] System: from system\n[12:00:12] external_provider: from provider"
  );
});
