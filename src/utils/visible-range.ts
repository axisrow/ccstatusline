// Window of at most `maxVisible` rows around the selected one, for lists that
// can be taller than the terminal.
export function getVisibleRange(selectedIndex: number, totalItems: number, maxVisible: number): { start: number; end: number } {
    if (totalItems <= maxVisible) {
        return { start: 0, end: totalItems };
    }

    const halfWindow = Math.floor(maxVisible / 2);
    const maxStart = totalItems - maxVisible;
    const start = Math.min(Math.max(0, selectedIndex - halfWindow), maxStart);
    return { start, end: start + maxVisible };
}
