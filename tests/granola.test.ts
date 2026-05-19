import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { AuthError, GranolaClient, getFolderDocs, getOwnedDocs, getTranscript } from "../src/granola.ts";
import type { Doc } from "../src/granola.ts";

const TestPlatformLayer = Layer.mergeAll(NodeFileSystem.layer, NodeHttpClient.layerUndici);

function run<A, E>(
  effect: Effect.Effect<A, E, GranolaClient>,
  paths: ReturnType<typeof pathsFor>,
  baseUrl: string
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(granolaLayer(paths, baseUrl))));
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
  res.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip" });
  res.end(gzipSync(JSON.stringify(body)));
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ url: string; close: () => Promise<void> }> {
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
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function pathsFor(dir: string) {
  return {
    credsPath: join(dir, ".creds.json"),
    storedAccountsPath: join(dir, "stored-accounts.json"),
    supabasePath: join(dir, "supabase.json"),
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
      content: { type: "doc" },
    },
  };
}

function granolaLayer(paths: ReturnType<typeof pathsFor>, baseUrl: string) {
  return GranolaClient.layerWithOptions({
    apiBaseUrl: baseUrl,
    workosUrl: `${baseUrl}/workos`,
    credsPath: paths.credsPath,
    storedAccountsPath: paths.storedAccountsPath,
    supabasePath: paths.supabasePath,
  }).pipe(Layer.provide(TestPlatformLayer));
}

const granolaStats = Effect.gen(function* () {
  const granola = yield* GranolaClient;
  return yield* granola.stats;
});

test("Granola client reads cached credentials before app credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let authorization: string | undefined;

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      authorization = req.headers.authorization;
      sendJson(res, 200, { docs: [] });
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(
      paths.credsPath,
      JSON.stringify({ accessToken: "cached-token", refreshToken: "cached-refresh", clientId: "cached-client" })
    );
    await writeFile(
      paths.storedAccountsPath,
      JSON.stringify({
        accounts: JSON.stringify([
          {
            savedAt: 1,
            tokens: JSON.stringify({
              access_token: "stored-token",
              refresh_token: "stored-refresh",
              client_id: "stored-client",
            }),
          },
        ]),
      })
    );
    const result = await run(Effect.gen(function* () {
      const docs = yield* getOwnedDocs(() => Effect.void);
      const stats = yield* granolaStats;
      return { docs, stats };
    }), paths, server.url);

    assert.equal(result.docs.size, 0);
    assert.equal(result.stats.apiCalls, 1);
    assert.equal(result.stats.refreshedCredentials, false);
    assert.equal(authorization, "Bearer cached-token");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client refreshes once on 401 and persists refreshed credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let documentRequests = 0;
  let refreshRequests = 0;

  const server = await withServer(async (req, res) => {
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
      sendJson(res, 200, { access_token: "new-token", refresh_token: "new-refresh" });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "old-token", refreshToken: "old-refresh", clientId: "client-id" }));

    const result = await run(Effect.gen(function* () {
      yield* getOwnedDocs(() => Effect.void);
      return yield* granolaStats;
    }), paths, server.url);

    assert.equal(documentRequests, 2);
    assert.equal(refreshRequests, 1);
    assert.deepEqual(result, { apiCalls: 1, refreshedCredentials: true });
    assert.deepEqual(JSON.parse(await readFile(paths.credsPath, "utf-8")), {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      clientId: "client-id",
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client shares one refresh across concurrent 401s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let refreshRequests = 0;

  const server = await withServer(async (req, res) => {
    if (req.url === "/v1/get-document-transcript") {
      if (req.headers.authorization === "Bearer old-token") {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("expired");
        return;
      }
      assert.equal(req.headers.authorization, "Bearer new-token");
      sendJson(res, 200, [{ source: "microphone", text: "hello", start_timestamp: "2026-01-01T00:00:00.000Z" }]);
      return;
    }

    if (req.url === "/workos") {
      refreshRequests++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      sendJson(res, 200, { access_token: "new-token", refresh_token: "new-refresh" });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "old-token", refreshToken: "old-refresh", clientId: "client-id" }));

    const result = await run(Effect.gen(function* () {
      const transcripts = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, index) => `doc-${index}`),
        (id) => getTranscript(id),
        { concurrency: "unbounded" }
      );
      const stats = yield* granolaStats;
      return { transcripts, stats };
    }), paths, server.url);

    assert.equal(refreshRequests, 1);
    assert.equal(result.transcripts.length, 8);
    assert(result.transcripts.every((transcript) => transcript?.[0]?.text === "hello"));
    assert.deepEqual(result.stats, { apiCalls: 8, refreshedCredentials: true });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client reads stored account credentials before legacy Supabase credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let authorization: string | undefined;

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      authorization = req.headers.authorization;
      sendJson(res, 200, { docs: [] });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(
      paths.storedAccountsPath,
      JSON.stringify({
        accounts: JSON.stringify([
          {
            savedAt: 1,
            tokens: JSON.stringify({
              access_token: "stored-token",
              refresh_token: "stored-refresh",
              client_id: "stored-client",
            }),
          },
        ]),
      })
    );
    await writeFile(
      paths.supabasePath,
      JSON.stringify({
        workos_tokens: JSON.stringify({
          access_token: "legacy-app-token",
          refresh_token: "legacy-app-refresh",
          client_id: "legacy-client",
        }),
      })
    );

    const result = await run(Effect.gen(function* () {
      const docs = yield* getOwnedDocs(() => Effect.void);
      const stats = yield* granolaStats;
      return { docs, stats };
    }), paths, server.url);

    assert.equal(result.docs.size, 0);
    assert.equal(result.stats.apiCalls, 1);
    assert.equal(result.stats.refreshedCredentials, false);
    assert.equal(authorization, "Bearer stored-token");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client picks the newest stored account and derives client id from its access token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  const storedAccessToken = fakeJwt({ client_id: "stored-client" });
  let refreshRequests = 0;

  const server = await withServer(async (req, res) => {
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
        refresh_token: "stored-refresh",
      });
      sendJson(res, 200, { access_token: "new-token", refresh_token: "new-refresh" });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(
      paths.storedAccountsPath,
      JSON.stringify({
        accounts: JSON.stringify([
          {
            savedAt: 1,
            tokens: JSON.stringify({
              access_token: fakeJwt({ client_id: "old-stored-client" }),
              refresh_token: "old-stored-refresh",
            }),
          },
          {
            savedAt: 2,
            tokens: JSON.stringify({
              access_token: storedAccessToken,
              refresh_token: "stored-refresh",
            }),
          },
        ]),
      })
    );

    const result = await run(Effect.gen(function* () {
      yield* getOwnedDocs(() => Effect.void);
      return yield* granolaStats;
    }), paths, server.url);

    assert.equal(refreshRequests, 1);
    assert.deepEqual(result, { apiCalls: 1, refreshedCredentials: true });
    assert.deepEqual(JSON.parse(await readFile(paths.credsPath, "utf-8")), {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      clientId: "stored-client",
    });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client accepts app credentials without client id until refresh is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let authorization: string | undefined;

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      authorization = req.headers.authorization;
      sendJson(res, 200, { docs: [] });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(
      paths.supabasePath,
      JSON.stringify({
        workos_tokens: JSON.stringify({ access_token: "app-token", refresh_token: "app-refresh" }),
      })
    );

    const result = await run(Effect.gen(function* () {
      const docs = yield* getOwnedDocs(() => Effect.void);
      const stats = yield* granolaStats;
      return { docs, stats };
    }), paths, server.url);

    assert.equal(result.docs.size, 0);
    assert.equal(result.stats.apiCalls, 1);
    assert.equal(result.stats.refreshedCredentials, false);
    assert.equal(authorization, "Bearer app-token");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client explains missing client id when refresh is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let documentRequests = 0;
  let refreshRequests = 0;

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      documentRequests++;
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("expired");
      return;
    }

    if (req.url === "/workos") {
      refreshRequests++;
      sendJson(res, 200, { access_token: "new-token", refresh_token: "new-refresh" });
      return;
    }

    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(
      paths.supabasePath,
      JSON.stringify({
        workos_tokens: JSON.stringify({ access_token: "app-token", refresh_token: "app-refresh" }),
      })
    );

    await assert.rejects(
      run(Effect.gen(function* () {
        return yield* getOwnedDocs(() => Effect.void);
      }), paths, server.url),
      (error: unknown) => {
        assert(error instanceof AuthError);
        assert.match(error.message, /Couldn't refresh Granola login tokens/);
        assert.match(error.message, /Run the exporter again/);
        assert.match(error.message, /missing client_id/);
        return true;
      }
    );

    assert.equal(documentRequests, 1);
    assert.equal(refreshRequests, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Granola client decodes gzip-compressed JSON responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      sendGzipJson(res, 200, { docs: [] });
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "token", refreshToken: "refresh", clientId: "client-id" }));

    const docs = await run(getOwnedDocs(() => Effect.void), paths, server.url);

    assert.equal(docs.size, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getOwnedDocs accepts documents with a null last_viewed_panel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);

  const server = await withServer((req, res) => {
    if (req.url === "/v2/get-documents") {
      sendJson(res, 200, {
        docs: [
          {
            id: "doc-id",
            title: "No viewed panel",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            last_viewed_panel: null,
          },
        ],
      });
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "token", refreshToken: "refresh", clientId: "client-id" }));

    const docs = await run(getOwnedDocs(() => Effect.void), paths, server.url);

    assert.equal(docs.get("doc-id")?.last_viewed_panel, null);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getOwnedDocs accepts documents with null workspace_id and empty ProseMirror content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);

  const server = await withServer((req, res) => {
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
              content: { type: "doc" },
            },
          },
        ],
      });
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "token", refreshToken: "refresh", clientId: "client-id" }));

    const docs = await run(getOwnedDocs(() => Effect.void), paths, server.url);

    assert.equal(docs.get("doc-id")?.workspace_id, null);
    assert.deepEqual(docs.get("doc-id")?.last_viewed_panel?.content, { type: "doc" });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getFolderDocs hydrates folder documents from include_panels folder lists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);
  let folderListBody: unknown;
  let batchRequests = 0;

  const server = await withServer(async (req, res) => {
    if (req.url === "/v1/get-document-lists-metadata") {
      sendJson(res, 200, {
        lists: {
          "folder-id": {
            id: "folder-id",
            title: "Shared",
            parent_document_list_id: null,
          },
        },
      });
      return;
    }

    if (req.url === "/v1/get-document-list") {
      folderListBody = JSON.parse(await readRequestBody(req));
      sendJson(res, 200, {
        id: "folder-id",
        title: "Shared",
        parent_document_list_id: null,
        documents: [apiDoc("folder-doc-id", "Folder doc")],
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

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "token", refreshToken: "refresh", clientId: "client-id" }));

    const result = await run(Effect.gen(function* () {
      const docs = new Map<string, Doc>();
      const folders = yield* getFolderDocs(docs, () => Effect.void);
      const stats = yield* granolaStats;
      return { docs, folders, stats };
    }), paths, server.url);

    assert.deepEqual(folderListBody, { list_id: "folder-id", options: { include_panels: true } });
    assert.equal(batchRequests, 0);
    assert.equal(result.docs.get("folder-doc-id")?.title, "Folder doc");
    assert.deepEqual(result.folders.docFolders.get("folder-doc-id"), [["Shared"]]);
    assert.deepEqual(result.stats, { apiCalls: 2, refreshedCredentials: false });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getTranscript treats 404 as unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "granola-client-"));
  const paths = pathsFor(dir);

  const server = await withServer((req, res) => {
    if (req.url === "/v1/get-document-transcript") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    sendJson(res, 404, { error: "unexpected route" });
  });

  try {
    await writeFile(paths.credsPath, JSON.stringify({ accessToken: "token", refreshToken: "refresh", clientId: "client-id" }));

    const transcript = await run(getTranscript("doc-id"), paths, server.url);

    assert.equal(transcript, null);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
