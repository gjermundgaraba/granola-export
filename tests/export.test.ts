import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Effect, FileSystem, Layer, Path } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { exportDoc, pathsForDoc, removeStaleMarkdown, scanMarkdownPaths } from "../src/export.ts";
import type { Doc, TranscriptSegment } from "../src/granola.ts";
import type * as Scope from "effect/Scope";

const TestLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

function run<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(TestLayer)));
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
        content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }]
      }
    }
  };
}

function transcriptFetcher(text = "hello") {
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    getTranscript: (): Effect.Effect<TranscriptSegment[]> =>
      Effect.sync(() => {
        calls++;
        return [
          {
            source: "microphone",
            text,
            start_timestamp: "2026-03-17T12:00:10.000Z"
          }
        ];
      })
  };
}

test("pathsForDoc keeps generated files inside sanitized path parts", () => {
  const paths = pathsForDoc("out", doc("../Bad: Title"), [["..", "Team / Notes"]]);

  assert.deepEqual(paths.folderNames, [".. / Team / Notes"]);
  assert.equal(paths.notePaths[0], join("out", "Untitled", "Team-Notes", `2026-03-17T12-00-06_..Bad-Title_${id}.md`));
});

test("pathsForDoc falls back for reserved filename parts", () => {
  const paths = pathsForDoc("out", doc("CON"), [["COM1", "Valid"]]);

  assert.equal(paths.notePaths[0], join("out", "Untitled", "Valid", `2026-03-17T12-00-06_Untitled_${id}.md`));
});

test("pathsForDoc truncates long title filenames", () => {
  const paths = pathsForDoc("out", doc("a".repeat(300)), []);
  const name = paths.notePaths[0].split(/[/\\]/).at(-1);

  assert.equal(name?.length, "2026-03-17T12-00-06_".length + 120 + `_${id}.md`.length);
});

test("exportDoc rewrites notes and reuses existing transcripts", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped();
      let existingPaths = yield* scanMarkdownPaths(outDir);
      const firstTranscriptFetcher = transcriptFetcher("old");
      let result = yield* exportDoc({
        outDir,
        doc: doc("Same title"),
        folders: [],
        existingPaths,
        getTranscript: firstTranscriptFetcher.getTranscript
      });
      assert.deepEqual(result.delta, {
        notesWritten: 1,
        transcriptsWritten: 1,
        transcriptsUnavailable: 0
      });
      assert.equal(firstTranscriptFetcher.calls, 1);

      existingPaths = yield* scanMarkdownPaths(outDir);
      const secondTranscriptFetcher = transcriptFetcher("new");
      const changedDoc = doc("Same title", "2026-03-17T13:00:00.000Z");
      result = yield* exportDoc({
        outDir,
        doc: changedDoc,
        folders: [],
        existingPaths,
        getTranscript: secondTranscriptFetcher.getTranscript
      });
      assert.deepEqual(result.delta, {
        notesWritten: 1,
        transcriptsWritten: 0,
        transcriptsUnavailable: 0
      });
      assert.equal(secondTranscriptFetcher.calls, 0);

      const paths = pathsForDoc(outDir, changedDoc, []);
      assert.match(yield* fs.readFileString(paths.notePaths[0], "utf-8"), /updated_at: "2026-03-17T13:00:00.000Z"/);
      assert.match(yield* fs.readFileString(paths.transcriptPaths[0], "utf-8"), /You: old/);
    })
  ));

test("removeStaleMarkdown removes generated files that were not kept this run", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped();
      let existingPaths = yield* scanMarkdownPaths(outDir);
      yield* exportDoc({
        outDir,
        doc: doc("Old title"),
        folders: [],
        existingPaths,
        getTranscript: transcriptFetcher().getTranscript
      });

      existingPaths = yield* scanMarkdownPaths(outDir);
      const result = yield* exportDoc({
        outDir,
        doc: doc("New title"),
        folders: [],
        existingPaths,
        getTranscript: transcriptFetcher().getTranscript
      });
      const removed = yield* removeStaleMarkdown(existingPaths, result.keepPaths);

      const oldPaths = pathsForDoc(outDir, doc("Old title"), []);
      const newPaths = pathsForDoc(outDir, doc("New title"), []);
      assert.equal(removed, 2);
      assert.match(yield* fs.readFileString(newPaths.notePaths[0], "utf-8"), /^# New title/m);

      const oldNote = yield* Effect.exit(fs.readFileString(oldPaths.notePaths[0], "utf-8"));
      const oldTranscript = yield* Effect.exit(fs.readFileString(oldPaths.transcriptPaths[0], "utf-8"));
      assert.equal(oldNote._tag, "Failure");
      assert.equal(oldTranscript._tag, "Failure");
    })
  ));
