"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The table every module renders its lists through.
 *
 * specs/00-foundation.md §8: "DataTable is used by every module. Over-invest here; it will be
 * built 30 times otherwise." So the API is deliberately complete before there is a second caller:
 * server-side pagination, sort, filter chips, saved views, column visibility, CSV export and bulk
 * actions all exist now, because retrofitting any of them across ten modules later is the
 * expensive path.
 *
 * State lives here and is handed *out* through `onStateChange`; the component never fetches. That
 * keeps it usable with tRPC, a server action, or a plain array, and keeps it testable without a
 * network. Callers pass `rows` for the current page plus `total` so paging maths stays honest.
 */

export interface Column<Row> {
  /** Stable key. Used for sorting, column visibility, saved views and the CSV header. */
  key: string;
  header: string;
  /** Cell renderer. Given the whole row so a cell can combine fields. */
  cell: (row: Row) => React.ReactNode;
  /** Plain value for CSV export. Falls back to the cell when it is already a string/number. */
  exportValue?: (row: Row) => string | number | null | undefined;
  sortable?: boolean;
  /** Right-align money and quantity columns. */
  align?: "left" | "right";
  /** Hidden until the user turns it on in the column menu. */
  defaultHidden?: boolean;
  width?: string;
}

export interface FilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

export interface DataTableState {
  page: number;
  pageSize: number;
  sortKey: string | null;
  sortDir: "asc" | "desc";
  search: string;
  hiddenColumns: string[];
}

export interface SavedView {
  id: string;
  name: string;
  state: Partial<DataTableState>;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  /** Stable identity per row — required for selection and React keys. */
  rowId: (row: Row) => string;
  /** Total matching rows on the server, not just this page. */
  total: number;
  state: DataTableState;
  onStateChange: (next: DataTableState) => void;
  isLoading?: boolean;
  filterChips?: FilterChip[];
  savedViews?: SavedView[];
  onSaveView?: (name: string, state: DataTableState) => void;
  /** Rendered above the table when at least one row is selected. */
  bulkActions?: (selectedIds: string[], clear: () => void) => React.ReactNode;
  /** Filename stem for the CSV export. Omit to hide the export button. */
  exportFilename?: string;
  emptyState?: React.ReactNode;
  onRowClick?: (row: Row) => void;
  className?: string;
}

export const DEFAULT_TABLE_STATE: DataTableState = {
  page: 1,
  pageSize: 25,
  sortKey: null,
  sortDir: "asc",
  search: "",
  hiddenColumns: [],
};

export function DataTable<Row>({
  columns,
  rows,
  rowId,
  total,
  state,
  onStateChange,
  isLoading = false,
  filterChips = [],
  savedViews = [],
  onSaveView,
  bulkActions,
  exportFilename,
  emptyState,
  onRowClick,
  className,
}: DataTableProps<Row>) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(state.search);

  const hidden = useMemo(() => new Set(state.hiddenColumns), [state.hiddenColumns]);
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden],
  );

  const patch = useCallback(
    (next: Partial<DataTableState>) => {
      // Any change to filtering, sorting or page size invalidates the current page number —
      // staying on page 7 of a result set that now has 2 pages shows an empty table.
      const resetsPage =
        next.search !== undefined ||
        next.pageSize !== undefined ||
        next.sortKey !== undefined ||
        next.sortDir !== undefined;
      onStateChange({
        ...state,
        ...next,
        ...(resetsPage && next.page === undefined ? { page: 1 } : {}),
      });
    },
    [onStateChange, state],
  );

  // Debounce the search box so typing does not fire a query per keystroke.
  const searchRef = useRef(state.search);
  searchRef.current = state.search;
  useEffect(() => {
    if (searchDraft === searchRef.current) return;
    const t = setTimeout(() => patch({ search: searchDraft }), 300);
    return () => clearTimeout(t);
  }, [searchDraft, patch]);

  // Selection is scoped to ids that still exist in the current page's data, so a selection cannot
  // silently outlive a filter change and apply a bulk action to rows the user can no longer see.
  const pageIds = useMemo(() => rows.map(rowId), [rows, rowId]);
  const selectedOnPage = useMemo(
    () => pageIds.filter((id) => selected.has(id)),
    [pageIds, selected],
  );
  const allOnPageSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const toggleAll = () => {
    const next = new Set(selected);
    if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelected(next);
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleSort = (key: string) => {
    if (state.sortKey === key) patch({ sortDir: state.sortDir === "asc" ? "desc" : "asc" });
    else patch({ sortKey: key, sortDir: "asc" });
  };

  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  const firstRow = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const lastRow = Math.min(state.page * state.pageSize, total);

  const exportCsv = () => {
    if (!exportFilename) return;
    // Exports the visible columns of the current page. Deliberately not "all pages": the
    // component has no fetcher, and silently exporting only what is loaded while implying
    // otherwise is worse than exporting exactly what is on screen.
    const header = visibleColumns.map((c) => c.header);
    const body = rows.map((row) =>
      visibleColumns.map((c) => {
        const v = c.exportValue ? c.exportValue(row) : cellToText(c.cell(row));
        return v === null || v === undefined ? "" : String(v);
      }),
    );
    const csv = [header, ...body].map((r) => r.map(csvEscape).join(",")).join("\r\n");
    // BOM so Excel opens UTF-8 (₱, ñ) correctly instead of mojibake.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportFilename}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Search..."
          className="h-8 w-56"
          aria-label="Search table"
        />

        {savedViews.length > 0 && (
          <Select
            className="h-8 w-44"
            aria-label="Saved view"
            defaultValue=""
            onChange={(e) => {
              const view = savedViews.find((v) => v.id === e.target.value);
              if (view) onStateChange({ ...state, ...view.state, page: 1 });
            }}
          >
            <option value="">Saved views...</option>
            {savedViews.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        )}

        <div className="ml-auto flex items-center gap-2">
          {onSaveView && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const name = window.prompt("Name this view");
                if (name?.trim()) onSaveView(name.trim(), state);
              }}
            >
              Save view
            </Button>
          )}

          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setColumnMenuOpen((o) => !o)}>
              Columns
            </Button>
            {columnMenuOpen && (
              <div
                className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-border bg-surface p-2 shadow-lg"
                onMouseLeave={() => setColumnMenuOpen(false)}
              >
                {columns.map((c) => (
                  <label
                    key={c.key}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={!hidden.has(c.key)}
                      onChange={() => {
                        const next = new Set(hidden);
                        if (next.has(c.key)) next.delete(c.key);
                        else next.add(c.key);
                        patch({ hiddenColumns: [...next], page: state.page });
                      }}
                    />
                    {c.header}
                  </label>
                ))}
              </div>
            )}
          </div>

          {exportFilename && (
            <Button variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {filterChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {filterChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 py-0.5 pr-1 pl-2.5 text-xs"
            >
              {chip.label}
              <button
                type="button"
                onClick={chip.onRemove}
                aria-label={`Remove filter ${chip.label}`}
                className="rounded-full px-1 text-text-muted hover:bg-border hover:text-text"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {bulkActions && selectedOnPage.length > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-blue-400 bg-surface-2 px-3 py-2 text-sm">
          <span className="font-medium">{selectedOnPage.length} selected</span>
          {bulkActions(selectedOnPage, clearSelection)}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clearSelection}>
            Clear
          </Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full border-collapse text-table">
          <thead className="sticky top-0 z-10 bg-surface-2">
            <tr>
              {bulkActions && (
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAll}
                    aria-label="Select all rows on this page"
                  />
                </th>
              )}
              {visibleColumns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    "px-3 py-2 font-medium text-text-muted",
                    c.align === "right" ? "text-right" : "text-left",
                  )}
                  aria-sort={
                    state.sortKey === c.key
                      ? state.sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : undefined
                  }
                >
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-text"
                    >
                      {c.header}
                      <span aria-hidden className="text-xs">
                        {state.sortKey === c.key ? (state.sortDir === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={visibleColumns.length + (bulkActions ? 1 : 0)}
                  className="px-3 py-8 text-center text-text-muted"
                >
                  Loading...
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={visibleColumns.length + (bulkActions ? 1 : 0)}
                  className="px-3 py-10 text-center"
                >
                  {emptyState ?? <span className="text-text-muted">No records found.</span>}
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const id = rowId(row);
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "border-t border-border",
                    onRowClick && "cursor-pointer",
                    selected.has(id) ? "bg-surface-2" : "hover:bg-surface-2/60",
                  )}
                >
                  {bulkActions && (
                    <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(id)}
                        onChange={() => toggleOne(id)}
                        aria-label="Select row"
                      />
                    </td>
                  )}
                  {visibleColumns.map((c) => (
                    <td
                      key={c.key}
                      className={cn("px-3 py-1.5", c.align === "right" && "text-right")}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm text-text-muted">
        <span>
          {firstRow}–{lastRow} of {total}
        </span>
        <Select
          className="h-8 w-24"
          aria-label="Rows per page"
          value={state.pageSize}
          onChange={(e) => patch({ pageSize: Number(e.target.value) })}
        >
          {[25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={state.page <= 1}
            onClick={() => patch({ page: state.page - 1 })}
          >
            Previous
          </Button>
          <span>
            Page {state.page} of {pageCount}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={state.page >= pageCount}
            onClick={() => patch({ page: state.page + 1 })}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Best-effort text for CSV when a column has no explicit exportValue. Anything that is not a
 *  primitive should define `exportValue` — this returns "" rather than guessing at JSX. */
function cellToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  return "";
}

/** RFC 4180: wrap in quotes when the value contains a comma, quote or newline, and double any
 *  embedded quotes. A customer named `Smith, Ltd "Manila"` must not shift every later column. */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
