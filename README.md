# Granola Export

Export Granola notes and transcripts to local Markdown files.

It reads the local Granola desktop auth files, calls Granola's internal APIs,
and writes the export to `./notes`.

## Requirements

- macOS with the Granola desktop app installed and signed in
- Node `v24.15.0` or newer

## Install

```bash
npm install
```

## Run

```bash
npm run export-notes
```

Exports are written to:

```txt
notes/
```

The script creates Markdown note files and transcript files when transcripts are
available.

```txt
notes/Shared/Projects/2026-03-17T12-00-06_Project-Update_00000000-0000-4000-8000-000000000001.md
notes/Shared/Projects/2026-03-17T12-00-06_Project-Update_00000000-0000-4000-8000-000000000001-transcript.md
```

Notes include YAML frontmatter with the document id, title, timestamps,
workspace id, and folder paths when available.

## Folders

Granola folders are mirrored as directories under `notes/`.

```txt
Shared / Customers / Client-001
```

becomes:

```txt
notes/Shared/Customers/Client-001/
```

If a note belongs to multiple folders, the exporter writes a copy to each local
folder. Notes without a folder stay directly in `notes/`.

## Reruns

The exporter is safe to run more than once.

- Note files are rewritten on each run.
- Transcript API calls are skipped when the transcript file already exists.
- Markdown files that are no longer part of the export are removed at the end.

For a completely fresh export:

```bash
rm -rf notes
npm run export-notes
```

## Authentication

The exporter looks for credentials in this order:

```txt
.creds.json
~/Library/Application Support/Granola/stored-accounts.json
~/Library/Application Support/Granola/supabase.json
```

Recent Granola versions use `stored-accounts.json`; `supabase.json` is kept as a
legacy fallback.

When tokens expire, the script refreshes them through WorkOS and saves the new
credentials to `.creds.json` with user-only permissions. Do not commit this
file.

If refresh fails, open Granola and confirm you are signed in. If needed, quit
and reopen Granola, or sign out and back in, then run the exporter again.

## Development

```bash
npm test
npm run typecheck
```

The project uses Effect v4 beta and TypeScript's native preview compiler
(`tsgo`). The beta dependencies are pinned because their APIs are still moving.

## Caveats

- Granola does not provide a stable public API for this workflow.
- Internal endpoint shapes may change.
- `.creds.json` contains auth material.

## Legal Disclaimer

This project is an unofficial export tool and is not affiliated with, endorsed
by, or supported by Granola.

Use it only to export your own Granola data from a locally authenticated account.
It relies on non-public Granola endpoints and local auth material, so review
Granola's applicable terms and policies before using it. You are responsible for
how you use the tool and for protecting any exported notes, transcripts, or
credentials.

This is not legal advice.
