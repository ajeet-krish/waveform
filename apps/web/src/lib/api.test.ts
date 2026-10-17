import { describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "@waveform/api-types";
import {
  ApiError,
  REQUEST_TIMEOUT_MS,
  createApiClient,
  resolveApiBaseUrl,
  type FetchFn,
} from "./api";

/** A canned Response for the mocked fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Records every call and answers from a queue of canned responses. */
function recordingFetch(
  responses: Array<Response | Error>,
): { fetchFn: FetchFn; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) {
      throw new Error("recordingFetch: no canned response left");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };
  return { fetchFn, calls };
}

const USER = {
  id: "user-1",
  email: "ada@example.com",
  display_name: "Ada",
  github_id: null,
  avatar_url: null,
  created_at: "2026-10-14T00:00:00.000Z",
  updated_at: "2026-10-14T00:00:00.000Z",
  deleted_at: null,
};

describe("resolveApiBaseUrl", () => {
  it("prefers the override over env and hostname", () => {
    expect(
      resolveApiBaseUrl("https://override.example", "https://env.example", "app.example.com"),
    ).toBe("https://override.example");
  });

  it("falls back to env when the override is absent or blank", () => {
    expect(resolveApiBaseUrl(undefined, "https://env.example", "app.example.com")).toBe(
      "https://env.example",
    );
    expect(resolveApiBaseUrl("", "https://env.example", "app.example.com")).toBe(
      "https://env.example",
    );
  });

  it("falls back to localhost:8080 when nothing is configured on a loopback host", () => {
    expect(resolveApiBaseUrl(undefined, undefined, "localhost")).toBe("http://localhost:8080");
    expect(resolveApiBaseUrl("", "", "127.0.0.1")).toBe("http://localhost:8080");
    expect(resolveApiBaseUrl(null, null, "[::1]")).toBe("http://localhost:8080");
  });

  it("throws on a deployed host with no configuration", () => {
    expect(() => resolveApiBaseUrl(undefined, undefined, "app.example.com")).toThrow(
      /No API base URL is configured/,
    );
  });

  it("strips trailing slashes from configured values", () => {
    expect(resolveApiBaseUrl("https://api.example.com/", undefined, "x")).toBe(
      "https://api.example.com",
    );
  });
});

describe("createApiClient", () => {
  it("sends the bearer token and JSON content type on POST bodies", async () => {
    const { fetchFn, calls } = recordingFetch([
      jsonResponse(201, { token: "t", expires_at: "2099-01-01T00:00:00.000Z", user: USER }),
    ]);
    const api = createApiClient({ baseUrl: "https://api.test", token: "tok-1", fetchFn });
    await api.signup({ email: "a@b.co", password: "hunter hunted", display_name: "Ada" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/auth/signup");
    const init = calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as unknown as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "a@b.co",
      password: "hunter hunted",
      display_name: "Ada",
    });
  });

  it("omits Authorization when no token exists", async () => {
    const { fetchFn, calls } = recordingFetch([
      jsonResponse(200, { token: "t", expires_at: "2099-01-01T00:00:00.000Z", user: USER }),
    ]);
    const api = createApiClient({ baseUrl: "https://api.test", fetchFn });
    await api.login({ email: "a@b.co", password: "hunter hunted" });
    const headers = calls[0]?.init.headers as unknown as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("maps a 401 to auth-expired and fires onAuthExpired exactly once", async () => {
    const onAuthExpired = vi.fn();
    const body: ApiErrorBody = { code: "unauthorized", message: "session expired" };
    const { fetchFn } = recordingFetch([jsonResponse(401, body)]);
    const api = createApiClient({
      baseUrl: "https://api.test",
      token: "dead",
      fetchFn,
      onAuthExpired,
    });

    const failure = await api.me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    const apiError = failure as ApiError;
    expect(apiError.kind).toBe("auth-expired");
    expect(apiError.status).toBe(401);
    expect(apiError.code).toBe("unauthorized");
    expect(apiError.message).toBe("session expired");
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
  });

  it("maps network failures to offline and aborts to timeout", async () => {
    const offline = new TypeError("fetch failed");
    const { fetchFn: offlineFetch } = recordingFetch([offline]);
    const offlineApi = createApiClient({ baseUrl: "https://api.test", fetchFn: offlineFetch });
    const offlineError = await offlineApi.me().catch((error: unknown) => error);
    expect(offlineError).toBeInstanceOf(ApiError);
    expect((offlineError as ApiError).kind).toBe("offline");
    expect((offlineError as ApiError).status).toBeNull();

    const timeout = new Error("The operation timed out.");
    timeout.name = "TimeoutError";
    const { fetchFn: timeoutFetch } = recordingFetch([timeout]);
    const timeoutApi = createApiClient({ baseUrl: "https://api.test", fetchFn: timeoutFetch });
    const timeoutError = await timeoutApi.me().catch((error: unknown) => error);
    expect((timeoutError as ApiError).kind).toBe("timeout");
  });

  it("exposes a 60 second default request deadline", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("aborts a hanging request at the deadline and classifies it as timeout", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that only ever settles when its request signal aborts.
      const fetchFn: FetchFn = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            const error = new Error("The request was aborted.");
            error.name = "AbortError";
            reject(error);
          };
          const signal = init.signal;
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort);
        });
      // No timeoutMs: the default deadline is exercised.
      const api = createApiClient({ baseUrl: "https://api.test", fetchFn });
      const pending = api.me().catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      const failure = await pending;

      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the deadline on a normal response and never aborts a later request", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const { fetchFn, calls } = recordingFetch([
        jsonResponse(200, USER),
        jsonResponse(200, USER),
      ]);
      const api = createApiClient({
        baseUrl: "https://api.test",
        token: "tok",
        fetchFn,
        timeoutMs: 1000,
      });

      await expect(api.me()).resolves.toEqual(USER);
      await expect(api.me()).resolves.toEqual(USER);

      // Every settled request cleared its own timer.
      expect(clearSpy).toHaveBeenCalledTimes(2);
      const firstSignal = calls[0]?.init.signal;
      const secondSignal = calls[1]?.init.signal;
      expect(firstSignal?.aborted).toBe(false);
      expect(secondSignal?.aborted).toBe(false);

      // Well past the deadline, nothing fires: the timers were cleared and
      // neither request (nor a later one) is spuriously aborted.
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(firstSignal?.aborted).toBe(false);
      expect(secondSignal?.aborted).toBe(false);
      expect(calls).toHaveLength(2);
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("maps 5xx to server and 4xx to client, parsing the error envelope", async () => {
    const serverBody: ApiErrorBody = { code: "internal", message: "boom" };
    const { fetchFn: serverFetch } = recordingFetch([jsonResponse(500, serverBody)]);
    const serverApi = createApiClient({ baseUrl: "https://api.test", fetchFn: serverFetch });
    const serverError = (await serverApi.me().catch((error: unknown) => error)) as ApiError;
    expect(serverError.kind).toBe("server");
    expect(serverError.status).toBe(500);
    expect(serverError.code).toBe("internal");
    expect(serverError.message).toBe("boom");

    const clientBody: ApiErrorBody = { code: "conflict", message: "email taken" };
    const { fetchFn: clientFetch } = recordingFetch([jsonResponse(409, clientBody)]);
    const clientApi = createApiClient({ baseUrl: "https://api.test", fetchFn: clientFetch });
    const clientError = (await clientApi
      .signup({ email: "a@b.co", password: "hunter hunted", display_name: "Ada" })
      .catch((error: unknown) => error)) as ApiError;
    expect(clientError.kind).toBe("client");
    expect(clientError.status).toBe(409);
    expect(clientError.code).toBe("conflict");
    expect(clientError.message).toBe("email taken");
  });

  it("falls back to a plain message when a failing body carries no envelope", async () => {
    const { fetchFn } = recordingFetch([new Response("<html>gateway</html>", { status: 502 })]);
    const api = createApiClient({ baseUrl: "https://api.test", fetchFn });
    const error = (await api.me().catch((caught: unknown) => caught)) as ApiError;
    expect(error.kind).toBe("server");
    expect(error.code).toBeNull();
    expect(error.message).toContain("502");
  });

  it("push posts ops and pull pages on the cursor", async () => {
    const { fetchFn, calls } = recordingFetch([
      jsonResponse(200, { results: [] }),
      jsonResponse(200, { rows: [], next_cursor: null }),
    ]);
    const api = createApiClient({ baseUrl: "https://api.test", token: "tok", fetchFn });

    await api.push([
      {
        op_id: "op-1",
        entity: "workout_sessions",
        action: "create",
        payload: { id: "w1" },
        updated_at: "2026-10-14T00:00:00.000Z",
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.test/sync/push");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      ops: [
        {
          op_id: "op-1",
          entity: "workout_sessions",
          action: "create",
          payload: { id: "w1" },
          updated_at: "2026-10-14T00:00:00.000Z",
        },
      ],
    });

    await api.pull({ entity: "set_entries", cursor: "abc+/=" });
    expect(calls[1]?.url).toBe(
      "https://api.test/sync/pull?entity=set_entries&cursor=abc%2B%2F%3D",
    );
    expect(calls[1]?.init.method).toBe("GET");
  });

  it("resolves logout on a 204 without parsing a body", async () => {
    const { fetchFn } = recordingFetch([new Response(null, { status: 204 })]);
    const api = createApiClient({ baseUrl: "https://api.test", token: "tok", fetchFn });
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it("boards fetch the window on a GET and read the generated response", async () => {
    const { fetchFn, calls } = recordingFetch([
      jsonResponse(200, {
        window: "4w",
        marquee_lifts: ["Back Squat"],
        consistency: [],
        lifting: { volume: [], e1rm: [], relative_e1rm: [] },
        cycling: { distance: [], elevation: [] },
        climbing: [],
      }),
    ]);
    const api = createApiClient({ baseUrl: "https://api.test", token: "tok", fetchFn });

    const response = await api.boards("4w");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/social/boards?window=4w");
    expect(calls[0]?.init.method).toBe("GET");
    const headers = calls[0]?.init.headers as unknown as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(response.window).toBe("4w");
    expect(response.marquee_lifts).toEqual(["Back Squat"]);
  });
});
