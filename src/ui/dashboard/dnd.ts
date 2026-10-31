import type { DragEvent } from 'react';

export const TAB_DRAG_TYPE = 'application/x-tabvault-tabs';

export function setDraggedTabs(e: DragEvent, tabIds: number[]): void {
  e.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify(tabIds));
  e.dataTransfer.effectAllowed = 'copyMove';
}

/** Dropped data is parsed defensively; it arrives as an arbitrary string. */
export function readDraggedTabs(e: DragEvent): number[] {
  try {
    const parsed: unknown = JSON.parse(e.dataTransfer.getData(TAB_DRAG_TYPE));
    return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}
