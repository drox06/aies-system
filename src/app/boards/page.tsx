"use client";

import { Card } from "@/components/ui/layout";
import { trpc } from "@/lib/trpc/client";
import { BoardView } from "./BoardView";

/**
 * §2's boards (specs/06-collaboration.md), opened straight onto the one everybody needs first.
 *
 * The company's own instruction (2026-09-02): *"repurpose the board to display the different states
 * the raised tasks are in."* Before this, `/boards` was a list nobody could get a kanban out of
 * without first making one — the states-of-work view §2 describes was always buildable by hand, but
 * "the board" as EA meant it is one thing, not a list of things to configure.
 *
 * So this screen resolves the always-on "Task board" (`ensureDefaultBoardService`, provisioned on
 * the first visit ever) and renders it directly. Custom boards — somebody's own filtered view, a
 * manual board for one job — still exist and are still one click away, via "All boards" inside
 * `BoardView` itself.
 */
export default function BoardsHomePage() {
  const defaultBoard = trpc.collab.defaultBoard.useQuery();

  if (defaultBoard.isLoading) return <Card className="text-sm text-text-muted">Loading…</Card>;

  if (defaultBoard.isError) {
    return (
      <Card className="text-sm">
        <p className="font-medium">The board could not be opened.</p>
        <p className="mt-1 text-text-muted">{defaultBoard.error.message}</p>
      </Card>
    );
  }

  return <BoardView boardId={defaultBoard.data!.id} allBoardsHref="/boards/all" />;
}
