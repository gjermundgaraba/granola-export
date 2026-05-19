import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { join } from "node:path";
import sanitizeFilenamePart from "sanitize-filename";
import type { Doc, TranscriptSegment } from "./granola.ts";
import { noteMarkdown, transcriptMarkdown } from "./markdown.ts";

export const OUT_DIR = "./notes";

export interface OutputCount {
  folders: number;
  files: number;
  noteFiles: number;
  transcriptFiles: number;
  uniqueNotes: number;
}

export interface ExportDelta {
  notesWritten: number;
  transcriptsWritten: number;
  transcriptsUnavailable: number;
}

export interface DocPaths {
  folderNames: string[];
  notePaths: string[];
  transcriptPaths: string[];
}

const MAX_FILENAME_TITLE_LENGTH = 120;

function markdownFileId(name: string): { id: string; transcript: boolean } | null {
  const match = name.match(/_([a-f0-9-]+)(-transcript)?\.md$/i);
  return match ? { id: match[1], transcript: Boolean(match[2]) } : null;
}

export const scanMarkdownPaths = Effect.fn("export.scanMarkdownPaths")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = new Set<string>();

  const walk: (current: string) => Effect.Effect<void, PlatformError> = Effect.fn("export.scanMarkdownPaths.walk")(
    function* (current: string) {
      for (const entry of yield* fs.readDirectory(current)) {
        const entryPath = path.join(current, entry);
        const info = yield* fs.stat(entryPath);
        if (info.type === "Directory") {
          yield* walk(entryPath);
        } else if (entry.endsWith(".md")) {
          paths.add(entryPath);
        }
      }
    }
  );

  yield* walk(dir);
  return paths;
});

export const countOutput = Effect.fn("export.countOutput")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const noteIds = new Set<string>();
  const count: OutputCount = {
    folders: 0,
    files: 0,
    noteFiles: 0,
    transcriptFiles: 0,
    uniqueNotes: 0,
  };

  const walk: (current: string) => Effect.Effect<void, PlatformError> = Effect.fn("export.countOutput.walk")(
    function* (current: string) {
      for (const entry of yield* fs.readDirectory(current)) {
        const entryPath = path.join(current, entry);
        const info = yield* fs.stat(entryPath);
        if (info.type === "Directory") {
          count.folders++;
          yield* walk(entryPath);
          continue;
        }

        if (!entry.endsWith(".md")) continue;

        count.files++;
        const fileId = markdownFileId(entry);
        if (fileId?.transcript) {
          count.transcriptFiles++;
        } else {
          count.noteFiles++;
          if (fileId?.id) noteIds.add(fileId.id);
        }
      }
    }
  );

  yield* walk(dir);
  count.uniqueNotes = noteIds.size;
  return count;
});

export const removeStaleMarkdown = Effect.fn("export.removeStaleMarkdown")(function* (
  existingPaths: ReadonlySet<string>,
  keepPaths: ReadonlySet<string>
) {
  const fs = yield* FileSystem.FileSystem;
  let removed = 0;

  for (const path of existingPaths) {
    if (keepPaths.has(path)) continue;
    yield* fs.remove(path, { force: true });
    removed++;
  }

  return removed;
});

export const removeEmptyDirs = Effect.fn("export.removeEmptyDirs")(function* (dir: string, root = dir) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const walk: (current: string) => Effect.Effect<void, PlatformError> = Effect.fn("export.removeEmptyDirs.walk")(
    function* (current: string) {
      for (const entry of yield* fs.readDirectory(current)) {
        const entryPath = path.join(current, entry);
        const info = yield* fs.stat(entryPath);
        if (info.type === "Directory") yield* walk(entryPath);
      }

      if (current !== root && (yield* fs.readDirectory(current)).length === 0) {
        yield* fs.remove(current);
      }
    }
  );

  yield* walk(dir);
});

function sanitizeFilename(value: string): string {
  return sanitizeFilenamePart(value)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s/g, "-");
}

function pathPart(value: string): string {
  return sanitizeFilename(value) || "Untitled";
}

function filenameFor(doc: Doc, suffix?: string): string {
  const date = doc.created_at.slice(0, 19).replace(/:/g, "-");
  const title = pathPart(doc.title || "Untitled").slice(0, MAX_FILENAME_TITLE_LENGTH);
  const base = `${date}_${title}_${doc.id}`;
  return suffix ? `${base}-${suffix}.md` : `${base}.md`;
}

export function pathsForDoc(outDir: string, doc: Doc, folders: readonly (readonly string[])[]): DocPaths {
  const folderNames = folders.map((parts) => parts.join(" / ")).sort();
  const dirs = folders.length
    ? [...new Set(folders.map((parts) => join(outDir, ...parts.map(pathPart))))]
    : [outDir];

  return {
    folderNames,
    notePaths: dirs.map((dir) => join(dir, filenameFor(doc))),
    transcriptPaths: dirs.map((dir) => join(dir, filenameFor(doc, "transcript"))),
  };
}

const writeMarkdown = Effect.fn("export.writeMarkdown")(function* (
  filePath: string,
  markdown: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fs.writeFileString(filePath, markdown);
});

export const exportDoc = Effect.fn("export.exportDoc")(function* <E, R>(args: {
  outDir: string;
  doc: Doc;
  folders: readonly (readonly string[])[];
  existingPaths: ReadonlySet<string>;
  keepPaths: Set<string>;
  getTranscript(documentId: string): Effect.Effect<readonly TranscriptSegment[] | null, E, R>;
}) {
  const { outDir, doc, folders, existingPaths, keepPaths, getTranscript } = args;
  const delta: ExportDelta = {
    notesWritten: 0,
    transcriptsWritten: 0,
    transcriptsUnavailable: 0,
  };
  const { folderNames, notePaths, transcriptPaths } = pathsForDoc(outDir, doc, folders);

  const note = noteMarkdown(doc, folderNames);
  for (const path of notePaths) {
    yield* writeMarkdown(path, note);
    keepPaths.add(path);
    delta.notesWritten++;
  }

  const existingTranscriptPaths = transcriptPaths.filter((path) => existingPaths.has(path));
  const missingTranscriptPaths = transcriptPaths.filter((path) => !existingPaths.has(path));

  if (missingTranscriptPaths.length === 0) {
    for (const path of existingTranscriptPaths) keepPaths.add(path);
    return delta;
  }

  const segments = yield* getTranscript(doc.id);
  if (!segments) {
    for (const path of existingTranscriptPaths) keepPaths.add(path);
    delta.transcriptsUnavailable += missingTranscriptPaths.length;
    return delta;
  }

  const transcript = transcriptMarkdown(doc, segments);
  for (const path of transcriptPaths) {
    yield* writeMarkdown(path, transcript);
    keepPaths.add(path);
    delta.transcriptsWritten++;
  }

  return delta;
});
