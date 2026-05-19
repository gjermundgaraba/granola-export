import { Console, Effect } from "effect";
import { bold, cyan, dim, green, yellow } from "yoctocolors";
import type { ExportDelta, OutputCount } from "./export.ts";

export interface Report extends ExportDelta {
  startedAt: number;
  apiCalls: number;
  refreshedCredentials: boolean;
  granolaDocs: number;
  granolaFolders: number;
  filesRemoved: number;
}

export function createReport(startedAt: number): Report {
  return {
    startedAt,
    apiCalls: 0,
    refreshedCredentials: false,
    granolaDocs: 0,
    granolaFolders: 0,
    notesWritten: 0,
    transcriptsWritten: 0,
    transcriptsUnavailable: 0,
    filesRemoved: 0,
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return value === 1 ? singular : pluralForm;
}

function duration(startedAt: number, completedAt: number): string {
  return `${((completedAt - startedAt) / 1000).toFixed(1)}s`;
}

function outputDirLabel(outputDir: string): string {
  const dir = outputDir.replace(/^\.\//, "").replace(/\/+$/, "");
  return dir ? `${dir}/` : outputDir;
}

function reportRow(label: string, value: string | number): string {
  const formatted = typeof value === "number" ? formatNumber(value) : value;
  return `  ${dim(label.padEnd(24))} ${bold(formatted)}`;
}

export function changeSummary(report: Report): string {
  const parts = [`${formatNumber(report.notesWritten)} ${plural(report.notesWritten, "note")} written`];

  if (report.transcriptsWritten > 0) {
    parts.push(`${formatNumber(report.transcriptsWritten)} ${plural(report.transcriptsWritten, "transcript")} written`);
  }
  if (report.filesRemoved > 0) {
    parts.push(`${formatNumber(report.filesRemoved)} stale ${plural(report.filesRemoved, "file")} removed`);
  }
  if (report.transcriptsUnavailable > 0) {
    parts.push(`${formatNumber(report.transcriptsUnavailable)} unavailable ${plural(report.transcriptsUnavailable, "transcript")}`);
  }

  return parts.join(" · ");
}

export function reportText(report: Report, output: OutputCount, outputDir: string, completedAt: number): string {
  const lines = [
    "",
    cyan("This run"),
    reportRow("Notes written", report.notesWritten),
    reportRow("Transcripts written", report.transcriptsWritten),
    reportRow("Files removed", report.filesRemoved),
  ];

  if (report.transcriptsUnavailable > 0) {
    lines.push(reportRow("Unavailable transcripts", yellow(formatNumber(report.transcriptsUnavailable))));
  }

  lines.push(
    "",
    cyan("Current export"),
    reportRow("Unique notes", output.uniqueNotes),
    reportRow("Markdown files", output.files),
    reportRow("Note files", output.noteFiles),
    reportRow("Transcript files", output.transcriptFiles),
    reportRow("Folders", output.folders)
  );

  const source = [`${formatNumber(report.granolaDocs)} docs`, `${formatNumber(report.granolaFolders)} folders`];
  const run = [`${duration(report.startedAt, completedAt)}`, `${formatNumber(report.apiCalls)} API calls`];
  if (report.refreshedCredentials) run.push("credentials refreshed");
  run.push(outputDirLabel(outputDir));

  lines.push(
    "",
    `${dim("Source:")} ${source.join(dim(" · "))}`,
    `${dim("Run:")} ${run.join(dim(" · "))}`,
    `${green("✓")} Done`
  );

  return lines.join("\n");
}

export const printReport = Effect.fn("report.printReport")((
  report: Report,
  output: OutputCount,
  outputDir: string,
  completedAt: number
): Effect.Effect<void> => Console.log(reportText(report, output, outputDir, completedAt)));
