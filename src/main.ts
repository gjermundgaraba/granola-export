import { Cause, Clock, Console, Effect, FileSystem, Layer, Ref } from "effect";
import { NodeFileSystem, NodeHttpClient, NodePath, NodeRuntime } from "@effect/platform-node";
import ora from "ora";
import type { Ora } from "ora";
import { dim, red } from "yoctocolors";
import { countOutput, exportDoc, OUT_DIR, removeEmptyDirs, removeStaleMarkdown, scanMarkdownPaths } from "./export.ts";
import { AuthError, GranolaClient, getFolderDocs, getOwnedDocs, getTranscript } from "./granola.ts";
import { changeSummary, createReport, printReport } from "./report.ts";

const PlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeHttpClient.layerUndici);
const AppLayer = GranolaClient.layer.pipe(Layer.provideMerge(PlatformLayer));
const EXPORT_CONCURRENCY = 8;

function authErrorMessage(cause: Cause.Cause<unknown>): string | undefined {
  const authError = cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error)
    .find((error) => error instanceof AuthError);

  return authError?.message;
}

const setSpinnerText = Effect.fn("export.setSpinnerText")((spinner: Ora, text: string): Effect.Effect<void> =>
  Effect.sync(() => {
    spinner.text = text;
  })
);

const exportNotes = Effect.fn("export.exportNotes")(function* (spinner: Ora) {
  const fs = yield* FileSystem.FileSystem;
  const report = createReport(yield* Clock.currentTimeMillis);

  yield* Effect.sync(() => spinner.start("Reading Granola credentials"));
  const granola = yield* GranolaClient;

  yield* setSpinnerText(spinner, "Preparing output directory");
  yield* fs.makeDirectory(OUT_DIR, { recursive: true });

  yield* setSpinnerText(spinner, "Scanning existing export");
  const existingPaths = yield* scanMarkdownPaths(OUT_DIR);
  const keepPaths = new Set<string>();

  yield* setSpinnerText(spinner, "Fetching documents");
  const docsById = yield* getOwnedDocs((text) => setSpinnerText(spinner, text));

  yield* setSpinnerText(spinner, "Fetching folders");
  const folderResult = yield* getFolderDocs(docsById, (text) => setSpinnerText(spinner, text));
  report.granolaDocs = docsById.size;
  report.granolaFolders = folderResult.granolaFolders;

  const docs = [...docsById.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const completedDocs = yield* Ref.make(0);
  const deltas = yield* Effect.forEach(docs, (doc) =>
    Effect.gen(function* () {
      const delta = yield* exportDoc({
        outDir: OUT_DIR,
        doc,
        folders: folderResult.docFolders.get(doc.id) || [],
        existingPaths,
        keepPaths,
        getTranscript,
      });
      const completed = yield* Ref.updateAndGet(completedDocs, (value) => value + 1);
      if (completed === docs.length || completed % 10 === 0) {
        yield* setSpinnerText(spinner, `Writing Markdown files ${dim(`(${completed}/${docs.length})`)}`);
      }
      return delta;
    }), { concurrency: EXPORT_CONCURRENCY });

  for (const delta of deltas) {
    report.notesWritten += delta.notesWritten;
    report.transcriptsWritten += delta.transcriptsWritten;
    report.transcriptsUnavailable += delta.transcriptsUnavailable;
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

const failExport = Effect.fn("export.failExport")(function* (spinner: Ora, cause: Cause.Cause<unknown>) {
  yield* Effect.sync(() => spinner.fail("Granola export failed"));
  const expectedMessage = authErrorMessage(cause);
  const debug = process.env.GRANOLA_DEBUG === "1" || process.env.GRANOLA_DEBUG === "true";
  yield* Console.error(red(debug || !expectedMessage ? Cause.pretty(cause) : expectedMessage));
  if (!debug && expectedMessage) {
    yield* Console.error(dim("Set GRANOLA_DEBUG=1 to see the full stack trace."));
  }
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

const main = Effect.fn("export.main")(function* () {
  const spinner = yield* Effect.sync(() => ora({ text: "Starting Granola export", color: "cyan", discardStdin: false }));

  yield* exportNotes(spinner).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failExport(spinner, cause),
      onSuccess: () => Effect.void,
    })
  );
})();

NodeRuntime.runMain(main.pipe(Effect.provide(AppLayer)), { disableErrorReporting: true });
