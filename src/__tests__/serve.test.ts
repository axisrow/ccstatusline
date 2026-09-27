import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createProcessServeDependencies,
    handleServeLine
} from '../serve';
import type { RenderInvocation } from '../types/RenderContext';
import type { Settings } from '../types/Settings';
import { DEFAULT_SETTINGS } from '../types/Settings';
import type { LoadedSettings } from '../utils/config';

const MINIMAL_LINES: Settings['lines'] = [[{ id: 'model', type: 'model' }]];

const testDeps = {
    loadSettings: (): Promise<LoadedSettings> => Promise.resolve({
        settings: { ...DEFAULT_SETTINGS, lines: MINIMAL_LINES },
        loadError: null
    }),
    resolveTerminalWidth: () => null,
    buildInvocation: (terminalWidth: number | null): RenderInvocation => ({
        configPath: '/tmp/test-settings.json',
        cwd: '/tmp',
        env: {},
        terminalWidth
    })
};

describe('handleServeLine', () => {
    it('renders a valid payload into a JSON response with the status text', async () => {
        const response = await handleServeLine(
            JSON.stringify({ model: { id: 'claude-test-model' }, cwd: '/tmp' }),
            testDeps
        );

        const parsed = JSON.parse(response) as { text?: string; error?: string };
        expect(parsed.error).toBeUndefined();
        expect(parsed.text).toContain('claude-test-model');
    });

    it('answers invalid JSON with an error object instead of crashing', async () => {
        const response = await handleServeLine('{not json', testDeps);

        const parsed = JSON.parse(response) as { text?: string; error?: string };
        expect(parsed.text).toBeUndefined();
        expect(parsed.error).toContain('invalid JSON');
    });

    it('answers schema-invalid payloads with an error object', async () => {
        const response = await handleServeLine(JSON.stringify({ model: 42 }), testDeps);

        const parsed = JSON.parse(response) as { text?: string; error?: string };
        expect(parsed.error).toContain('invalid status JSON');
    });

    it('returns no response for blank input lines', async () => {
        expect(await handleServeLine('', testDeps)).toBe('');
        expect(await handleServeLine('   \n', testDeps)).toBe('');
    });

    it('wires process dependencies that read the real config path', () => {
        const deps = createProcessServeDependencies();
        const invocation = deps.buildInvocation(null);

        expect(invocation.terminalWidth).toBeNull();
        expect(typeof deps.loadSettings).toBe('function');
    });
});
