import { describe, expect, it } from "vitest";
import {
  EDIT_WINDOW_MS,
  canPost,
  canRead,
  checkChannel,
  findMentions,
  findRecordReferences,
  recipientsFor,
  unreadCount,
  withinEditWindow,
} from "@/server/core/collab/channel-rules";

/**
 * §3's rules, without a database.
 *
 * Mentions and record references are the two places where a small parsing mistake is invisible: a
 * missed mention means somebody was never told and nobody finds out, and a missed reference means
 * the message that connects a conversation to a job silently does not.
 */

const people = [
  { id: "ea", name: "EA" },
  { id: "kj", name: "KJ" },
  { id: "maria", name: "Maria Santos" },
  { id: "mariaC", name: "Maria" },
];

describe("findMentions", () => {
  it("finds a name and returns its id", () => {
    expect(findMentions("can @KJ look at this", people).userIds).toEqual(["kj"]);
  });

  it("prefers the longer name when one contains the other", () => {
    // "@Maria Santos" must not be read as "@Maria" plus stray text — she is a different person.
    expect(findMentions("@Maria Santos please confirm", people).userIds).toEqual(["maria"]);
    expect(findMentions("@Maria please confirm", people).userIds).toEqual(["mariaC"]);
  });

  it("does not care about capitals", () => {
    // Nobody types a colleague's name with the capitals they registered with.
    expect(findMentions("@kj can you", people).userIds).toEqual(["kj"]);
  });

  it("counts one mention when somebody is named twice", () => {
    expect(findMentions("@KJ and again @KJ", people).userIds).toEqual(["kj"]);
  });

  it("recognises @here separately from a name", () => {
    const result = findMentions("@here the crane is late", people);
    expect(result.here).toBe(true);
    expect(result.userIds).toEqual([]);
  });

  it("does not match a name that is only part of a word", () => {
    expect(findMentions("email@kjsomething.com", people).userIds).toEqual([]);
  });
});

describe("findRecordReferences", () => {
  it("finds a document number with or without the hash", () => {
    // People paste numbers far more often than they type the punctuation.
    expect(findRecordReferences("see AIESSO-261561").map((r) => r.number)).toEqual([
      "AIESSO-261561",
    ]);
    expect(findRecordReferences("see #AIESSO-261561").map((r) => r.number)).toEqual([
      "AIESSO-261561",
    ]);
  });

  it("knows which kind of record each prefix is", () => {
    const found = findRecordReferences("AIESTKT-260012 came out of AIESLQ261148");
    expect(found.map((r) => r.entityType).sort()).toEqual(["Quotation", "Ticket"]);
  });

  it("does not repeat the same number twice", () => {
    expect(findRecordReferences("AIESCA-260004 and AIESCA-260004 again")).toHaveLength(1);
  });

  it("ignores something that only looks like a number", () => {
    expect(findRecordReferences("call me on 261561")).toEqual([]);
  });
});

describe("recipientsFor", () => {
  const members = [
    { userId: "author", notificationLevel: "all" },
    { userId: "everything", notificationLevel: "all" },
    { userId: "named-only", notificationLevel: "mentions" },
    { userId: "muted", notificationLevel: "none" },
  ];

  it("never tells the author about their own message", () => {
    const told = recipientsFor(members, { authorId: "author", mentions: [], mentionedHere: false });
    expect(told.map((r) => r.userId)).not.toContain("author");
  });

  it("tells `all` about an ordinary message and leaves `mentions` alone", () => {
    const told = recipientsFor(members, { authorId: "author", mentions: [], mentionedHere: false });
    expect(told.map((r) => r.userId)).toEqual(["everything"]);
  });

  it("tells somebody on `mentions` when they are named", () => {
    const told = recipientsFor(members, {
      authorId: "author",
      mentions: ["named-only"],
      mentionedHere: false,
    });
    expect(told.find((r) => r.userId === "named-only")?.because).toBe("mentioned");
  });

  it("lets @here through to `mentions`", () => {
    // What somebody types when the thing is actually urgent. A channel where it reaches nobody
    // sends people back to phoning round.
    const told = recipientsFor(members, {
      authorId: "author",
      mentions: [],
      mentionedHere: true,
    });
    expect(told.map((r) => r.userId).sort()).toEqual(["everything", "named-only"]);
  });

  it("respects `none`, even for a mention and even for @here", () => {
    /*
      Somebody who has turned a channel off has said what they want. Overriding it is how people
      learn to leave a channel rather than quiet it — and then they miss the thing that mattered.
    */
    const told = recipientsFor(members, {
      authorId: "author",
      mentions: ["muted"],
      mentionedHere: true,
    });
    expect(told.map((r) => r.userId)).not.toContain("muted");
  });
});

describe("unreadCount", () => {
  const at = (iso: string) => new Date(`2026-08-21T${iso}:00.000Z`);
  const messages = [
    { createdAt: at("09:00"), authorId: "someone" },
    { createdAt: at("10:00"), authorId: "me" },
    { createdAt: at("11:00"), authorId: "someone" },
  ];

  it("treats a channel somebody has never opened as entirely unread", () => {
    // The opposite default would hide the conversation that was going on before they were added,
    // which is usually the conversation they were added for.
    expect(unreadCount(messages, null, "me")).toBe(2);
  });

  it("does not count somebody's own messages", () => {
    expect(unreadCount(messages, at("08:00"), "me")).toBe(2);
  });

  it("counts only what came after the mark", () => {
    expect(unreadCount(messages, at("10:30"), "me")).toBe(1);
    expect(unreadCount(messages, at("23:00"), "me")).toBe(0);
  });
});

describe("access", () => {
  const open = { isPrivate: false, memberIds: [] as string[], archivedAt: null };
  const closed = { isPrivate: true, memberIds: ["kj"], archivedAt: null };

  it("lets anybody read a public channel and only members read a private one", () => {
    expect(canRead(open, "ea")).toBe(true);
    expect(canRead(closed, "ea")).toBe(false);
    expect(canRead(closed, "kj")).toBe(true);
  });

  it("refuses posting to an archived channel, however senior the reader", () => {
    // §3 keeps a closed project's channel as part of the project record, and a record somebody can
    // still add to after the fact is not a record.
    expect(canPost({ ...open, archivedAt: new Date() }, "ea")).toBe(false);
    expect(canPost(open, "ea")).toBe(true);
  });
});

describe("the edit window", () => {
  it("closes fifteen minutes after posting, not after the last edit", () => {
    const posted = new Date("2026-08-21T09:00:00.000Z");
    expect(withinEditWindow(posted, new Date(posted.getTime() + EDIT_WINDOW_MS - 1))).toBe(true);
    expect(withinEditWindow(posted, new Date(posted.getTime() + EDIT_WINDOW_MS + 1))).toBe(false);
  });
});

describe("checkChannel", () => {
  it("refuses a private channel with nobody in it", () => {
    const result = checkChannel({ name: "Secret", type: "topic", memberIds: [], isPrivate: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("at least one member");
  });

  it("insists a direct message is between two people", () => {
    expect(checkChannel({ name: "DM", type: "direct", memberIds: ["a"], isPrivate: true }).ok).toBe(
      false,
    );
    expect(
      checkChannel({ name: "DM", type: "direct", memberIds: ["a", "b"], isPrivate: true }).ok,
    ).toBe(true);
  });
});
