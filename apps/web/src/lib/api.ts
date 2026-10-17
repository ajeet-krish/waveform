/**
 * The HTTP client for the Waveform API: auth, push, and pull.
 *
 * One factory, one base URL, one bearer token. Every request carries
 * `Authorization: Bearer <token>` when a token exists and
 * `Content-Type: application/json` when it sends a body. Failures are
 * classified once into ApiFailureKind so the sync engine can decide
 * between abort, retry, and sign-out: a 401 fires onAuthExpired and
 * becomes "auth-expired", transport failures become "offline" or
 * "timeout", and every other non-2xx becomes "client" or "server" with
 * the `{ code, message }` envelope parsed when the body carries one.
 */

import type {
  ApiErrorCode,
  AuthResponse,
  BoardWindow,
  BoardsResponse,
  LoginRequest,
  PullPage,
  PushOp,
  PushResponse,
  SignupRequest,
  SyncEntity,
  User,
} from "@waveform/api-types";

/** How one API call failed, at the granularity the caller acts on. */
export type ApiFailureKind = "auth-expired" | "offline" | "timeout" | "client" | "server";

/** The `{ code, message }` envelope every failing endpoint returns. */
type ApiErrorEnvelope = { code: ApiErrorCode; message: string };

export type ApiErrorOptions = {
  status?: number | null;
  code?: ApiErrorCode | null;
  cause?: unknown;
};

/** One failed API call: kind for control flow, status/code for display. */
export class ApiError extends Error {
  readonly kind: ApiFailureKind;
  /** HTTP status when a response arrived, null for transport failures. */
  readonly status: number | null;
  /** The server's machine-readable code, when the body carried one. */
  readonly code: ApiErrorCode | null;

  constructor(kind: ApiFailureKind, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** The fetch shape the client needs; tests inject a stub. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * How long one request may take from dispatch to a fully parsed body
 * before its AbortController fires. Without a deadline a hung socket
 * would keep the sync engine waiting forever.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Normalizes a configured base URL: trim, drop trailing slashes. */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** True for names the browser treats as loopback. */
function isLoopback(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

/** The page's hostname when one exists; "localhost" outside a browser. */
function currentHostname(): string {
  const location = (globalThis as { location?: { hostname?: string } }).location;
  return location?.hostname ?? "localhost";
}

/**
 * Resolves the API base URL in order: caller override, environment
 * value, then the localhost fallback `http://localhost:8080` when the
 * page itself is on loopback. A non-loopback page with neither an
 * override nor an env value is misconfigured and throws: silently
 * calling the page's own origin would send bearer tokens to the static
 * host.
 *
 * @throws Error when no base URL is configured and the host is not loopback.
 */
export function resolveApiBaseUrl(
  override?: string | null,
  env?: string | null,
  hostname?: string,
): string {
  if (override !== undefined && override !== null && override.trim().length > 0) {
    return normalizeBaseUrl(override);
  }
  if (env !== undefined && env !== null && env.trim().length > 0) {
    return normalizeBaseUrl(env);
  }
  if (isLoopback(hostname ?? currentHostname())) {
    return "http://localhost:8080";
  }
  throw new Error(
    "No API base URL is configured: set VITE_API_BASE_URL (or pass an override) before signing in.",
  );
}

/** Pull query parameters for one entity page. */
export type PullParams = {
  entity: SyncEntity;
  /** Opaque cursor from the previous page's next_cursor; absent starts over. */
  cursor?: string | null;
  /** Requested page size; the server clamps it to pull_page_size. */
  limit?: number;
};

/** The API surface the sync engine and the auth store consume. */
export type ApiClient = {
  signup(input: SignupRequest): Promise<AuthResponse>;
  login(input: LoginRequest): Promise<AuthResponse>;
  /** Always 204 and idempotent server-side; resolves void. */
  logout(): Promise<void>;
  me(): Promise<User>;
  push(ops: PushOp[]): Promise<PushResponse>;
  pull(params: PullParams): Promise<PullPage>;
  /** Server-aggregated social boards for one trailing window. */
  boards(window: BoardWindow): Promise<BoardsResponse>;
};

export type ApiClientOptions = {
  /** Base URL without a trailing slash, from resolveApiBaseUrl. */
  baseUrl: string;
  /** Bearer token; absent while signed out. */
  token?: string | null;
  /** Fetch override for tests; defaults to the global fetch. */
  fetchFn?: FetchFn;
  /** Called once per 401 before the ApiError is thrown. */
  onAuthExpired?: () => void;
  /** Per-request deadline in milliseconds; defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a failing response's `{ code, message }` envelope, tolerating a
 * non-JSON or malformed body by returning null.
 */
async function readEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  if (
    isRecord(raw) &&
    typeof raw.code === "string" &&
    typeof raw.message === "string" &&
    raw.message.length > 0
  ) {
    return { code: raw.code as ApiErrorCode, message: raw.message };
  }
  return null;
}

/** Maps a thrown fetch failure to timeout vs offline by error name. */
function transportError(cause: unknown): ApiError {
  let name = "";
  if (cause !== null && typeof cause === "object" && "name" in cause) {
    const value = (cause as { name: unknown }).name;
    if (typeof value === "string") {
      name = value;
    }
  }
  if (name === "AbortError" || name === "TimeoutError") {
    return new ApiError("timeout", "The request timed out.", { cause });
  }
  return new ApiError("offline", "The server could not be reached.", { cause });
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function send<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T | undefined> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined && options.token !== null && options.token.length > 0) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const controller = new AbortController();
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (payload !== undefined) {
      init.body = payload;
    }
    // The deadline stays armed past the headers so a body that hangs
    // mid-read aborts too; the finally below clears it once the body has
    // settled (parsed, unreadable, or aborted).
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchFn(`${baseUrl}${path}`, init);
      } catch (cause) {
        throw transportError(cause);
      }

      if (response.status === 401) {
        options.onAuthExpired?.();
        const envelope = await readEnvelope(response);
        throw new ApiError("auth-expired", envelope?.message ?? "Your session has expired.", {
          status: 401,
          code: envelope?.code ?? null,
        });
      }

      if (!response.ok) {
        const envelope = await readEnvelope(response);
        const kind: ApiFailureKind = response.status >= 500 ? "server" : "client";
        throw new ApiError(kind, envelope?.message ?? `The server answered HTTP ${response.status}.`, {
          status: response.status,
          code: envelope?.code ?? null,
        });
      }

      // logout answers 204 with no body; anything else must parse as JSON.
      if (response.status === 204) {
        return undefined;
      }
      try {
        return (await response.json()) as T;
      } catch (cause) {
        // An abort that lands while the body is read is a timeout, not a
        // malformed body; anything else is the server's unreadable body.
        if (controller.signal.aborted) {
          throw transportError(cause);
        }
        throw new ApiError("server", "The server answered with an unreadable body.", {
          status: response.status,
          cause,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    signup(input: SignupRequest): Promise<AuthResponse> {
      return send<AuthResponse>("/auth/signup", "POST", input) as Promise<AuthResponse>;
    },
    login(input: LoginRequest): Promise<AuthResponse> {
      return send<AuthResponse>("/auth/login", "POST", input) as Promise<AuthResponse>;
    },
    logout(): Promise<void> {
      return send<void>("/auth/logout", "POST") as Promise<void>;
    },
    me(): Promise<User> {
      return send<User>("/auth/me", "GET") as Promise<User>;
    },
    push(ops: PushOp[]): Promise<PushResponse> {
      return send<PushResponse>("/sync/push", "POST", { ops }) as Promise<PushResponse>;
    },
    pull(params: PullParams): Promise<PullPage> {
      const query = new URLSearchParams({ entity: params.entity });
      if (params.cursor !== undefined && params.cursor !== null && params.cursor.length > 0) {
        query.set("cursor", params.cursor);
      }
      if (params.limit !== undefined) {
        query.set("limit", String(params.limit));
      }
      return send<PullPage>(`/sync/pull?${query.toString()}`, "GET") as Promise<PullPage>;
    },
    boards(window: BoardWindow): Promise<BoardsResponse> {
      const query = new URLSearchParams({ window });
      return send<BoardsResponse>(
        `/social/boards?${query.toString()}`,
        "GET",
      ) as Promise<BoardsResponse>;
    },
  };
}
