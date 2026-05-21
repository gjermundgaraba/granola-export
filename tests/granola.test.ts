import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { Cause, Effect, FileSystem, Layer } from "effect";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import {
  AuthError,
  GranolaClient,
  GranolaClientOptionsRef,
  getFolderDocs,
  getOwnedDocs,
  getTranscript,
  JsonDecodeError
} from "../src/granola.ts";
import type { Doc } from "../src/granola.ts";
import type * as Scope from "effect/Scope";

const execFileAsync = promisify(execFile);
const mainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const TestPlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodeHttpClient.layerUndici);

function runScoped<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeFileSystem.layer)));
}

function runGranola<A, E>(
  effect: Effect.Effect<A, E, GranolaClient>,
  paths: ReturnType<typeof pathsFor>,
  baseUrl: string
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provide(granolaLayer(paths, baseUrl)));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendGzipJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "content-encoding": "gzip"
  });
  res.end(gzipSync(JSON.stringify(body)));
}

function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Effect.Effect<{ url: string }, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const server = createServer((req, res) => {
        void Promise.resolve(handler(req, res)).catch((error) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(error instanceof Error ? error.stack || error.message : String(error));
        });
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address === "object");

      return {
        server,
        url: `http://127.0.0.1:${address.port}`
      };
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
      ).pipe(Effect.ignore)
  ).pipe(Effect.map(({ url }) => ({ url })));
}

function pathsFor(dir: string) {
  return {
    credsPath: join(dir, ".creds.json"),
    storedAccountsPath: join(dir, "stored-accounts.json"),
    supabasePath: join(dir, "supabase.json")
  };
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function apiDoc(id: string, title: string) {
  return {
    id,
    title,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_viewed_panel: {
      content: { type: "doc" }
    }
  };
}

function granolaLayer(paths: ReturnType<typeof pathsFor>, baseUrl: string) {
  return GranolaClient.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TestPlatformLayer,
        Layer.succeed(GranolaClientOptionsRef, {
          apiBaseUrl: baseUrl,
          workosUrl: `${baseUrl}/workos`,
          credsPath: paths.credsPath,
          storedAccountsPath: paths.storedAccountsPath,
          supabasePath: paths.supabasePath,
          folderFetchConcurrency: 8
        })
      )
    )
  );
}

function failedCommandOutput(error: unknown): {
  code: unknown;
  stdout: string;
  stderr: string;
} {
  const failed = error as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return {
    code: failed.code,
    stdout: String(failed.stdout ?? ""),
    stderr: String(failed.stderr ?? "")
  };
}

const granolaStats = Effect.gen(function* () {
  const granola = yield* GranolaClient;
  return yield* granola.stats;
});

test("Granola client reads cached credentials before app credentials", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let authorization: string | undefined;

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          authorization = req.headers.authorization;
          sendJson(res, 200, { docs: [] });
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "cached-token",
          refreshToken: "cached-refresh",
          clientId: "cached-client"
        })
      );
      yield* fs.writeFileString(
        paths.storedAccountsPath,
        JSON.stringify({
          accounts: JSON.stringify([
            {
              savedAt: 1,
              tokens: JSON.stringify({
                access_token: "stored-token",
                refresh_token: "stored-refresh",
                client_id: "stored-client"
              })
            }
          ])
        })
      );
      const result = yield* runGranola(
        Effect.gen(function* () {
          const docs = yield* getOwnedDocs();
          const stats = yield* granolaStats;
          return { docs, stats };
        }),
        paths,
        server.url
      );

      assert.equal(result.docs.size, 0);
      assert.equal(result.stats.apiCalls, 1);
      assert.equal(result.stats.refreshedCredentials, false);
      assert.equal(authorization, "Bearer cached-token");
    })
  ));

test("Granola client refreshes once on 401 and persists refreshed credentials", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let documentRequests = 0;
      let refreshRequests = 0;

      const server = yield* withServer(async (req, res) => {
        if (req.url === "/v2/get-documents") {
          documentRequests++;
          if (req.headers.authorization === "Bearer old-token") {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("expired");
            return;
          }
          assert.equal(req.headers.authorization, "Bearer new-token");
          sendJson(res, 200, { docs: [] });
          return;
        }

        if (req.url === "/workos") {
          refreshRequests++;
          assert.equal(JSON.parse(await readRequestBody(req)).refresh_token, "old-refresh");
          sendJson(res, 200, {
            access_token: "new-token",
            refresh_token: "new-refresh"
          });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "old-token",
          refreshToken: "old-refresh",
          clientId: "client-id"
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          yield* getOwnedDocs();
          return yield* granolaStats;
        }),
        paths,
        server.url
      );

      assert.equal(documentRequests, 2);
      assert.equal(refreshRequests, 1);
      assert.deepEqual(result, { apiCalls: 1, refreshedCredentials: true });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(paths.credsPath, "utf-8")), {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        clientId: "client-id"
      });
    })
  ));

test("Granola client shares one refresh across concurrent 401s", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let refreshRequests = 0;

      const server = yield* withServer(async (req, res) => {
        if (req.url === "/v1/get-document-transcript") {
          if (req.headers.authorization === "Bearer old-token") {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("expired");
            return;
          }
          assert.equal(req.headers.authorization, "Bearer new-token");
          sendJson(res, 200, [
            {
              source: "microphone",
              text: "hello",
              start_timestamp: "2026-01-01T00:00:00.000Z"
            }
          ]);
          return;
        }

        if (req.url === "/workos") {
          refreshRequests++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          sendJson(res, 200, {
            access_token: "new-token",
            refresh_token: "new-refresh"
          });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "old-token",
          refreshToken: "old-refresh",
          clientId: "client-id"
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          const transcripts = yield* Effect.forEach(
            Array.from({ length: 8 }, (_, index) => `doc-${index}`),
            (id) => getTranscript(id),
            { concurrency: "unbounded" }
          );
          const stats = yield* granolaStats;
          return { transcripts, stats };
        }),
        paths,
        server.url
      );

      assert.equal(refreshRequests, 1);
      assert.equal(result.transcripts.length, 8);
      assert(result.transcripts.every((transcript) => transcript?.[0]?.text === "hello"));
      assert.deepEqual(result.stats, {
        apiCalls: 8,
        refreshedCredentials: true
      });
    })
  ));

test("Granola client reads stored account credentials before legacy Supabase credentials", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let authorization: string | undefined;

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          authorization = req.headers.authorization;
          sendJson(res, 200, { docs: [] });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.storedAccountsPath,
        JSON.stringify({
          accounts: JSON.stringify([
            {
              savedAt: 1,
              tokens: JSON.stringify({
                access_token: "stored-token",
                refresh_token: "stored-refresh",
                client_id: "stored-client"
              })
            }
          ])
        })
      );
      yield* fs.writeFileString(
        paths.supabasePath,
        JSON.stringify({
          workos_tokens: JSON.stringify({
            access_token: "legacy-app-token",
            refresh_token: "legacy-app-refresh",
            client_id: "legacy-client"
          })
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          const docs = yield* getOwnedDocs();
          const stats = yield* granolaStats;
          return { docs, stats };
        }),
        paths,
        server.url
      );

      assert.equal(result.docs.size, 0);
      assert.equal(result.stats.apiCalls, 1);
      assert.equal(result.stats.refreshedCredentials, false);
      assert.equal(authorization, "Bearer stored-token");
    })
  ));

test("Granola client picks the newest stored account and derives client id from its access token", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      const storedAccessToken = fakeJwt({ client_id: "stored-client" });
      let refreshRequests = 0;

      const server = yield* withServer(async (req, res) => {
        if (req.url === "/v2/get-documents") {
          if (req.headers.authorization === `Bearer ${storedAccessToken}`) {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("expired");
            return;
          }
          assert.equal(req.headers.authorization, "Bearer new-token");
          sendJson(res, 200, { docs: [] });
          return;
        }

        if (req.url === "/workos") {
          refreshRequests++;
          assert.deepEqual(JSON.parse(await readRequestBody(req)), {
            client_id: "stored-client",
            grant_type: "refresh_token",
            refresh_token: "stored-refresh"
          });
          sendJson(res, 200, {
            access_token: "new-token",
            refresh_token: "new-refresh"
          });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.storedAccountsPath,
        JSON.stringify({
          accounts: JSON.stringify([
            {
              savedAt: 1,
              tokens: JSON.stringify({
                access_token: fakeJwt({ client_id: "old-stored-client" }),
                refresh_token: "old-stored-refresh"
              })
            },
            {
              savedAt: 2,
              tokens: JSON.stringify({
                access_token: storedAccessToken,
                refresh_token: "stored-refresh"
              })
            }
          ])
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          yield* getOwnedDocs();
          return yield* granolaStats;
        }),
        paths,
        server.url
      );

      assert.equal(refreshRequests, 1);
      assert.deepEqual(result, { apiCalls: 1, refreshedCredentials: true });
      assert.deepEqual(JSON.parse(yield* fs.readFileString(paths.credsPath, "utf-8")), {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        clientId: "stored-client"
      });
    })
  ));

test("Granola client accepts app credentials without client id until refresh is needed", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let authorization: string | undefined;

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          authorization = req.headers.authorization;
          sendJson(res, 200, { docs: [] });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.supabasePath,
        JSON.stringify({
          workos_tokens: JSON.stringify({
            access_token: "app-token",
            refresh_token: "app-refresh"
          })
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          const docs = yield* getOwnedDocs();
          const stats = yield* granolaStats;
          return { docs, stats };
        }),
        paths,
        server.url
      );

      assert.equal(result.docs.size, 0);
      assert.equal(result.stats.apiCalls, 1);
      assert.equal(result.stats.refreshedCredentials, false);
      assert.equal(authorization, "Bearer app-token");
    })
  ));

test("Granola client explains missing client id when refresh is needed", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let documentRequests = 0;
      let refreshRequests = 0;

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          documentRequests++;
          res.writeHead(401, { "content-type": "text/plain" });
          res.end("expired");
          return;
        }

        if (req.url === "/workos") {
          refreshRequests++;
          sendJson(res, 200, {
            access_token: "new-token",
            refresh_token: "new-refresh"
          });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.supabasePath,
        JSON.stringify({
          workos_tokens: JSON.stringify({
            access_token: "app-token",
            refresh_token: "app-refresh"
          })
        })
      );

      const exit = yield* Effect.exit(runGranola(getOwnedDocs(), paths, server.url));
      assert.equal(exit._tag, "Failure");
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
      assert(error instanceof AuthError);
      assert.match(error.message, /Couldn't refresh Granola login tokens/);
      assert.match(error.message, /Run the exporter again/);
      assert.match(error.message, /missing client_id/);

      assert.equal(documentRequests, 1);
      assert.equal(refreshRequests, 0);
    })
  ));

test("Granola client decodes gzip-compressed JSON responses", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          sendGzipJson(res, 200, { docs: [] });
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const docs = yield* runGranola(getOwnedDocs(), paths, server.url);

      assert.equal(docs.size, 0);
    })
  ));

test("Granola client reports schema details for invalid JSON responses", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          sendJson(res, 200, { docs: [{ title: "Missing required fields" }] });
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const exit = yield* Effect.exit(runGranola(getOwnedDocs(), paths, server.url));
      assert.equal(exit._tag, "Failure");
      const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
      assert(error instanceof JsonDecodeError);
      assert.match(error.message, /docs/);
      assert.match(error.message, /id/);
      assert.doesNotMatch(error.message, /SchemaError\(/);
    })
  ));

test("getOwnedDocs accepts documents with a null last_viewed_panel", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          sendJson(res, 200, {
            docs: [
              {
                id: "doc-id",
                title: "No viewed panel",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                last_viewed_panel: null
              }
            ]
          });
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const docs = yield* runGranola(getOwnedDocs(), paths, server.url);

      assert.equal(docs.get("doc-id")?.last_viewed_panel, null);
    })
  ));

test("getOwnedDocs accepts documents with null workspace_id and empty ProseMirror content", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);

      const server = yield* withServer((req, res) => {
        if (req.url === "/v2/get-documents") {
          sendJson(res, 200, {
            docs: [
              {
                id: "doc-id",
                title: "Empty document",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                workspace_id: null,
                last_viewed_panel: {
                  content: { type: "doc" }
                }
              }
            ]
          });
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const docs = yield* runGranola(getOwnedDocs(), paths, server.url);

      assert.equal(docs.get("doc-id")?.workspace_id, null);
      assert.deepEqual(docs.get("doc-id")?.last_viewed_panel?.content, {
        type: "doc"
      });
    })
  ));

test("getFolderDocs hydrates folder documents from include_panels folder lists", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);
      let folderListBody: unknown;
      let batchRequests = 0;

      const server = yield* withServer(async (req, res) => {
        if (req.url === "/v1/get-document-lists-metadata") {
          sendJson(res, 200, {
            lists: {
              "folder-id": {
                id: "folder-id",
                title: "Shared",
                parent_document_list_id: null
              }
            }
          });
          return;
        }

        if (req.url === "/v1/get-document-list") {
          folderListBody = JSON.parse(await readRequestBody(req));
          sendJson(res, 200, {
            id: "folder-id",
            title: "Shared",
            parent_document_list_id: null,
            documents: [apiDoc("folder-doc-id", "Folder doc")]
          });
          return;
        }

        if (req.url === "/v1/get-documents-batch") {
          batchRequests++;
          sendJson(res, 500, { error: "batch should not be needed" });
          return;
        }

        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const result = yield* runGranola(
        Effect.gen(function* () {
          const docs = new Map<string, Doc>();
          const folders = yield* getFolderDocs(docs);
          const stats = yield* granolaStats;
          return { docs, folders, stats };
        }),
        paths,
        server.url
      );

      assert.deepEqual(folderListBody, {
        list_id: "folder-id",
        options: { include_panels: true }
      });
      assert.equal(batchRequests, 0);
      assert.equal(result.docs.get("folder-doc-id")?.title, "Folder doc");
      assert.deepEqual(result.folders.docFolders.get("folder-doc-id"), [["Shared"]]);
      assert.deepEqual(result.stats, {
        apiCalls: 2,
        refreshedCredentials: false
      });
    })
  ));

test("getTranscript treats 404 as unavailable", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const paths = pathsFor(dir);

      const server = yield* withServer((req, res) => {
        if (req.url === "/v1/get-document-transcript") {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("missing");
          return;
        }
        sendJson(res, 404, { error: "unexpected route" });
      });

      yield* fs.writeFileString(
        paths.credsPath,
        JSON.stringify({
          accessToken: "token",
          refreshToken: "refresh",
          clientId: "client-id"
        })
      );

      const transcript = yield* runGranola(getTranscript("doc-id"), paths, server.url);

      assert.equal(transcript, null);
    })
  ));

test("CLI reports missing credentials through the app failure handler", () =>
  runScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const result = yield* Effect.promise(async () => {
        try {
          const output = await execFileAsync(process.execPath, [mainPath], {
            cwd: dir,
            env: { ...process.env, GRANOLA_DEBUG: "1", HOME: dir }
          });
          return { code: 0, stdout: output.stdout, stderr: output.stderr };
        } catch (error) {
          return failedCommandOutput(error);
        }
      });

      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.code, 1);
      assert.match(output, /Granola export failed/);
      assert.match(output, /PlatformError: NotFound/);
    })
  ));
