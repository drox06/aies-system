export interface NotificationChannels {
  inApp: boolean;
  email: boolean;
  digest: boolean;
}

export interface NotificationTypeDef {
  key: string;
  label: string;
  defaultChannels: NotificationChannels;
  /** Same recipient+type+entityType+entityId within this window bumps the existing notification
   *  instead of creating a new one (specs/00-foundation.md §7.3). 0 or omitted disables it. */
  coalesceWindowMs?: number;
}

const types = new Map<string, NotificationTypeDef>();

export function registerNotificationType(def: NotificationTypeDef): void {
  if (types.has(def.key)) {
    throw new Error(`Notification type "${def.key}" is already registered.`);
  }
  types.set(def.key, def);
}

export function getNotificationType(key: string): NotificationTypeDef | undefined {
  return types.get(key);
}

export function listNotificationTypes(): NotificationTypeDef[] {
  return [...types.values()];
}

/** Test-only: clears the registry between test files. */
export function __resetNotificationTypesForTests(): void {
  types.clear();
}
