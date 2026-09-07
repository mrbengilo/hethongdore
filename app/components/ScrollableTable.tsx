import type { ReactNode } from "react";

/** The labelled region lets keyboard users scroll tables wider than the screen. */
export default function ScrollableTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Horizontal scrolling must also be reachable with a keyboard.
    <div className="data-table-wrap" role="region" aria-label={label} tabIndex={0}>{children}</div>
  );
}
