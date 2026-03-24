import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSnoozeDate } from "../parse-duration.js";

describe("parseSnoozeDate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes through ISO date (date only)", () => {
    expect(parseSnoozeDate("2026-03-21")).toBe("2026-03-21");
  });

  it("passes through ISO date (with time) and truncates to date", () => {
    expect(parseSnoozeDate("2026-03-21T10:00:00Z")).toBe("2026-03-21");
  });

  it("parses days (3d)", () => {
    vi.useFakeTimers({ now: new Date("2026-03-23T12:00:00Z") });
    expect(parseSnoozeDate("3d")).toBe("2026-03-26");
  });

  it("parses weeks (2w)", () => {
    vi.useFakeTimers({ now: new Date("2026-03-23T12:00:00Z") });
    expect(parseSnoozeDate("2w")).toBe("2026-04-06");
  });

  it("parses months (1m)", () => {
    vi.useFakeTimers({ now: new Date("2026-03-23T12:00:00Z") });
    expect(parseSnoozeDate("1m")).toBe("2026-04-23");
  });

  it("is case-insensitive (2W)", () => {
    vi.useFakeTimers({ now: new Date("2026-03-23T12:00:00Z") });
    expect(parseSnoozeDate("2W")).toBe("2026-04-06");
  });

  it("throws on invalid input", () => {
    expect(() => parseSnoozeDate("next monday")).toThrow("Invalid snooze date");
  });

  it("throws on empty string", () => {
    expect(() => parseSnoozeDate("")).toThrow("Invalid snooze date");
  });

  it("throws on invalid ISO date", () => {
    expect(() => parseSnoozeDate("2026-13-45")).toThrow("Invalid date");
  });
});
