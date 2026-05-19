import type { JSONContent } from "@tiptap/core";
import { Context, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import { HttpClientError } from "effect/unstable/http/HttpClientError";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib";
import { dim } from "yoctocolors";

const API = "https://api.granola.ai";
const WORKOS = "https://api.workos.com/user_management/authenticate";
const DEFAULT_STORED_ACCOUNTS_RELATIVE_PATH = "Library/Application Support/Granola/stored-accounts.json";
const DEFAULT_SUPABASE_RELATIVE_PATH = "Library/Application Support/Granola/supabase.json";
const DEFAULT_CREDS_PATH = "./.creds.json";
const FOLDER_FETCH_CONCURRENCY = 8;
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const brotliDecompressAsync = promisify(brotliDecompress);
const zstdDecompressAsync = promisify(zstdDecompress);

export interface GranolaClientStats {
  apiCalls: number;
  refreshedCredentials: boolean;
}

type JsonSchema = Schema.Top & { readonly DecodingServices: never };

export interface GranolaClientOptions {
  apiBaseUrl?: string;
  workosUrl?: string;
  credsPath?: string;
  storedAccountsPath?: string;
  supabasePath?: string;
}

interface ResolvedGranolaClientOptions {
  apiBaseUrl: string;
  workosUrl: string;
  credsPath: string;
  storedAccountsPath: string;
  supabasePath: string;
}

export interface ProseMirrorNode extends JSONContent {
  type: string;
  content?: ProseMirrorNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

export interface ProseMirrorDoc extends JSONContent {
  type: "doc";
  content?: ProseMirrorNode[];
}

export interface FolderDocsResult {
  docFolders: Map<string, string[][]>;
  granolaFolders: number;
}

export class ApiError extends Schema.TaggedErrorClass<ApiError>()("ApiError", {
  path: Schema.String,
  status: Schema.Number,
}) {
  get message(): string {
    return `${this.path} => ${this.status}`;
  }
}

export class ApiRequestError extends Schema.TaggedErrorClass<ApiRequestError>()("ApiRequestError", {
  path: Schema.String,
  cause: Schema.instanceOf(HttpClientError),
}) {
  get message(): string {
    return `${this.path} request failed: ${String(this.cause)}`;
  }
}

export class JsonDecodeError extends Schema.TaggedErrorClass<JsonDecodeError>()("JsonDecodeError", {
  source: Schema.String,
  cause: Schema.Unknown,
}) {
  get message(): string {
    return `${this.source} JSON decode failed: ${String(this.cause)}`;
  }
}

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  source: Schema.String,
}) {
  get message(): string {
    return [
      "Couldn't refresh Granola login tokens.",
      "",
      "Granola auth data is missing the client id needed to refresh expired login tokens. The current access token was rejected, so the exporter cannot continue.",
      "",
      "Try this:",
      "1. Open the Granola desktop app and confirm you are signed in.",
      "2. Quit and reopen Granola.",
      "3. Run the exporter again.",
      "4. If it still fails, sign out of Granola and sign back in, then retry.",
      "",
      `Technical detail: ${this.source} is missing client_id.`,
    ].join("\n");
  }
}

export type GranolaError = ApiError | ApiRequestError | JsonDecodeError | AuthError | PlatformError;
export type GranolaClientServices = FileSystem.FileSystem | HttpClient.HttpClient;
export type StatusEffect = (text: string) => Effect.Effect<void>;

export class GranolaClient extends Context.Service<GranolaClient, {
  post<S extends JsonSchema>(path: string, body: unknown, schema: S): Effect.Effect<S["Type"], GranolaError>;
  stats: Effect.Effect<GranolaClientStats>;
}>()("granola/GranolaClient") {
  static readonly layer: Layer.Layer<GranolaClient, GranolaError, GranolaClientServices> = Layer.effect(
    GranolaClient,
    Effect.suspend(() => makeGranolaClient())
  );

  static layerWithOptions(options: GranolaClientOptions): Layer.Layer<GranolaClient, GranolaError, GranolaClientServices> {
    return Layer.effect(GranolaClient, Effect.suspend(() => makeGranolaClient(options)));
  }
}

const NonEmptyString = Schema.NonEmptyString;

const CredsSchema = Schema.Struct({
  accessToken: NonEmptyString,
  refreshToken: NonEmptyString,
  clientId: NonEmptyString,
});

type Creds = Schema.Schema.Type<typeof CredsSchema>;
type LoadedCreds = {
  accessToken: string;
  refreshToken: string;
  clientId?: string;
  source: string;
};

const SupabaseSchema = Schema.Struct({
  workos_tokens: NonEmptyString,
});

const StoredAccountsSchema = Schema.Struct({
  accounts: NonEmptyString,
});

const StoredAccountSchema = Schema.Struct({
  tokens: NonEmptyString,
  savedAt: Schema.optionalKey(Schema.Number),
});

const WorkosTokensSchema = Schema.Struct({
  access_token: NonEmptyString,
  refresh_token: NonEmptyString,
  client_id: Schema.optionalKey(NonEmptyString),
});

const WorkosRefreshSchema = Schema.Struct({
  access_token: NonEmptyString,
  refresh_token: NonEmptyString,
});

const ProseMirrorNodeSchema: Schema.Codec<ProseMirrorNode> = Schema.Struct({
  type: NonEmptyString,
  content: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.suspend(() => ProseMirrorNodeSchema)))),
  text: Schema.optionalKey(Schema.String),
  marks: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.Struct({
      type: NonEmptyString,
      attrs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    })))
  ),
  attrs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

const ProseMirrorDocSchema: Schema.Codec<ProseMirrorDoc> = Schema.Struct({
  type: Schema.Literal("doc"),
  content: Schema.optionalKey(Schema.mutable(Schema.Array(ProseMirrorNodeSchema))),
});

const DocSchema = Schema.Struct({
  id: NonEmptyString,
  title: Schema.NullOr(Schema.String),
  created_at: NonEmptyString,
  updated_at: NonEmptyString,
  workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  last_viewed_panel: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        content: Schema.Union([ProseMirrorDocSchema, Schema.String]),
      })
    )
  ),
});

export type Doc = Schema.Schema.Type<typeof DocSchema>;

const DocsResponseSchema = Schema.Struct({
  docs: Schema.Array(DocSchema),
});

const FolderStruct = Schema.Struct({
  id: NonEmptyString,
  title: Schema.String,
  parent_document_list_id: Schema.NullOr(Schema.String),
});

type Folder = Schema.Schema.Type<typeof FolderStruct>;

const FolderMetadataResponseSchema = Schema.Struct({
  lists: Schema.Record(Schema.String, FolderStruct),
});

const FolderDetailsSchema = Schema.Struct({
  ...FolderStruct.fields,
  documents: Schema.Array(DocSchema),
});

const TranscriptSegmentSchema = Schema.Struct({
  source: NonEmptyString,
  text: Schema.String,
  start_timestamp: NonEmptyString,
});

export type TranscriptSegment = Schema.Schema.Type<typeof TranscriptSegmentSchema>;

const TranscriptSchema = Schema.Array(TranscriptSegmentSchema);

const decodeUnknown = Effect.fn("granola.decodeUnknown")(<S extends Schema.Top>(
  schema: S,
  source: string,
  value: unknown
): Effect.Effect<S["Type"], JsonDecodeError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new JsonDecodeError({ source, cause }))
  ));

const parseJson = Effect.fn("granola.parseJson")((source: string, raw: string): Effect.Effect<unknown, JsonDecodeError> =>
  Effect.try({
    try: () => JSON.parse(raw),
    catch: (cause) => new JsonDecodeError({ source, cause }),
  })
);

const parseCreds = Effect.fn("granola.parseCreds")(function* (raw: string, source: string) {
  const parsed = yield* parseJson(source, raw);
  const creds = yield* decodeUnknown(CredsSchema, source, parsed);
  return { ...creds, source };
});

function clientIdFromAccessToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    if (!decoded || typeof decoded !== "object" || !("client_id" in decoded)) return undefined;

    const clientId = decoded.client_id;
    return typeof clientId === "string" && clientId.length > 0 ? clientId : undefined;
  } catch {
    return undefined;
  }
}

function credsFromWorkosTokens(tokens: Schema.Schema.Type<typeof WorkosTokensSchema>, source: string): LoadedCreds {
  const clientId = tokens.client_id ?? clientIdFromAccessToken(tokens.access_token);

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    ...(clientId ? { clientId } : {}),
    source,
  };
}

const parseSupabaseCreds = Effect.fn("granola.parseSupabaseCreds")(function* (raw: string, source: string) {
  const parsed = yield* parseJson(source, raw);
  const supabase = yield* decodeUnknown(SupabaseSchema, source, parsed);
  const tokensSource = `${source}:workos_tokens`;
  const tokensJson = yield* parseJson(tokensSource, supabase.workos_tokens);
  const tokens = yield* decodeUnknown(WorkosTokensSchema, tokensSource, tokensJson);

  return credsFromWorkosTokens(tokens, tokensSource);
});

const parseStoredAccountsCreds = Effect.fn("granola.parseStoredAccountsCreds")(function* (raw: string, source: string) {
  const parsed = yield* parseJson(source, raw);
  const storedAccounts = yield* decodeUnknown(StoredAccountsSchema, source, parsed);
  const accountsJson = yield* parseJson(`${source}:accounts`, storedAccounts.accounts);
  const accounts = yield* decodeUnknown(Schema.Array(StoredAccountSchema), `${source}:accounts`, accountsJson);

  let selected: { account: Schema.Schema.Type<typeof StoredAccountSchema>; index: number } | undefined;
  for (const [index, account] of accounts.entries()) {
    if (!selected || (account.savedAt ?? 0) > (selected.account.savedAt ?? 0)) {
      selected = { account, index };
    }
  }

  if (!selected) {
    return yield* new JsonDecodeError({ source: `${source}:accounts`, cause: new Error("No stored Granola accounts found") });
  }

  const tokensSource = `${source}:accounts[${selected.index}].tokens`;
  const tokensJson = yield* parseJson(tokensSource, selected.account.tokens);
  const tokens = yield* decodeUnknown(WorkosTokensSchema, tokensSource, tokensJson);

  return credsFromWorkosTokens(tokens, tokensSource);
});

function isNotFound(error: GranolaError): boolean {
  return error._tag === "PlatformError" && error.reason._tag === "NotFound";
}

const loadCreds = Effect.fn("granola.loadCreds")(function* (
  fs: FileSystem.FileSystem,
  options: ResolvedGranolaClientOptions
) {
  return yield* fs.readFileString(options.credsPath, "utf-8").pipe(
    Effect.flatMap((raw) => parseCreds(raw, options.credsPath)),
    Effect.catch((error) => {
      if (!isNotFound(error)) return Effect.fail(error);
      return fs.readFileString(options.storedAccountsPath, "utf-8").pipe(
        Effect.flatMap((raw) => parseStoredAccountsCreds(raw, options.storedAccountsPath)),
        Effect.catch((storedAccountsError) => {
          if (!isNotFound(storedAccountsError)) return Effect.fail(storedAccountsError);
          return fs.readFileString(options.supabasePath, "utf-8").pipe(
            Effect.flatMap((raw) => parseSupabaseCreds(raw, options.supabasePath))
          );
        })
      );
    })
  );
});

const saveCreds = Effect.fn("granola.saveCreds")(function* (
  fs: FileSystem.FileSystem,
  options: ResolvedGranolaClientOptions,
  value: Creds
) {
  const serialized = {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    clientId: value.clientId,
  };
  yield* fs.writeFileString(options.credsPath, JSON.stringify(serialized), { mode: 0o600 });
});

const postRequest = Effect.fn("granola.postRequest")(function* (
  client: HttpClient.HttpClient,
  url: string,
  path: string,
  headers: Record<string, string>,
  body: unknown
) {
  const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(url, { headers }), body).pipe(
    Effect.mapError((cause: HttpBodyError) => new JsonDecodeError({ source: `${path} request`, cause }))
  );

  return yield* client.execute(request).pipe(
    Effect.mapError((cause) => new ApiRequestError({ path, cause }))
  );
});

const decodeResponseBody = Effect.fn("granola.decodeResponseBody")(function* (
  source: string,
  response: HttpClientResponse,
  body: Uint8Array
) {
  let decoded = Buffer.from(body);
  const contentEncoding = response.headers["content-encoding"];
  if (!contentEncoding) return decoded;

  for (const encoding of contentEncoding.split(",").map((value) => value.trim().toLowerCase()).reverse()) {
    switch (encoding) {
      case "identity":
        break;
      case "gzip":
      case "x-gzip":
        decoded = yield* Effect.tryPromise({
          try: () => gunzipAsync(decoded),
          catch: (cause) => new JsonDecodeError({ source: `${source} gzip response`, cause }),
        });
        break;
      case "deflate":
        decoded = yield* Effect.tryPromise({
          try: () => inflateAsync(decoded),
          catch: (cause) => new JsonDecodeError({ source: `${source} deflate response`, cause }),
        });
        break;
      case "br":
        decoded = yield* Effect.tryPromise({
          try: () => brotliDecompressAsync(decoded),
          catch: (cause) => new JsonDecodeError({ source: `${source} br response`, cause }),
        });
        break;
      case "zstd":
        decoded = yield* Effect.tryPromise({
          try: () => zstdDecompressAsync(decoded),
          catch: (cause) => new JsonDecodeError({ source: `${source} zstd response`, cause }),
        });
        break;
      default:
        return yield* new JsonDecodeError({ source, cause: new Error(`Unsupported content-encoding: ${encoding}`) });
    }
  }

  return decoded;
});

const decodeResponseJson = Effect.fn("granola.decodeResponseJson")(function* <S extends Schema.Top>(
  schema: S,
  source: string,
  response: HttpClientResponse
) {
  const body = yield* response.arrayBuffer.pipe(
    Effect.map((arrayBuffer) => new Uint8Array(arrayBuffer)),
    Effect.mapError((cause) => new JsonDecodeError({ source, cause }))
  );
  const decodedBody = yield* decodeResponseBody(source, response, body);
  const json = yield* parseJson(source, new TextDecoder().decode(decodedBody));
  return yield* decodeUnknown(schema, source, json);
});

const refresh = Effect.fn("granola.refresh")(function* (
  fs: FileSystem.FileSystem,
  client: HttpClient.HttpClient,
  options: ResolvedGranolaClientOptions,
  refreshedCredentials: Ref.Ref<boolean>,
  currentCreds: LoadedCreds
) {
  if (!currentCreds.clientId) {
    return yield* new AuthError({ source: currentCreds.source });
  }

  const response = yield* postRequest(
    client,
    options.workosUrl,
    options.workosUrl,
    { "Content-Type": "application/json" },
    {
      client_id: currentCreds.clientId,
      grant_type: "refresh_token",
      refresh_token: currentCreds.refreshToken,
    }
  );

  if (response.status < 200 || response.status >= 300) {
    return yield* new ApiError({ path: options.workosUrl, status: response.status });
  }

  const data = yield* decodeResponseJson(WorkosRefreshSchema, options.workosUrl, response);
  const refreshed = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    clientId: currentCreds.clientId,
    source: options.credsPath,
  };
  yield* Ref.set(refreshedCredentials, true);
  yield* saveCreds(fs, options, refreshed);
  return refreshed;
});

function resolveOptions(options: GranolaClientOptions): ResolvedGranolaClientOptions {
  return {
    apiBaseUrl: options.apiBaseUrl ?? API,
    workosUrl: options.workosUrl ?? WORKOS,
    credsPath: options.credsPath ?? DEFAULT_CREDS_PATH,
    storedAccountsPath: options.storedAccountsPath ?? join(homedir(), DEFAULT_STORED_ACCOUNTS_RELATIVE_PATH),
    supabasePath: options.supabasePath ?? join(homedir(), DEFAULT_SUPABASE_RELATIVE_PATH),
  };
}

const makeGranolaClient = Effect.fn("granola.makeGranolaClient")(function* (options: GranolaClientOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const client = yield* HttpClient.HttpClient;
  const resolvedOptions = resolveOptions(options);
  const loadedCreds = yield* loadCreds(fs, resolvedOptions);
  const creds = yield* Ref.make(loadedCreds);
  const apiCalls = yield* Ref.make(0);
  const refreshedCredentials = yield* Ref.make(false);
  const refreshSemaphore = yield* Semaphore.make(1);

  const post: GranolaClient["Service"]["post"] = Effect.fn("granola.GranolaClient.post")(function* <S extends JsonSchema>(
    path: string,
    body: unknown,
    schema: S
  ) {
    yield* Ref.update(apiCalls, (value) => value + 1);
    let currentCreds = yield* Ref.get(creds);

    const requestWithCreds = (accessToken: string) =>
      postRequest(
        client,
        `${resolvedOptions.apiBaseUrl}${path}`,
        path,
        {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Granola/7.220.0",
          "X-Client-Version": "7.220.0",
          "X-Granola-Platform": "darwin",
        },
        body
      );

    let response = yield* requestWithCreds(currentCreds.accessToken);
    if (response.status === 401) {
      const rejectedAccessToken = currentCreds.accessToken;
      currentCreds = yield* refreshSemaphore.withPermit(Effect.gen(function* () {
        const latestCreds = yield* Ref.get(creds);
        if (latestCreds.accessToken !== rejectedAccessToken) return latestCreds;

        const refreshedCreds = yield* refresh(fs, client, resolvedOptions, refreshedCredentials, latestCreds);
        yield* Ref.set(creds, refreshedCreds);
        return refreshedCreds;
      }));
      response = yield* requestWithCreds(currentCreds.accessToken);
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new ApiError({ path, status: response.status });
    }

    return yield* decodeResponseJson(schema, path, response);
  });

  return GranolaClient.of({
    post,
    stats: Effect.fn("granola.GranolaClient.stats")(function* () {
      return {
        apiCalls: yield* Ref.get(apiCalls),
        refreshedCredentials: yield* Ref.get(refreshedCredentials),
      };
    })(),
  });
});

export const getTranscript = Effect.fn("granola.getTranscript")(function (
  documentId: string
) {
  return Effect.gen(function* () {
    const granola = yield* GranolaClient;
    return yield* granola.post("/v1/get-document-transcript", { document_id: documentId }, TranscriptSchema).pipe(
      Effect.catchTag("ApiError", (error) => (error.status === 404 ? Effect.succeed(null) : Effect.fail(error)))
    );
  });
});

export const getOwnedDocs = Effect.fn("granola.getOwnedDocs")(function* (
  setStatus: StatusEffect
) {
  const granola = yield* GranolaClient;
  const docsById = new Map<string, Doc>();
  let offset = 0;
  const limit = 100;

  while (true) {
    yield* setStatus(`Fetching documents ${dim(`(${docsById.size} loaded)`)}`);
    const { docs } = yield* granola.post("/v2/get-documents", {
      limit,
      offset,
      include_last_viewed_panel: true,
    }, DocsResponseSchema);

    for (const doc of docs) docsById.set(doc.id, doc);
    if (docs.length < limit) break;
    offset += limit;
  }

  return docsById;
});

function folderParts(folder: Folder, folders: Readonly<Record<string, Folder>>): string[] {
  const parts = [folder.title];
  let parent = folder.parent_document_list_id ? folders[folder.parent_document_list_id] : undefined;

  while (parent) {
    parts.unshift(parent.title);
    parent = parent.parent_document_list_id ? folders[parent.parent_document_list_id] : undefined;
  }

  return parts;
}

export const getFolderDocs = Effect.fn("granola.getFolderDocs")(function* (
  existingDocs: Map<string, Doc>,
  setStatus: StatusEffect
) {
  const granola = yield* GranolaClient;
  const docFolders = new Map<string, string[][]>();
  const metadata = yield* granola.post("/v1/get-document-lists-metadata", {}, FolderMetadataResponseSchema);

  const folders = metadata.lists;
  const folderList = Object.values(folders);
  const folderDetails = yield* Effect.forEach(folderList, (folder, index) =>
    Effect.gen(function* () {
      yield* setStatus(`Fetching folders ${dim(`(${index + 1}/${folderList.length})`)} ${folder.title}`);
      return yield* granola.post("/v1/get-document-list", {
        list_id: folder.id,
        options: { include_panels: true },
      }, FolderDetailsSchema);
    }), { concurrency: FOLDER_FETCH_CONCURRENCY });

  for (const details of folderDetails) {
    const parts = folderParts(details, folders);

    for (const doc of details.documents) {
      const paths = docFolders.get(doc.id) || [];
      paths.push(parts);
      docFolders.set(doc.id, paths);
      if (!existingDocs.has(doc.id)) existingDocs.set(doc.id, doc);
    }
  }

  return {
    docFolders,
    granolaFolders: folderList.length,
  };
});
