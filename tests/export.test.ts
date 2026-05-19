import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Effect, FileSystem, Layer, Path } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { exportDoc, pathsForDoc, removeStaleMarkdown, scanMarkdownPaths } from "../src/export.ts";
import type { Doc, TranscriptSegment } from "../src/granola.ts";

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestLayer)));
}

const id = "123e4567-e89b-12d3-a456-426614174000";

function doc(title: string, updatedAt = "2026-03-17T12:45:10.123Z"): Doc {
  return {
    id,
    title,
    created_at: "2026-03-17T12:00:06.092Z",
    updated_at: updatedAt,
    last_viewed_panel: {
      content: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }],
      },
    },
  };
}

function transcriptFetcher(text = "hello") {
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    getTranscript: (): Effect.Effect<TranscriptSegment[]> => Effect.sync(() => {
      calls++;
      return [{ source: "microphone", text, start_timestamp: "2026-03-17T12:00:10.000Z" }];
    }),
  };
}

test("pathsForDoc keeps generated files inside sanitized path parts", () => {
  const paths = pathsForDoc("out", doc("../Bad: Title"), [["..", "Team / Notes"]]);

  assert.deepEqual(paths.folderNames, [".. / Team / Notes"]);
  assert.equal(
    paths.notePaths[0],
    join("out", "Untitled", "Team-Notes", `2026-03-17T12-00-06_..Bad-Title_${id}.md`)
  );
});

test("pathsForDoc falls back for reserved filename parts", () => {
  const paths = pathsForDoc("out", doc("CON"), [["COM1", "Valid"]]);

  assert.equal(
    paths.notePaths[0],
    join("out", "Untitled", "Valid", `2026-03-17T12-00-06_Untitled_${id}.md`)
  );
});

test("pathsForDoc truncates long title filenames", () => {
  const paths = pathsForDoc("out", doc("a".repeat(300)), []);
  const name = paths.notePaths[0].split(/[/\\]/).at(-1);

  assert.equal(name?.length, "2026-03-17T12-00-06_".length + 120 + `_${id}.md`.length);
});

test("exportDoc rewrites notes and reuses existing transcripts", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "granola-export-"));

  try {
    let existingPaths = await run(scanMarkdownPaths(outDir));
    let keepPaths = new Set<string>();
    const firstTranscriptFetcher = transcriptFetcher("old");
    let delta = await run(exportDoc({
      outDir,
      doc: doc("Same title"),
      folders: [],
      existingPaths,
      keepPaths,
      getTranscript: firstTranscriptFetcher.getTranscript,
    }));
    assert.deepEqual(delta, {
      notesWritten: 1,
      transcriptsWritten: 1,
      transcriptsUnavailable: 0,
    });
    assert.equal(firstTranscriptFetcher.calls, 1);

    existingPaths = await run(scanMarkdownPaths(outDir));
    keepPaths = new Set<string>();
    const secondTranscriptFetcher = transcriptFetcher("new");
    const changedDoc = doc("Same title", "2026-03-17T13:00:00.000Z");
    delta = await run(exportDoc({
      outDir,
      doc: changedDoc,
      folders: [],
      existingPaths,
      keepPaths,
      getTranscript: secondTranscriptFetcher.getTranscript,
    }));
    assert.deepEqual(delta, {
      notesWritten: 1,
      transcriptsWritten: 0,
      transcriptsUnavailable: 0,
    });
    assert.equal(secondTranscriptFetcher.calls, 0);

    const paths = pathsForDoc(outDir, changedDoc, []);
    assert.match(await readFile(paths.notePaths[0], "utf-8"), /updated_at: "2026-03-17T13:00:00.000Z"/);
    assert.match(await readFile(paths.transcriptPaths[0], "utf-8"), /You: old/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("removeStaleMarkdown removes generated files that were not kept this run", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "granola-export-"));

  try {
    let existingPaths = await run(scanMarkdownPaths(outDir));
    let keepPaths = new Set<string>();
    await run(exportDoc({
      outDir,
      doc: doc("Old title"),
      folders: [],
      existingPaths,
      keepPaths,
      getTranscript: transcriptFetcher().getTranscript,
    }));

    existingPaths = await run(scanMarkdownPaths(outDir));
    keepPaths = new Set<string>();
    await run(exportDoc({
      outDir,
      doc: doc("New title"),
      folders: [],
      existingPaths,
      keepPaths,
      getTranscript: transcriptFetcher().getTranscript,
    }));
    const removed = await run(removeStaleMarkdown(existingPaths, keepPaths));

    const oldPaths = pathsForDoc(outDir, doc("Old title"), []);
    const newPaths = pathsForDoc(outDir, doc("New title"), []);
    assert.equal(removed, 2);
    assert.match(await readFile(newPaths.notePaths[0], "utf-8"), /^# New title/m);
    await assert.rejects(readFile(oldPaths.notePaths[0], "utf-8"), { code: "ENOENT" });
    await assert.rejects(readFile(oldPaths.transcriptPaths[0], "utf-8"), { code: "ENOENT" });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
