import { render } from 'ink';
import { PassThrough } from 'node:stream';
import React from 'react';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { DEFAULT_SETTINGS } from '../../../types/Settings';
import { LineSelector } from '../LineSelector';

class MockTtyStream extends PassThrough {
    isTTY = true;
    columns = 120;
    rows = 40;

    setRawMode() {
        return this;
    }

    ref() {
        return this;
    }

    unref() {
        return this;
    }
}

function createMockStdin(): NodeJS.ReadStream {
    return new MockTtyStream() as unknown as NodeJS.ReadStream;
}

function createMockStdout(): NodeJS.WriteStream & { getOutput: () => string } {
    const stream = new MockTtyStream();
    const chunks: string[] = [];

    stream.on('data', (chunk: Buffer | string) => {
        chunks.push(chunk.toString());
    });

    return Object.assign(stream as unknown as NodeJS.WriteStream, {
        getOutput() {
            return chunks.join('');
        }
    });
}

function createMockStderr(): NodeJS.WriteStream {
    return new MockTtyStream() as unknown as NodeJS.WriteStream;
}

function flushInk() {
    return new Promise((resolve) => {
        setTimeout(resolve, 25);
    });
}

function renderLineSelector(settings: Parameters<typeof LineSelector>[0]['settings'], stdout: NodeJS.WriteStream, stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream) {
    return render(
        React.createElement(LineSelector, {
            lines: [
                [{ id: '1', type: 'model' }],
                [{ id: '2', type: 'model' }]
            ],
            onSelect: vi.fn(),
            onBack: vi.fn(),
            onLinesUpdate: vi.fn(),
            title: 'Select Line',
            blockIfPowerlineActive: true,
            settings,
            allowEditing: false
        }),
        {
            stdin,
            stdout,
            stderr,
            debug: true,
            exitOnCtrlC: false,
            patchConsole: false
        }
    );
}

describe('LineSelector theme-managed block', () => {
    it('renders the list when at least one line has its own theme', async () => {
        const stdin = createMockStdin();
        const stdout = createMockStdout();
        const stderr = createMockStderr();
        const settings = {
            ...DEFAULT_SETTINGS,
            powerline: {
                ...DEFAULT_SETTINGS.powerline,
                enabled: true,
                theme: 'nord'
            },
            lineThemes: [undefined, 'none']
        };

        const instance = renderLineSelector(settings, stdout, stdin, stderr);

        try {
            await flushInk();
            const output = stdout.getOutput();

            expect(output).toContain('Line 1');
            expect(output).not.toContain('managed by the Powerline theme');
        } finally {
            instance.unmount();
            instance.cleanup();
            stdin.destroy();
            stdout.destroy();
            stderr.destroy();
        }
    });

    it('shows the theme-managed block when every line inherits the global theme', async () => {
        const stdin = createMockStdin();
        const stdout = createMockStdout();
        const stderr = createMockStderr();
        const settings = {
            ...DEFAULT_SETTINGS,
            powerline: {
                ...DEFAULT_SETTINGS.powerline,
                enabled: true,
                theme: 'nord'
            }
        };

        const instance = renderLineSelector(settings, stdout, stdin, stderr);

        try {
            await flushInk();
            const output = stdout.getOutput();

            expect(output).toContain('managed by the Powerline theme');
        } finally {
            instance.unmount();
            instance.cleanup();
            stdin.destroy();
            stdout.destroy();
            stderr.destroy();
        }
    });
});
