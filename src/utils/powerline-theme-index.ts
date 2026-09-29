import type { Settings } from '../types/Settings';
import type { WidgetItem } from '../types/Widget';

export interface PowerlineThemeSlotEntry {
    content: string;
    widget: WidgetItem;
}

export function countPowerlineThemeSlots(entries: PowerlineThemeSlotEntry[]): number {
    let previousVisibleWidget: WidgetItem | null = null;
    let slotCount = 0;

    for (const entry of entries) {
        if (entry.widget.type === 'separator' || entry.widget.type === 'flex-separator') {
            previousVisibleWidget = null;
            continue;
        }

        if (!entry.content) {
            continue;
        }

        if (!previousVisibleWidget?.merge) {
            slotCount++;
        }

        previousVisibleWidget = entry.widget;
    }

    return slotCount;
}

export function advanceGlobalPowerlineThemeIndex(currentIndex: number, entries: PowerlineThemeSlotEntry[]): number {
    return currentIndex + countPowerlineThemeSlots(entries);
}

// True when line `lineIndex` carries its own theme ('none' counts: it is an
// explicit per-line setting, not an inherit-from-global fallback).
export function hasOwnLineTheme(settings: Pick<Settings, 'lineThemes'>, lineIndex: number): boolean {
    const theme = settings.lineThemes?.[lineIndex];
    return theme !== undefined && theme !== null;
}
