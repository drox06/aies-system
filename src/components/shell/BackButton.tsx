"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * Back, for the installed app.
 *
 * ## Why a browser has this and the app does not
 *
 * A standalone PWA — added to the home screen on iOS, installed on Android — renders with no browser
 * chrome at all. No address bar, no back button. That is the point of installing it, and it is also
 * how somebody who taps into a ticket from the dispatch board ends up with no way back except the
 * sidebar, which drops them at a list rather than where they were. On iOS there is not even a system
 * gesture to fall back on for the first navigation in a session.
 *
 * The company asked for it directly: "add a back to previous page button on the app if not viewed in
 * a browser."
 *
 * ## Why it is conditional
 *
 * Shown only when the app is running standalone. In a browser it would be a second back button an
 * inch from the real one, which is clutter at best and, when the two disagree about history, a
 * control that behaves differently from the one beside it.
 *
 * ## Why it is disabled rather than hidden at the start of a session
 *
 * `history.length <= 1` means there is nowhere to go back to — a fresh launch straight onto a
 * bookmarked page. Hiding it then would make the header jump as soon as somebody navigated once;
 * disabling it keeps the layout still and, per this week's rule, says why.
 */
export function BackButton() {
  const router = useRouter();
  const pathname = usePathname();
  const [standalone, setStandalone] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    // `display-mode: standalone` covers Android and desktop installs; `navigator.standalone` is
    // Safari's own, older flag, and iOS home-screen apps still report through it.
    const media = window.matchMedia("(display-mode: standalone)");
    const iosStandalone =
      "standalone" in window.navigator &&
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

    const update = () => setStandalone(media.matches || iosStandalone);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Re-checked per navigation: history grows as somebody moves around inside the app.
  useEffect(() => {
    setCanGoBack(window.history.length > 1);
  }, [pathname]);

  if (!standalone) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={!canGoBack}
      title={canGoBack ? "Back" : "Nothing to go back to yet"}
      aria-label="Back to the previous page"
      onClick={() => router.back()}
    >
      <span aria-hidden>←</span>
    </Button>
  );
}
