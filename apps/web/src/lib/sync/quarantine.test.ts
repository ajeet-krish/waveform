import type { Activity, Exercise, WorkoutSession } from "@waveform/api-types";
import { describe, expect, it } from "vitest";
import type { LocalRow, OutboxOp, SetEntryWrite } from "../../db/types";
import {
  formatParkedAge,
  formatQuarantineEntries,
  quarantineCopy,
  quarantineUnavailableCopy,
} from "./quarantine";

const STAMP = "2026-10-01T00:00:00.000Z";

function exerciseRow(name: string): LocalRow<Exercise> {
  return {
    id: "ex-1",
    owner_id: "user-1",
    name,
    muscle_group: "chest",
    equipment: "barbell",
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function sessionRow(): LocalRow<WorkoutSession> {
  return {
    id: "w-1",
    user_id: "user-1",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: null,
    routine_id: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function setRow(): SetEntryWrite {
  return {
    id: "set-1",
    exercise_entry_id: "entry-1",
    set_index: 0,
    weight_kg: 100,
    reps: 5,
    is_warmup: false,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

function activityRow(): LocalRow<Activity> {
  return {
    id: "act-1",
    user_id: "user-1",
    type: "cycling",
    local_date: "2026-10-14",
    started_at: null,
    duration_min: 80,
    distance_km: 42,
    elevation_m: 380,
    climb_grade: null,
    climb_grade_value: null,
    routes_sent: null,
    notes: null,
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
  };
}

type OpOverrides = {
  entity?: OutboxOp["entity"];
  action?: OutboxOp["action"];
  payload?: OutboxOp["payload"];
  last_error?: string | null;
  attempts?: number;
  quarantined?: boolean;
};

function op(op_id: string, created_at: string, overrides: OpOverrides = {}): OutboxOp {
  return {
    op_id,
    entity: overrides.entity ?? "exercises",
    action: overrides.action ?? "update",
    payload: overrides.payload ?? exerciseRow("Bench Press (Barbell)"),
    updated_at: created_at,
    created_at,
    last_error: overrides.last_error,
    attempts: overrides.attempts,
    quarantined: overrides.quarantined,
  };
}

describe("formatQuarantineEntries", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it("returns an empty list when nothing is parked", () => {
    expect(formatQuarantineEntries([], now)).toEqual([]);
  });

  it("names the action, entity, and row figure", () => {
    const entries = formatQuarantineEntries(
      [op("op-1", "2026-10-16T11:45:00.000Z")],
      now,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entity).toBe("exercises");
    expect(entries[0]?.action).toBe("update");
    expect(entries[0]?.summary).toBe('Edit exercise "Bench Press (Barbell)"');
    expect(entries[0]?.parkedAge).toBe("15 min ago");
  });

  it("describes a new set, a new activity, and a deleted workout from their payloads", () => {
    const entries = formatQuarantineEntries(
      [
        op("op-set", "2026-10-16T11:00:00.000Z", {
          entity: "set_entries",
          action: "create",
          payload: setRow(),
        }),
        op("op-act", "2026-10-16T11:00:00.000Z", {
          entity: "activities",
          action: "create",
          payload: activityRow(),
        }),
        op("op-session", "2026-10-16T11:00:00.000Z", {
          entity: "workout_sessions",
          action: "delete",
          payload: sessionRow(),
        }),
      ],
      now,
    );
    expect(entries[0]?.summary).toBe("New set 100 kg x 5");
    expect(entries[1]?.summary).toBe("New activity Cycling on 2026-10-14");
    expect(entries[2]?.summary).toBe("Delete workout on 2026-10-14");
  });

  it("humanizes the server reason and falls back when none is stored", () => {
    const entries = formatQuarantineEntries(
      [
        op("op-known", STAMP, { last_error: "invalid_payload" }),
        op("op-unknown", STAMP, { last_error: "weird_code" }),
        op("op-none", STAMP, { last_error: null }),
      ],
      now,
    );
    expect(entries[0]?.reason).toBe("The server rejected the change as invalid.");
    expect(entries[1]?.reason).toBe("The server said: weird_code.");
    expect(entries[2]?.reason).toBe("The server gave no reason.");
  });

  it("defaults a missing attempt count to zero and passes a recorded one through", () => {
    const entries = formatQuarantineEntries(
      [op("op-fresh", STAMP), op("op-tried", STAMP, { attempts: 3 })],
      now,
    );
    expect(entries[0]?.attempts).toBe(0);
    expect(entries[1]?.attempts).toBe(3);
  });
});

describe("formatParkedAge", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it("buckets minutes, hours, days, and months", () => {
    expect(formatParkedAge("2026-10-16T11:59:30.000Z", now)).toBe("just now");
    expect(formatParkedAge("2026-10-16T11:45:00.000Z", now)).toBe("15 min ago");
    expect(formatParkedAge("2026-10-16T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatParkedAge("2026-10-14T12:00:00.000Z", now)).toBe("2 d ago");
    expect(formatParkedAge("2026-08-16T12:00:00.000Z", now)).toBe("2 mo ago");
  });

  it("reads an unparseable stamp as unknown instead of leaking Invalid Date", () => {
    expect(formatParkedAge("not-a-date", now)).toBe("at an unknown time");
  });
});

describe("quarantineCopy", () => {
  it("keeps the heading quiet at zero and counts above", () => {
    expect(quarantineCopy(0).heading).toBe("Paused changes");
    expect(quarantineCopy(1).heading).toBe("Paused changes (1)");
    expect(quarantineCopy(4).heading).toBe("Paused changes (4)");
  });

  it("offers an empty state that reassures rather than alarms", () => {
    const copy = quarantineCopy(0);
    expect(copy.emptyTitle).toBe("Nothing is paused");
    expect(copy.emptyBody.length).toBeGreaterThan(0);
  });

  it("never claims every change reached the server when the list is unreadable", () => {
    const copy = quarantineUnavailableCopy();
    // No count, since the heading is not backed by a successful read.
    expect(copy.heading).toBe("Paused changes");
    expect(copy.emptyTitle).not.toBe("Nothing is paused");
    // The reassuring empty body must not appear on the unknown path.
    expect(copy.emptyBody).not.toBe(quarantineCopy(0).emptyBody);
    expect(copy.emptyBody).toContain("cannot read");
  });
});
