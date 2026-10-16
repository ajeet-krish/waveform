import { describe, expect, it } from "vitest";
import { RULE_CONSTANTS } from "@waveform/api-types";
import { ACTIVITY_RULES, BODY_RULES, SET_RULES } from "./validation";

/**
 * Parity fence for the server-published rule tree: `RULE_CONSTANTS` is
 * generated from `RuleConstants::default()` in crates/db (export_ts_rules),
 * and the client guards in validation.ts are hand-written against the SQL
 * CHECKs. If either side drifts, this suite fails alongside the Rust unit
 * tests in crates/db/src/dto.rs.
 */
describe("RULE_CONSTANTS parity with the client guards", () => {
  it("deep-equals SET_RULES", () => {
    expect(RULE_CONSTANTS.set).toEqual({ ...SET_RULES });
  });

  it("deep-equals ACTIVITY_RULES", () => {
    expect(RULE_CONSTANTS.activity).toEqual({ ...ACTIVITY_RULES });
  });

  it("deep-equals BODY_RULES", () => {
    expect(RULE_CONSTANTS.body).toEqual({ ...BODY_RULES });
  });

  it("carries the push batch cap and pull page size", () => {
    expect(RULE_CONSTANTS.sync.maxOpsPerPush).toBe(200);
    expect(RULE_CONSTANTS.sync.pullPageSize).toBe(500);
    // The clamp the server applies to client clocks; the Rust side asserts
    // this equals waveform_sync::MAX_CLIENT_CLOCK_SKEW_MINUTES.
    expect(RULE_CONSTANTS.sync.maxClientClockSkewMinutes).toBe(5);
  });

  it("carries the password policy", () => {
    expect(RULE_CONSTANTS.password.minPasswordLength).toBe(10);
  });
});
