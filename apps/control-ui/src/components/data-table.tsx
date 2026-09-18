"use client";

import React, { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export type Column<T> = {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Identifying column: pinned on horizontal scroll, used as the card heading. */
  primary?: boolean;
  /** Hide the column in table mode below this breakpoint (still shown in card mode). */
  hideBelow?: "lg" | "xl";
  align?: "left" | "right";
  width?: string;
};

type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  renderExpanded?: (row: T) => React.ReactNode;
  expandLabel?: (row: T) => string;
  emptyMessage?: string;
  caption?: string;
};

const HIDE_CLASS: Record<string, string> = {
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  onRowClick,
  renderExpanded,
  expandLabel,
  emptyMessage = "No records match the current filters.",
  caption,
}: DataTableProps<T>) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const primaryCol = columns.find((c) => c.primary) ?? columns[0];
  const secondaryCols = columns.filter((c) => c.id !== primaryCol.id);

  if (rows.length === 0) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-xs text-ink-2">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <>
      {/* ---------- Desktop / tablet: scrollable table with pinned identifier ---------- */}
      <div className="scroll-x hidden md:block">
        <table className="data-table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {renderExpanded && (
                <th scope="col" className="w-10">
                  <span className="sr-only">Expand row</span>
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.id}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={`${col.primary ? "pin" : ""} ${
                    col.hideBelow ? HIDE_CLASS[col.hideBelow] : ""
                  } ${col.align === "right" ? "text-right" : ""}`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const key = getRowKey(row);
              const isOpen = Boolean(expanded[key]);
              return (
                <React.Fragment key={key}>
                  <tr
                    data-clickable={onRowClick ? "true" : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {renderExpanded && (
                      <td className="align-middle">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(key);
                          }}
                          aria-expanded={isOpen}
                          aria-label={
                            expandLabel
                              ? expandLabel(row)
                              : `Toggle details for ${key}`
                          }
                          className="rounded-md p-1 text-ink-3 hover:bg-mint hover:text-ink"
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </td>
                    )}
                    {columns.map((col) => (
                      <td
                        key={col.id}
                        className={`${col.primary ? "pin" : ""} ${
                          col.hideBelow ? HIDE_CLASS[col.hideBelow] : ""
                        } ${col.align === "right" ? "text-right" : ""}`}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                  {renderExpanded && isOpen && (
                    <tr>
                      <td
                        colSpan={columns.length + 1}
                        className="bg-surface-2 p-0"
                      >
                        <div className="px-4 py-3">{renderExpanded(row)}</div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---------- Mobile: stacked record cards ---------- */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((row) => {
          const key = getRowKey(row);
          const isOpen = Boolean(expanded[key]);
          return (
            <li key={key} className="p-4">
              <div
                role={onRowClick ? "button" : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === "Enter") onRowClick(row);
                      }
                    : undefined
                }
                className="space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">{primaryCol.cell(row)}</div>
                  {renderExpanded && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(key);
                      }}
                      aria-expanded={isOpen}
                      aria-label={
                        expandLabel
                          ? expandLabel(row)
                          : `Toggle details for ${key}`
                      }
                      className="shrink-0 rounded-md border border-line p-1 text-ink-3"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  {secondaryCols.map((col) => (
                    <div key={col.id} className="min-w-0">
                      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                        {col.header}
                      </dt>
                      <dd className="mt-0.5 min-w-0">{col.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {renderExpanded && isOpen && (
                <div className="mt-3">{renderExpanded(row)}</div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
