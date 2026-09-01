/**
 * §3's channels and messages, as rules — no Prisma, no database.
 *
 * On `UI_SAFE_SERVER_MODULES`. The composer has to highlight the same mentions the server will
 * notify, and the message list has to render the same record links the server resolved; two copies
 * of either would eventually disagree, and the disagreement would be invisible.
 */

export const CHANNEL_TYPES = ["team", "project", "topic", "direct"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  team: "Team",
  project: "Project",
  topic: "Topic",
  direct: "Direct",
};

/** §3's per-member setting. `mentions` is the middle ground a busy channel needs. */
export const NOTIFICATION_LEVELS = ["all", "mentions", "none"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const NOTIFICATION_LEVEL_LABELS: Record<NotificationLevel, string> = {
  all: "Every message",
  mentions: "Only when I am named",
  none: "Nothing — I will look",
};

/**
 * How long a message can be edited or withdrawn.
 *
 * Fifteen minutes, the same window module 00's comments use, and measured from posting rather than
 * from the last edit — otherwise re-editing just before each deadline would keep a message open
 * forever, which is not what a fifteen-minute window is meant to promise.
 */
export const EDIT_WINDOW_MS = 15 * 60_000;

export function withinEditWindow(createdAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - createdAt.getTime() <= EDIT_WINDOW_MS;
}

/**
 * `@name` mentions in a message body.
 *
 * Matched against the names the caller supplies rather than parsed blind, because a name is not a
 * username here — this company has nine people and writes `@KJ`, not `@kj.reyes`. Longest name
 * first, so `@Maria Santos` is not matched as `@Maria`.
 *
 * Returns ids, de-duplicated: naming somebody twice in one message is one mention.
 */
export function findMentions(
  body: string,
  people: { id: string; name: string }[],
): { userIds: string[]; here: boolean } {
  const here = /(^|\s)@here\b/i.test(body);

  const byLength = [...people].sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();

  /*
    Each match is consumed before the next name is tried.

    Without this, `@Maria Santos` matches Maria Santos *and* Maria: the word boundary after "Maria"
    falls on the space, so the shorter name matches inside the longer one and a colleague who was
    never named gets told. Found by the rules test on 2026-08-21, and it would have been invisible in
    use — an extra notification looks like somebody else's mistake, not the software's.

    Replacing the matched span with spaces of the same length keeps every other offset intact, so
    later matches still land where they should.
  */
  let remaining = body;

  for (const person of byLength) {
    const escaped = person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `@` then the name, ending at a word boundary. Case-insensitive because nobody types a
    // colleague's name with the capitals they registered with.
    const match = new RegExp(`(^|\\s)@${escaped}\\b`, "i").exec(remaining);
    if (match) {
      found.add(person.id);
      const start = match.index + match[1]!.length;
      const end = start + person.name.length + 1;
      remaining = remaining.slice(0, start) + " ".repeat(end - start) + remaining.slice(end);
    }
  }

  return { userIds: [...found], here };
}

/**
 * §3's record links: *"typing `#QTN-2608-0042` renders an inline card with live status."*
 *
 * The prefixes are this platform's real document numbers, from the numbering formats — not the
 * spec's illustrative example, which predates the house format the company settled on.
 */
export const RECORD_LINK_PREFIXES: { prefix: string; entityType: string; label: string }[] = [
  { prefix: "AIESLQ", entityType: "Quotation", label: "Quotation" },
  { prefix: "AIESIQ", entityType: "Quotation", label: "Quotation" },
  { prefix: "AIESINQ", entityType: "Inquiry", label: "Inquiry" },
  { prefix: "AIESSO", entityType: "SalesOrder", label: "Sales order" },
  { prefix: "AIESTKT", entityType: "Ticket", label: "Ticket" },
  { prefix: "AIESPRJ", entityType: "Project", label: "Project" },
  { prefix: "AIESCA", entityType: "CashAdvance", label: "Cash advance" },
  { prefix: "AIESMR", entityType: "MaterialRequest", label: "Material request" },
  { prefix: "AIESTSK", entityType: "Task", label: "Task" },
];

export interface RecordReference {
  entityType: string;
  /** The number as typed, e.g. `AIESSO-261561`. Resolved to an id by the service. */
  number: string;
  label: string;
}

/**
 * The record numbers a message refers to.
 *
 * `#` is optional. People paste `AIESSO-261561` far more often than they type `#AIESSO-261561`, and
 * a link that only works when somebody remembers the punctuation is a link that mostly does not
 * work.
 */
export function findRecordReferences(body: string): RecordReference[] {
  const found = new Map<string, RecordReference>();

  for (const { prefix, entityType, label } of RECORD_LINK_PREFIXES) {
    const pattern = new RegExp(`#?(${prefix}-?\\d{4,})\\b`, "gi");
    for (const match of body.matchAll(pattern)) {
      const number = match[1]!.toUpperCase();
      if (!found.has(number)) found.set(number, { entityType, number, label });
    }
  }

  return [...found.values()];
}

export interface ChannelCheck {
  ok: boolean;
  errors: string[];
}

export function checkChannel(input: {
  name: string;
  type: ChannelType;
  memberIds: string[];
  isPrivate: boolean;
}): ChannelCheck {
  const errors: string[] = [];

  const name = input.name.trim();
  if (name.length < 2) errors.push("Give the discussion a name.");
  if (name.length > 60) errors.push("That name is too long to read in a list.");

  if (input.isPrivate && input.memberIds.length === 0) {
    // A private channel with no members is one nobody can open, including whoever made it.
    errors.push("A private discussion needs at least one member.");
  }

  if (input.type === "direct" && input.memberIds.length !== 2) {
    errors.push("A direct message is between two people.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Who is told about a message.
 *
 * The rules, in order:
 *
 *  - **The author is never told about their own message.**
 *  - **`none` means none**, even for a mention. Somebody who has turned a channel off has said what
 *    they want; overriding that for `@here` is how people learn to leave a channel instead.
 *  - **`mentions` means named, or `@here`.** `@here` is deliberately included: it is what somebody
 *    types when the thing is actually urgent, and a channel where it reaches nobody would push
 *    people back to phoning round.
 *  - **`all` means every message.**
 */
export function recipientsFor(
  members: { userId: string; notificationLevel: string }[],
  message: { authorId: string; mentions: string[]; mentionedHere: boolean },
): { userId: string; because: "mentioned" | "here" | "all" }[] {
  const mentioned = new Set(message.mentions);
  const out: { userId: string; because: "mentioned" | "here" | "all" }[] = [];

  for (const member of members) {
    if (member.userId === message.authorId) continue;
    if (member.notificationLevel === "none") continue;

    if (mentioned.has(member.userId)) {
      out.push({ userId: member.userId, because: "mentioned" });
      continue;
    }
    if (message.mentionedHere) {
      out.push({ userId: member.userId, because: "here" });
      continue;
    }
    if (member.notificationLevel === "all") {
      out.push({ userId: member.userId, because: "all" });
    }
  }

  return out;
}

/**
 * How many messages somebody has not seen.
 *
 * A member who has never opened the channel has read nothing rather than everything — the opposite
 * default would hide a conversation that started before they were added, which is precisely the
 * conversation they were added for.
 */
export function unreadCount(
  messages: { createdAt: Date; authorId: string }[],
  lastReadAt: Date | null,
  viewerId: string,
): number {
  return messages.filter(
    (message) =>
      message.authorId !== viewerId &&
      (lastReadAt === null || message.createdAt.getTime() > lastReadAt.getTime()),
  ).length;
}

/** Whether somebody may read a channel at all. */
export function canRead(
  channel: { isPrivate: boolean; memberIds: string[] },
  viewerId: string,
): boolean {
  return !channel.isPrivate || channel.memberIds.includes(viewerId);
}

/**
 * Whether somebody may post.
 *
 * An archived channel is read-only, permanently. §3 keeps a closed project's channel *"as part of
 * the project record"*, and a record somebody can still add to after the fact is not a record.
 */
export function canPost(
  channel: { isPrivate: boolean; memberIds: string[]; archivedAt: Date | null },
  viewerId: string,
): boolean {
  if (channel.archivedAt) return false;
  return canRead(channel, viewerId);
}
