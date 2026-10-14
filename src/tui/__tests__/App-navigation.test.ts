import * as fs from 'node:fs';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { DEFAULT_SETTINGS } from '../../types/Settings';
import * as claudeSettings from '../../utils/claude-settings';
import * as globalPackageManager from '../../utils/global-package-manager';
import * as claudeStatus from '../claude-status';

import {
    KEYS,
    pressKey,
    renderApp,
    setUpAppSandbox,
    type AppSandbox,
    type RenderedApp
} from './helpers/render-app';
import { waitFor } from './helpers/wait-for-ink';

function selectedRow(rendered: RenderedApp): string {
    return rendered.getFrame().split('\n').find(row => row.includes('▶')) ?? '';
}

describe('App navigation keeps the highlight on the item you left', () => {
    let sandbox: AppSandbox;

    beforeEach(() => {
        sandbox = setUpAppSandbox();
        vi.spyOn(claudeStatus, 'loadClaudeStatusLineState').mockResolvedValue({ existingStatusLine: null, refreshInterval: null });
        vi.spyOn(claudeSettings, 'isInstalled').mockResolvedValue(false);
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('returns to Powerline Setup after toggling powerline there', async () => {
        fs.writeFileSync(sandbox.settingsPath, JSON.stringify(DEFAULT_SETTINGS));
        const rendered = renderApp();

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Main Menu');
            });
            for (const label of ['🧩 Presets', '🎨 Edit Colors', '🌈 Theme', '🧶 Line Themes', '⚡ Powerline Setup']) {
                await pressKey(rendered, KEYS.down, `▶  ${label}`);
            }
            await pressKey(rendered, KEYS.enter, 'Powerline Mode');
            await pressKey(rendered, 't', 'Do you want to continue?');
            await pressKey(rendered, KEYS.enter, '✓ Enabled');
            await pressKey(rendered, KEYS.escape, 'Main Menu');

            // Powerline hid the Theme entry above; the highlight must not slide down
            expect(rendered.getFrame()).not.toContain('🌈 Theme');
            expect(selectedRow(rendered)).toContain('⚡ Powerline Setup');
        } finally {
            rendered.cleanup();
        }
    });

    it('does not reopen Edit Lines on "← Back" after deleting the last line', async () => {
        fs.writeFileSync(sandbox.settingsPath, JSON.stringify({
            ...DEFAULT_SETTINGS,
            lines: [
                [{ id: 'a', type: 'model' }],
                [{ id: 'b', type: 'model' }],
                [{ id: 'c', type: 'model' }]
            ]
        }));
        const rendered = renderApp();

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Main Menu');
            });
            await pressKey(rendered, KEYS.enter, '☰ Line 3');
            await pressKey(rendered, KEYS.down, '▶  ☰ Line 2');
            await pressKey(rendered, KEYS.down, '▶  ☰ Line 3');
            await pressKey(rendered, KEYS.enter, 'Edit Line 3');
            await pressKey(rendered, KEYS.escape, '▶  ☰ Line 3');
            await pressKey(rendered, 'd', 'Are you sure you want to delete line?');
            await pressKey(rendered, KEYS.enter, '▶  ☰ Line 2');
            await pressKey(rendered, KEYS.escape, 'Main Menu');
            await pressKey(rendered, KEYS.enter, 'Select Line to Edit Items');

            expect(selectedRow(rendered)).toContain('☰ Line 2');
        } finally {
            rendered.cleanup();
        }
    });

    it('keeps the highlight on the line above a deleted one that was not the remembered line', async () => {
        fs.writeFileSync(sandbox.settingsPath, JSON.stringify({
            ...DEFAULT_SETTINGS,
            lines: [
                [{ id: 'a', type: 'model' }],
                [{ id: 'b', type: 'model' }, { id: 'b2', type: 'model' }],
                [{ id: 'c', type: 'model' }, { id: 'c2', type: 'model' }, { id: 'c3', type: 'model' }]
            ]
        }));
        const rendered = renderApp();

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Main Menu');
            });
            await pressKey(rendered, KEYS.enter, '☰ Line 3');
            await pressKey(rendered, KEYS.down, '▶  ☰ Line 2');
            await pressKey(rendered, KEYS.down, '▶  ☰ Line 3');
            await pressKey(rendered, KEYS.enter, 'Edit Line 3');
            await pressKey(rendered, KEYS.escape, '▶  ☰ Line 3');
            await pressKey(rendered, KEYS.up, '▶  ☰ Line 2');
            await pressKey(rendered, KEYS.up, '▶  ☰ Line 1');
            await pressKey(rendered, 'd', 'Are you sure you want to delete line?');
            await pressKey(rendered, KEYS.enter, '☰ Line 2 (3 widgets)');

            expect(selectedRow(rendered)).toContain('☰ Line 1 (2 widgets)');
        } finally {
            rendered.cleanup();
        }
    });

    it('shows the regular Presets screen once the first-run picker is answered', async () => {
        const rendered = renderApp({ firstRun: true });

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Welcome to ccstatusline');
            });
            await pressKey(rendered, KEYS.enter, 'Main Menu');
            await pressKey(rendered, KEYS.down, '▶  🧩 Presets');
            await pressKey(rendered, KEYS.enter, 'Starter');

            expect(rendered.getFrame()).not.toContain('Welcome to ccstatusline');
            expect(rendered.getFrame()).toContain('Applying a preset replaces your entire configuration.');
        } finally {
            rendered.cleanup();
        }
    });
});

describe('Terminal Options color level warning', () => {
    let sandbox: AppSandbox;

    beforeEach(() => {
        sandbox = setUpAppSandbox();
        vi.spyOn(claudeStatus, 'loadClaudeStatusLineState').mockResolvedValue({ existingStatusLine: null, refreshInterval: null });
        vi.spyOn(claudeSettings, 'isInstalled').mockResolvedValue(false);
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('asks the question its Yes / No answers', async () => {
        fs.writeFileSync(sandbox.settingsPath, JSON.stringify({
            ...DEFAULT_SETTINGS,
            colorLevel: 3,
            lines: [[{ id: 'a', type: 'model', color: 'hex:FF8800' }]]
        }));
        const rendered = renderApp();

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Main Menu');
            });
            for (const label of ['🧩 Presets', '🎨 Edit Colors', '🌈 Theme', '🧶 Line Themes', '⚡ Powerline Setup', '💻 Terminal Options']) {
                await pressKey(rendered, KEYS.down, `▶  ${label}`);
            }
            await pressKey(rendered, KEYS.enter, '▶  ◱ Terminal Width');
            await pressKey(rendered, KEYS.down, '▶  ▓ Color Level');
            await pressKey(rendered, KEYS.enter, 'Custom colors detected!');

            expect(rendered.getFrame()).toContain('Continue?');
        } finally {
            rendered.cleanup();
        }
    });
});

describe('Pinned version mismatch screen', () => {
    let sandbox: AppSandbox;

    beforeEach(() => {
        sandbox = setUpAppSandbox();
    });

    afterEach(() => {
        sandbox.restore();
    });

    it('labels the relaunch command as a command, not as the pinned version', async () => {
        fs.writeFileSync(sandbox.settingsPath, JSON.stringify({
            ...DEFAULT_SETTINGS,
            installation: { method: 'pinned', installedVersion: '2.2.0' }
        }));
        vi.spyOn(claudeStatus, 'loadClaudeStatusLineState').mockResolvedValue({ existingStatusLine: null, refreshInterval: null });
        vi.spyOn(claudeSettings, 'isInstalled').mockResolvedValue(true);
        vi.spyOn(globalPackageManager, 'inspectActiveGlobalCommand').mockReturnValue({
            packageManager: 'bun',
            resolvedPath: '/home/alice/.bun/bin/ccstatusline',
            resolvedPaths: ['/home/alice/.bun/bin/ccstatusline'],
            binDir: '/home/alice/.bun/bin',
            version: '2.2.0',
            warning: null
        });
        const rendered = renderApp();

        try {
            await waitFor(() => {
                expect(rendered.getFrame()).toContain('Pinned Install Version Mismatch');
            });

            expect(rendered.getFrame()).toContain('Relaunch the pinned version with:');
            expect(rendered.getFrame()).not.toContain('Current pinned version:');
        } finally {
            rendered.cleanup();
        }
    });
});
