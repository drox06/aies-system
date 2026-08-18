import { describe, expect, it } from "vitest";
import {
  AVERAGE_ROAD_SPEED_KPH,
  CAPACITY_WEEKS,
  CARD_STATES,
  capacityByWeek,
  cardStatus,
  daysBetween,
  findConflicts,
  isUnavailable,
  readCoordinates,
  travelBetween,
  weekOf,
} from "@/server/core/operations/dispatch-rules";

/**
 * specs/04-operations-projects.md §17, as pure functions.
 *
 * The cases that matter are the ones where a scheduler quietly becomes useless: a card that looks
 * the same whether or not a crew is committed, a double-booking nobody is told about, a capacity
 * number flattered by counting weekends, a travel time guessed rather than admitted unknown.
 */

const readiness = (blockers: { key: string; label: string; state: string }[] = []) => ({
  ready: blockers.length === 0,
  blockers,
});

const fail = (label: string) => ({ key: label, label, state: "fail" });

describe("what a card says", () => {
  it("has three states, and every one is reachable", () => {
    expect([...CARD_STATES]).toEqual(["ready", "blocked", "unscheduled"]);
  });

  /**
   * The distinction §17 is asking for. A ticket with no cash advance and no date is ordinary
   * work-in-progress; the same ticket with a crew booked on Thursday is the thing that ruins a week.
   */
  it("separates blocked-and-committed from merely not-ready", () => {
    const blockers = [fail("Cash advance not released")];

    const unscheduled = cardStatus({ readiness: readiness(blockers), scheduledStart: null });
    expect(unscheduled.state).toBe("unscheduled");

    const scheduled = cardStatus({
      readiness: readiness(blockers),
      scheduledStart: "2026-07-01",
    });
    expect(scheduled.state).toBe("blocked");
  });

  it("names the blocker rather than only colouring the card", () => {
    const card = cardStatus({
      readiness: readiness([fail("Materials not issued")]),
      scheduledStart: "2026-07-01",
    });
    expect(card.summary).toBe("Materials not issued");
    expect(card.blockers).toEqual(["Materials not issued"]);
  });

  it("counts the rest when there is more than one", () => {
    const card = cardStatus({
      readiness: readiness([fail("Cash advance"), fail("Materials"), fail("Methodology")]),
      scheduledStart: "2026-07-01",
    });
    expect(card.summary).toBe("Cash advance and 2 more");
  });

  /** An unknown gate is not a passed one. Same rule as §10's indeterminate reading. */
  it("treats an unknown gate as a blocker", () => {
    const card = cardStatus({
      readiness: readiness([{ key: "permit", label: "Permit", state: "unknown" }]),
      scheduledStart: "2026-07-01",
    });
    expect(card.state).toBe("blocked");
  });

  it("says ready only when nothing is in the way", () => {
    const card = cardStatus({ readiness: readiness(), scheduledStart: "2026-07-01" });
    expect(card.state).toBe("ready");
    expect(card.blockers).toEqual([]);
  });

  /** A ticket with no blockers and no date is still not something to send a crew to. */
  it("does not call an unscheduled ticket ready", () => {
    expect(cardStatus({ readiness: readiness(), scheduledStart: null }).state).toBe("unscheduled");
  });
});

describe("days", () => {
  it("covers a range inclusively", () => {
    expect(daysBetween("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("returns nothing for a range that runs backwards", () => {
    expect(daysBetween("2026-07-05", "2026-07-01")).toEqual([]);
  });

  it("finds the Monday of any week", () => {
    // 2026-07-01 is a Wednesday.
    expect(weekOf("2026-07-01")).toBe("2026-06-29");
    expect(weekOf("2026-06-29")).toBe("2026-06-29");
  });
});

describe("who is away", () => {
  const leave = [
    { userId: "u1", from: "2026-07-06", to: "2026-07-10", kind: "leave", notes: "Annual" },
  ];

  it("covers the whole range, both ends included", () => {
    expect(isUnavailable("u1", "2026-07-06", leave)).not.toBeNull();
    expect(isUnavailable("u1", "2026-07-10", leave)).not.toBeNull();
    expect(isUnavailable("u1", "2026-07-11", leave)).toBeNull();
  });

  it("is about that person only", () => {
    expect(isUnavailable("u2", "2026-07-07", leave)).toBeNull();
  });
});

describe("conflicts", () => {
  const assignment = (over: Record<string, unknown> = {}) => ({
    ticketId: "t1",
    ticketNumber: "AIESTKT-260001",
    userId: "u1",
    scheduledStart: "2026-07-07",
    scheduledEnd: null,
    ...over,
  });

  /**
   * Reported, never prevented. A dispatcher putting somebody on two short jobs in one industrial
   * estate is doing their job; a scheduler that refuses it teaches people to work around the
   * scheduler. What it must not do is let it happen unnoticed.
   */
  it("reports one person wanted on two jobs the same day", () => {
    const conflicts = findConflicts([
      assignment(),
      assignment({ ticketId: "t2", ticketNumber: "AIESTKT-260002" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.ticketNumbers).toEqual(["AIESTKT-260001", "AIESTKT-260002"]);
    expect(conflicts[0]!.reason).toMatch(/2 jobs the same day/);
  });

  it("says nothing about two people on the same job", () => {
    expect(findConflicts([assignment(), assignment({ userId: "u2" })])).toHaveLength(0);
  });

  it("reports somebody scheduled while they are away, and says why", () => {
    const conflicts = findConflicts(
      [assignment()],
      [
        {
          userId: "u1",
          from: "2026-07-06",
          to: "2026-07-10",
          kind: "training",
          notes: "Vendor course",
        },
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe("Training — Vendor course.");
  });

  it("spans a multi-day job across every day it covers", () => {
    const conflicts = findConflicts([
      assignment({ scheduledStart: "2026-07-06", scheduledEnd: "2026-07-08" }),
      assignment({ ticketId: "t2", ticketNumber: "AIESTKT-260002", scheduledStart: "2026-07-08" }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.day).toBe("2026-07-08");
  });
});

describe("capacity", () => {
  const technicianIds = ["u1", "u2"];

  it("looks four weeks forward by default", () => {
    const weeks = capacityByWeek({ technicianIds, assignments: [], from: new Date("2026-07-01") });
    expect(weeks).toHaveLength(CAPACITY_WEEKS);
  });

  /**
   * Weekends are not capacity. Counting them would flatter every week by 40% and make the number
   * useless for the one thing §17 says it is for — "the number sales needs before promising a date".
   */
  it("counts working days only", () => {
    const [week] = capacityByWeek({
      technicianIds,
      assignments: [],
      from: new Date("2026-07-01"),
    });
    // Two technicians, five working days.
    expect(week!.available).toBe(10);
  });

  it("takes leave out of the available days", () => {
    const [week] = capacityByWeek({
      technicianIds,
      assignments: [],
      from: new Date("2026-07-01"),
      unavailability: [{ userId: "u1", from: "2026-06-29", to: "2026-07-03", kind: "leave" }],
    });
    expect(week!.available).toBe(5);
  });

  it("counts committed days and reports what is spare", () => {
    const [week] = capacityByWeek({
      technicianIds,
      from: new Date("2026-07-01"),
      assignments: [
        {
          ticketId: "t1",
          ticketNumber: "A",
          userId: "u1",
          scheduledStart: "2026-06-29",
          scheduledEnd: "2026-07-01",
        },
      ],
    });
    expect(week!.committed).toBe(3);
    expect(week!.spare).toBe(7);
    expect(week!.utilisationPct).toBe(30);
  });

  /** Over-committing is a real state and the number has to be able to say so. */
  it("goes negative when more has been promised than exists", () => {
    const [week] = capacityByWeek({
      technicianIds: ["u1"],
      from: new Date("2026-07-01"),
      assignments: Array.from({ length: 8 }, (_, index) => ({
        ticketId: `t${index}`,
        ticketNumber: `A${index}`,
        userId: "u1",
        scheduledStart: "2026-06-30",
        scheduledEnd: null,
      })),
    });
    expect(week!.spare).toBeLessThan(0);
  });

  it("reports nothing rather than dividing by zero when nobody is available", () => {
    const [week] = capacityByWeek({
      technicianIds: [],
      assignments: [],
      from: new Date("2026-07-01"),
    });
    expect(week!.available).toBe(0);
    expect(week!.utilisationPct).toBe(0);
  });
});

describe("travel between sites", () => {
  const manila = { lat: 14.5995, lng: 120.9842 };
  const batangas = { lat: 13.7565, lng: 121.0583 };

  it("reads coordinates written either way round", () => {
    expect(readCoordinates({ lat: 1, lng: 2 })).toEqual({ lat: 1, lng: 2 });
    expect(readCoordinates({ latitude: 1, longitude: 2 })).toEqual({ lat: 1, lng: 2 });
  });

  /**
   * The important case. A guessed travel time is worse than none: the dispatcher plans the day
   * around it and the crew discovers on the road that it was wrong. Site addresses are Json with
   * optional coordinates, so "unknown" is the common case today and must read as an honest gap.
   */
  it("says it does not know rather than guessing", () => {
    const estimate = travelBetween({ city: "Makati" }, manila);
    expect(estimate.known).toBe(false);
    expect(estimate.minutes).toBeNull();
    expect(estimate.note).toMatch(/unknown/);
  });

  it("estimates when both sites have coordinates, and labels the estimate as crude", () => {
    const estimate = travelBetween(manila, batangas);
    expect(estimate.known).toBe(true);
    expect(estimate.km).toBeGreaterThan(90);
    expect(estimate.km).toBeLessThan(100);
    expect(estimate.minutes).toBeGreaterThan(0);
    expect(estimate.note).toMatch(new RegExp(`${AVERAGE_ROAD_SPEED_KPH} km/h`));
    expect(estimate.note).toMatch(/not a route/);
  });

  it("refuses nonsense coordinates", () => {
    expect(readCoordinates({ lat: "14.6", lng: 120.9 })).toBeNull();
    expect(readCoordinates({ lat: Number.NaN, lng: 1 })).toBeNull();
    expect(readCoordinates(null)).toBeNull();
  });
});
