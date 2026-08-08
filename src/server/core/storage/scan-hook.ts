export interface ScanResult {
  clean: boolean;
  reason?: string;
}

export type ScanHook = (
  buffer: Buffer,
  meta: { filename: string; mimeType: string },
) => Promise<ScanResult>;

export const noopScanHook: ScanHook = async () => ({ clean: true });

// specs/00-foundation.md §7.2: "Provide a scanHook interface (no-op by default) so a scanner can
// be wired in later without touching call sites."
let activeScanHook: ScanHook = noopScanHook;

export function setScanHook(hook: ScanHook): void {
  activeScanHook = hook;
}

export function getScanHook(): ScanHook {
  return activeScanHook;
}

/** Test-only: restores the no-op hook between test files. */
export function __resetScanHookForTests(): void {
  activeScanHook = noopScanHook;
}
