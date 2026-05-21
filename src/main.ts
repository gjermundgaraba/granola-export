import { Cause, Clock, Console, Effect, FileSystem, Layer, Ref } from "effect";
import { NodeFileSystem, NodeHttpClient, NodePath, NodeRuntime } from "@effect/platform-node";
import ora from "ora";
import type { Ora } from "ora";
import { dim, red } from "yoctocolors";
import { countOutput, exportDoc, removeEmptyDirs, removeStaleMarkdown, scanMarkdownPaths } from "./export.ts";
import {
  GranolaClient,
  getFolderDocs,
  getOwnedDocs,
  getTranscript,
  ReportGranolaProgress
} from "./granola.ts";
import { changeSummary, createReport, printReport } from "./report.ts";
import type { GranolaProgress } from "./granola.ts";

const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeHttpClient.layerUndici);
const AppLayer = GranolaClient.layer.pipe(Layer.provideMerge(PlatformLayer));
const OUT_DIR = "./notes";
const EXPORT_CONCURRENCY = 8;

function debugEnabled(): boolean {
  return process.env.GRANOLA_DEBUG === "1" || process.env.GRANOLA_DEBUG === "true";
}

const setSpinnerText = Effect.fn("export.setSpinnerText")(
  (spinner: Ora, text: string): Effect.Effect<void> =>
    Effect.sync(() => {
      spinner.text = text;
    })
);

const stopSpinner = Effect.fn("export.stopSpinner")(
  (spinner: Ora): Effect.Effect<void> =>
    Effect.sync(() => {
      if (spinner.isSpinning) spinner.stop();
    })
);

function granolaProgressText(progress: GranolaProgress): string {
  switch (progress._tag) {
    case "FetchingDocuments":
      return `Fetching documents ${dim(`(${progress.loaded} loaded)`)}`;
    case "FetchingFolders":
      return `Fetching folders ${dim(`(${progress.current}/${progress.total})`)} ${progress.title}`.trimEnd();
  }
}

function progressLayer(spinner: Ora) {
  return Layer.succeed(ReportGranolaProgress, (progress) => setSpinnerText(spinner, granolaProgressText(progress)));
}

const exportNotes = Effect.fn("export.exportNotes")(function* (spinner: Ora) {
  const fs = yield* FileSystem.FileSystem;
  const report = createReport(yield* Clock.currentTimeMillis);

  yield* Effect.sync(() => spinner.start("Reading Granola credentials"));
  const granola = yield* GranolaClient;
  yield* granola.ensureCredentials;

  yield* setSpinnerText(spinner, "Preparing output directory");
  yield* fs.makeDirectory(OUT_DIR, { recursive: true });

  yield* setSpinnerText(spinner, "Scanning existing export");
  const existingPaths = yield* scanMarkdownPaths(OUT_DIR);

  yield* setSpinnerText(spinner, "Fetching documents");
  const docsById = yield* getOwnedDocs();

  yield* setSpinnerText(spinner, "Fetching folders");
  const folderResult = yield* getFolderDocs(docsById);
  report.granolaDocs = docsById.size;
  report.granolaFolders = folderResult.granolaFolders;

  const docs = [...docsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const completedDocs = yield* Ref.make(0);
  const exportedDocs = yield* Effect.forEach(
    docs,
    (doc) =>
      Effect.gen(function* () {
        const exportedDoc = yield* exportDoc({
          outDir: OUT_DIR,
          doc,
          folders: folderResult.docFolders.get(doc.id) || [],
          existingPaths,
          getTranscript
        });
        const completed = yield* Ref.updateAndGet(completedDocs, (value) => value + 1);
        if (completed === docs.length || completed % 10 === 0) {
          yield* setSpinnerText(spinner, `Writing Markdown files ${dim(`(${completed}/${docs.length})`)}`);
        }
        return exportedDoc;
      }),
    { concurrency: EXPORT_CONCURRENCY }
  );

  const keepPaths = new Set<string>();
  for (const { delta, keepPaths: docKeepPaths } of exportedDocs) {
    report.notesWritten += delta.notesWritten;
    report.transcriptsWritten += delta.transcriptsWritten;
    report.transcriptsUnavailable += delta.transcriptsUnavailable;
    for (const path of docKeepPaths) keepPaths.add(path);
  }

  const stats = yield* granola.stats;
  report.apiCalls = stats.apiCalls;
  report.refreshedCredentials = stats.refreshedCredentials;

  yield* setSpinnerText(spinner, "Removing stale Markdown files");
  report.filesRemoved = yield* removeStaleMarkdown(existingPaths, keepPaths);

  yield* setSpinnerText(spinner, "Cleaning empty folders");
  yield* removeEmptyDirs(OUT_DIR);

  yield* setSpinnerText(spinner, "Counting current export");
  const output = yield* countOutput(OUT_DIR);
  const completedAt = yield* Clock.currentTimeMillis;
  yield* Effect.sync(() => spinner.succeed(`Granola export complete: ${changeSummary(report)}`));
  yield* printReport(report, output, OUT_DIR, completedAt);
});

const failExpectedExport = Effect.fn("export.failExpectedExport")(function* (spinner: Ora, message: string) {
  yield* Effect.sync(() => spinner.fail("Granola export failed"));
  yield* Console.error(red(message));
  yield* Console.error(dim("Set GRANOLA_DEBUG=1 to see the full stack trace."));
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

const failUnexpectedExport = Effect.fn("export.failUnexpectedExport")(function* (
  spinner: Ora,
  cause: Cause.Cause<unknown>
) {
  yield* Effect.sync(() => spinner.fail("Granola export failed"));
  yield* Console.error(red(Cause.pretty(cause)));
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

const main = Effect.fn("export.main")(function* () {
  const spinner = yield* Effect.sync(() =>
    ora({
      text: "Starting Granola export",
      color: "cyan",
      discardStdin: false
    })
  );
  const debug = debugEnabled();

  yield* exportNotes(spinner).pipe(
    Effect.provide(progressLayer(spinner)),
    Effect.provide(AppLayer),
    Effect.catchTag("AuthError", (error) => (debug ? Effect.fail(error) : failExpectedExport(spinner, error.message))),
    Effect.matchCauseEffect({
      onFailure: (cause) => failUnexpectedExport(spinner, cause),
      onSuccess: () => Effect.void
    }),
    Effect.ensuring(stopSpinner(spinner))
  );
})();

NodeRuntime.runMain(main, { disableErrorReporting: true });
