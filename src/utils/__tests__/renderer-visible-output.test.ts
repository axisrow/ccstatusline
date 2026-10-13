import chalk from 'chalk';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { RenderContext } from '../../types/RenderContext';
import {
    DEFAULT_SETTINGS,
    type Settings
} from '../../types/Settings';
import type { WidgetItem } from '../../types/Widget';
import { CustomCommandWidget } from '../../widgets/CustomCommand';
import { stripSgrCodes } from '../ansi';
import {
    getColorAnsiCode,
    updateColorMap
} from '../colors';
import {
    preRenderAllWidgets,
    renderStatusLine,
    renderStatusLineWithInfo,
    type PreRenderedWidget
} from '../renderer';

function createSettings(overrides: Partial<Settings> = {}): Settings {
    return {
        ...DEFAULT_SETTINGS,
        colorLevel: 2,
        ...overrides,
        powerline: {
            ...DEFAULT_SETTINGS.powerline,
            ...(overrides.powerline ?? {})
        }
    };
}

function preRendered(widgets: WidgetItem[], contentByIndex: Record<number, string>): PreRenderedWidget[] {
    return widgets.map((widget, i) => {
        const content = contentByIndex[i] ?? '';
        return { content, plainLength: stripSgrCodes(content).length, widget };
    });
}

const context: RenderContext = { isPreview: false, terminalWidth: 200 };
const SEP: WidgetItem = { id: 'sep', type: 'separator' };
const text = (id: string): WidgetItem => ({ id, type: 'custom-text' });
const command = (id: string, extra: Partial<WidgetItem> = {}): WidgetItem => ({ id, type: 'custom-command', commandPath: 'unused', preserveColors: true, ...extra });

describe('regular-mode widgets that preserve their own colors', () => {
    const originalLevel = chalk.level;

    beforeEach(() => {
        chalk.level = 2;
        updateColorMap();
    });

    afterEach(() => {
        chalk.level = originalLevel;
        updateColorMap();
    });

    it('keeps the widget background after a reset inside the content', () => {
        const widgets = [command('cmd', { backgroundColor: 'bgBlue' })];
        const line = renderStatusLine(widgets, createSettings(), context, preRendered(widgets, { 0: '\x1b[31mred\x1b[0m tail' }), []);
        const background = getColorAnsiCode('bgBlue', 'ansi256', true);

        expect(line).toContain(`\x1b[0m${background} tail`);
    });

    it('keeps the override background after a reset inside the content', () => {
        const widgets = [command('cmd')];
        const settings = createSettings({ overrideBackgroundColor: 'bgBlue' });
        const line = renderStatusLine(widgets, settings, context, preRendered(widgets, { 0: '\x1b[31mred\x1b[0m tail' }), []);

        expect(line).toContain(`\x1b[0m${getColorAnsiCode('bgBlue', 'ansi256', true)} tail`);
    });

    it('closes styles the content leaves open before the next widget', () => {
        const widgets = [command('cmd'), SEP, text('next')];
        const line = renderStatusLine(widgets, createSettings(), context, preRendered(widgets, { 0: '\x1b[1;4mX', 2: 'next' }), []);

        const closeIndex = line.indexOf('\x1b[0m', line.indexOf('X'));
        expect(closeIndex).toBeGreaterThan(-1);
        expect(closeIndex).toBeLessThan(line.indexOf(' | '));
    });
});

describe('widgets with no visible output', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('treat color-only output as empty so their separators collapse', () => {
        // What a script printing an empty variable in color, e.g.
        // printf '\033[33m%s\033[0m' "$EMPTY", hands back
        vi.spyOn(CustomCommandWidget.prototype, 'render').mockReturnValue('\x1b[33m\x1b[0m');
        const widgets: WidgetItem[] = [
            { id: 'a', type: 'custom-text', customText: 'A' },
            SEP,
            command('cmd'),
            SEP,
            { id: 'b', type: 'custom-text', customText: 'B' }
        ];
        const settings = createSettings({ colorLevel: 0 });
        const preRenderedLine = preRenderAllWidgets([widgets], settings, context)[0] ?? [];

        expect(preRenderedLine[2]?.plainLength).toBe(0);
        expect(preRenderedLine[2]?.content).toBe('');
        expect(stripSgrCodes(renderStatusLine(widgets, settings, context, preRenderedLine, []))).toBe('A | B');
    });
});

describe('truncation reporting', () => {
    it('does not report widget text that contains "..." as truncated', () => {
        const widgets = [text('a')];
        const result = renderStatusLineWithInfo(widgets, createSettings({ colorLevel: 0 }), context, preRendered(widgets, { 0: '.../Projects/app' }), []);

        expect(result.wasTruncated).toBe(false);
    });

    it('reports a line cut to fit the width', () => {
        const widgets = [text('a')];
        const narrow: RenderContext = { isPreview: false, terminalWidth: 16 };
        const result = renderStatusLineWithInfo(widgets, createSettings({ colorLevel: 0, flexMode: 'full' }), narrow, preRendered(widgets, { 0: 'a long widget text' }), []);

        expect(result.wasTruncated).toBe(true);
        expect(stripSgrCodes(result.line)).toBe('a long ...');
    });

    it('reports a Powerline line cut to fit the width', () => {
        const widgets = [text('a')];
        const narrow: RenderContext = { isPreview: false, terminalWidth: 16 };
        const settings = createSettings({ colorLevel: 0, flexMode: 'full', powerline: { ...DEFAULT_SETTINGS.powerline, enabled: true } });

        expect(renderStatusLineWithInfo(widgets, settings, narrow, preRendered(widgets, { 0: 'a long widget text' }), []).wasTruncated).toBe(true);
        expect(renderStatusLineWithInfo(widgets, settings, context, preRendered(widgets, { 0: 'fits...' }), []).wasTruncated).toBe(false);
    });
});
