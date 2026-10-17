/**
 * Leaderboard: the crew's server-aggregated boards for one trailing
 * window. The window selector drives a live fetch; the Consistency board
 * sits above the lifting, cycling, and climbing boards. Signed-out, no
 * address, offline, empty, and error states each say what to do next.
 * Boards read on demand from the server and are never mirrored locally.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";
import type { BoardWindow, BoardsResponse } from "@waveform/api-types";
import EmptyState from "../components/EmptyState";
import Panel from "../components/Panel";
import BoardTable from "../components/social/BoardTable";
import { useAppData } from "../lib/appData";
import { ApiError } from "../lib/api";
import {
  BOARD_WINDOWS,
  DEFAULT_BOARD_WINDOW,
  boardUnits,
  buildLeaderboard,
  hasLeaderboardData,
  windowLabel,
  type BoardGroup,
  type BoardUnits,
} from "../lib/social";

/** A failed board load, split by whether retrying can help. */
type BoardError = {
  message: string;
  offline: boolean;
};

function boardError(cause: unknown): BoardError {
  if (cause instanceof ApiError) {
    if (cause.kind === "offline" || cause.kind === "timeout") {
      return { message: "The server did not answer.", offline: true };
    }
    return { message: cause.message, offline: false };
  }
  return { message: "The boards could not be loaded.", offline: false };
}

export default function Leaderboard(): JSX.Element {
  const app = useAppData();
  const [boardWindow, setBoardWindow] = createSignal<BoardWindow>(DEFAULT_BOARD_WINDOW);
  const [data, setData] = createSignal<BoardsResponse | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<BoardError | null>(null);
  let request = 0;

  const signedIn = (): boolean => app.auth.state() === "signed-in";
  const configured = (): boolean => app.apiBaseUrl() !== null;
  const units = createMemo(() =>
    boardUnits(
      app.profile()?.settings.display_weight_unit ?? "kg",
      app.profile()?.settings.display_length_unit ?? "cm",
    ),
  );

  const load = async (target: BoardWindow): Promise<void> => {
    const token = ++request;
    setLoading(true);
    setError(null);
    try {
      const response = await app.boards(target);
      if (token !== request) {
        return;
      }
      setData(response);
    } catch (cause) {
      if (token !== request) {
        return;
      }
      setData(null);
      setError(boardError(cause));
    } finally {
      if (token === request) {
        setLoading(false);
      }
    }
  };

  // Refetch on window change and whenever the session or address becomes
  // usable. A stale in-flight request is dropped by the request token.
  createEffect(() => {
    const target = boardWindow();
    if (!signedIn() || !configured()) {
      request += 1;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    void load(target);
  });

  return (
    <div class="stack">
      <Show when={signedIn()} fallback={<SignInState />}>
        <Show when={configured()} fallback={<AddressState />}>
          <div>
            <p class="label">Window</p>
            <div class="seg mt-3" role="group" aria-label="Leaderboard window">
              <For each={BOARD_WINDOWS}>
                {(item) => (
                  <button
                    type="button"
                    class="seg-btn"
                    aria-pressed={boardWindow() === item}
                    onClick={() => setBoardWindow(item)}
                  >
                    {windowLabel(item)}
                  </button>
                )}
              </For>
            </div>
          </div>

          <Show when={loading()}>
            <Panel label="Boards" meta={windowLabel(boardWindow())}>
              <p class="panel-note">Loading the boards...</p>
            </Panel>
          </Show>

          <Show when={!loading()}>
            <Show
              when={error()}
              keyed
              fallback={
                <Show when={data()} keyed>
                  {(response) => (
                    <Boards response={response} units={units()} window={boardWindow()} />
                  )}
                </Show>
              }
            >
              {(failure) => (
                <ErrorState error={failure} onRetry={() => void load(boardWindow())} />
              )}
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

/** The ranked boards for one loaded response, grouped by discipline. */
function Boards(props: {
  response: BoardsResponse;
  units: BoardUnits;
  window: BoardWindow;
}): JSX.Element {
  const groups = createMemo<BoardGroup[]>(() =>
    buildLeaderboard(props.response, props.units),
  );
  return (
    <Show when={hasLeaderboardData(groups())} fallback={<NoDataState window={props.window} />}>
      <For each={groups()}>
        {(group) => (
          <section>
            <h2 class="label">{group.label}</h2>
            <div class="panel-grid">
              <For each={group.boards}>{(board) => <BoardTable view={board} />}</For>
            </div>
          </section>
        )}
      </For>
    </Show>
  );
}

/** Signed out: the boards compare the whole crew, so they need a session. */
function SignInState(): JSX.Element {
  return (
    <EmptyState
      title="Sign in to see the boards"
      body="Boards compare the whole crew, so they read from the server. Sign in and your group's ranks appear here."
      actions={[{ label: "Sign in", href: "/account" }]}
    />
  );
}

/** Signed in but no API address resolves: point the app at the server. */
function AddressState(): JSX.Element {
  return (
    <EmptyState
      title="No API address is set"
      body="Boards read from the server. Set the API address under Account, Advanced, then return here."
      actions={[{ label: "Open Account", href: "/account" }]}
    />
  );
}

/** A load failure: offline invites a retry, anything else shows its message. */
function ErrorState(props: { error: BoardError; onRetry: () => void }): JSX.Element {
  return (
    <EmptyState
      title={props.error.offline ? "The boards are out of reach" : "The boards could not be loaded"}
      body={
        props.error.offline
          ? "The server did not answer. Check your connection, then try again."
          : props.error.message
      }
      actions={[{ label: "Try again", onClick: props.onRetry }]}
    />
  );
}

/** No member has data in the selected window: invite a session or a wider window. */
function NoDataState(props: { window: BoardWindow }): JSX.Element {
  return (
    <EmptyState
      title="No one trained in this window"
      body="Boards rank the crew's active days, lifting, rides, and sends. Widen the window or log a session to start one."
      actions={[{ label: "Log a session", href: "/workout" }]}
      note={`Reads the ${windowLabel(props.window)} window from the server`}
    />
  );
}
