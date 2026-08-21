/**
 * §7's quiet hours, as rules — no Prisma, no database, no clock of its own.
 *
 * §7 states both the rule and the reason it is not absolute:
 *
 * > **Quiet hours by default (18:00–07:00 Asia/Manila)** except for `urgent` priority and emergency
 * > tickets — a system that pings technicians at midnight gets muted, and then the important message
 * > is missed too.
 *
 * On `UI_SAFE_SERVER_MODULES`: the settings screen has to describe the same window the service
 * enforces, and a second copy of "18:00 to 07:00" is one that eventually disagrees.
 */

/** The company works in one time zone, so this is a constant rather than a per-user setting. */
export const MANILA_OFFSET_MINUTES = 8 * 60;

/** §7's defaults, held in code so that most people need no row at all. */
export const DEFAULT_QUIET_FROM_MINUTES = 18 * 60;
export const DEFAULT_QUIET_TO_MINUTES = 7 * 60;
export const DEFAULT_DIGEST_AT_MINUTES = 7 * 60;

export interface QuietHours {
  quietHoursOn: boolean;
  quietFromMinutes: number;
  quietToMinutes: number;
  digestAtMinutes: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  quietHoursOn: true,
  quietFromMinutes: DEFAULT_QUIET_FROM_MINUTES,
  quietToMinutes: DEFAULT_QUIET_TO_MINUTES,
  digestAtMinutes: DEFAULT_DIGEST_AT_MINUTES,
};

/** Minutes past midnight in Manila for an instant. */
export function manilaMinutes(at: Date): number {
  const shifted = new Date(at.getTime() + MANILA_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function formatMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Whether an instant falls inside somebody's quiet hours.
 *
 * The window **wraps midnight** — 18:00 to 07:00 is not a range in the ordinary sense, and treating
 * it as one would make every evening notification pass and every morning one wait. A window that does
 * not wrap (say 13:00 to 14:00) is handled by the other branch.
 */
export function isQuiet(at: Date, schedule: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  if (!schedule.quietHoursOn) return false;
  if (schedule.quietFromMinutes === schedule.quietToMinutes) return false;

  const now = manilaMinutes(at);
  return schedule.quietFromMinutes > schedule.quietToMinutes
    ? now >= schedule.quietFromMinutes || now < schedule.quietToMinutes
    : now >= schedule.quietFromMinutes && now < schedule.quietToMinutes;
}

/**
 * Notification types that pass through quiet hours whatever the time.
 *
 * §7 names two things: `urgent` priority and emergency tickets. Both are represented here as the
 * notification types that carry them — the cash advance one is included because §5 of module 04
 * gives it a four-working-hour escalation window, which a night's silence would eat most of.
 *
 * Kept deliberately short. Every addition is a promise that the thing really is worth waking
 * somebody for, and a list that grows is a list that ends with the phone being turned off — which
 * §7 says in as many words is the failure to avoid.
 */
export const ALWAYS_THROUGH_TYPES: readonly string[] = [
  "ticket.emergency",
  "cash_advance.requested",
  "announcement.urgent",
];

export function passesQuietHours(type: string, urgent: boolean): boolean {
  return urgent || ALWAYS_THROUGH_TYPES.includes(type);
}

/**
 * When a held notification is released.
 *
 * The next digest time after the quiet window ends — not the moment quiet hours lift, because
 * releasing at 07:00 sharp would deliver a night's worth of messages in one burst before anybody has
 * opened the app. In practice the two are the same by default, and they come apart the moment
 * somebody moves their digest later.
 */
export function releaseAt(at: Date, schedule: QuietHours = DEFAULT_QUIET_HOURS): Date {
  const now = manilaMinutes(at);
  const target = Math.max(schedule.digestAtMinutes, schedule.quietToMinutes);

  // Minutes to wait, wrapping to tomorrow when the target has already passed today.
  const wait = target > now ? target - now : 24 * 60 - now + target;
  return new Date(at.getTime() + wait * 60_000);
}

export interface ScheduleCheck {
  ok: boolean;
  errors: string[];
}

export function checkSchedule(schedule: QuietHours): ScheduleCheck {
  const errors: string[] = [];
  const inRange = (value: number) => Number.isInteger(value) && value >= 0 && value < 24 * 60;

  if (!inRange(schedule.quietFromMinutes) || !inRange(schedule.quietToMinutes)) {
    errors.push("Quiet hours have to be times of day.");
  }
  if (!inRange(schedule.digestAtMinutes)) {
    errors.push("The digest time has to be a time of day.");
  }
  if (
    schedule.quietHoursOn &&
    schedule.quietFromMinutes === schedule.quietToMinutes &&
    inRange(schedule.quietFromMinutes)
  ) {
    // Equal ends could mean "never quiet" or "always quiet". Refusing is better than guessing at
    // something that decides whether somebody is told about a job at all.
    errors.push("Give quiet hours a start and an end that differ, or switch them off.");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * §7's three levels: *"all, mentions and assignments only, none"*.
 *
 * Here rather than in the settings service because the screen renders them, and a screen may not
 * import a module that touches Prisma. Module 05's `expense-rules` was split out for the same
 * reason, and the import guard is what caught both.
 */
export const TYPE_NOTIFICATION_LEVELS = ["all", "mentions", "none"] as const;
export type TypeNotificationLevel = (typeof TYPE_NOTIFICATION_LEVELS)[number];

export const TYPE_LEVEL_LABELS: Record<TypeNotificationLevel, string> = {
  all: "Tell me each time",
  mentions: "Only in the daily digest",
  none: "Not at all",
};
