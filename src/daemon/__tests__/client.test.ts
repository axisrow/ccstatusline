import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import type { StartedTestDaemon } from './test-daemon';
import {
    startTestDaemon,
    stopTestDaemon
} from './test-daemon';

// End-to-end test of the shipped shell client: a real /bin/sh process, real
// curl, real Unix socket. This is the acceptance run for the repaint path —
// stdout carries the rendered line only on success.

const clientPath = fileURLToPath(new URL('../../../client/ccstatusline-ipc', import.meta.url));

const started: StartedTestDaemon[] = [];

async function start(): Promise<StartedTestDaemon> {
    const handle = await startTestDaemon();
    started.push(handle);
    return handle;
}

afterEach(async () => {
    for (const handle of started.splice(0)) {
        await stopTestDaemon(handle);
    }
});

async function runClient(runtimeDir: string, payload: string, extraEnv: Record<string, string> = {}): Promise<{
    status: number;
    stdout: string;
    stderr: string;
}> {
    // stdin comes from a file, not a spawn pipe: curl reads the request body
    // from the saved fd until EOF, and a pipe held open by the test harness
    // would deadlock it. A regular file gives EOF — the same as Claude Code
    // closing the statusline command's stdin. Async spawn rather than
    // spawnSync: bun's spawnSync pumps the event loop while the in-process
    // test daemon is serving over the same loop.
    const payloadPath = path.join(runtimeDir, 'payload.json');
    fs.writeFileSync(payloadPath, payload);
    return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', [
            '-c',
            `"${clientPath}" < "${payloadPath}"`,
            'ccstatusline-ipc-test'
        ], {
            cwd: runtimeDir,
            env: {
                ...process.env,
                CCSTATUSLINE_RUNTIME_DIR: runtimeDir,
                ...extraEnv
            }
        });
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('client run timed out'));
        }, 20000);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            clearTimeout(timeout);
            resolve({ status: code ?? -1, stdout, stderr });
        });
    });
}

describe('shell client end to end', () => {
    it('forwards the payload and prints exactly the rendered line', async () => {
        const { daemon } = await start();
        const payload = JSON.stringify({ model: { id: 'claude-client-model' }, cwd: '/tmp' });

        const result = await runClient(daemon.runtimeDir, payload);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('claude-client-model');
        expect(result.stdout.endsWith('\n')).toBe(true);
    });

    it('carries invocation context (env vars and cwd) through the header', async () => {
        const { daemon, dependencies } = await start();
        const payload = JSON.stringify({ model: { id: 'claude-client-model' }, cwd: '/tmp' });

        const result = await runClient(daemon.runtimeDir, payload, {
            CLAUDE_CONFIG_DIR: '/ccsd-client-config',
            CCSTATUSLINE_WIDTH: '90'
        });

        expect(result.status).toBe(0);
        const invocation = dependencies.invocations.at(-1);
        expect(invocation?.env.CLAUDE_CONFIG_DIR).toBe('/ccsd-client-config');
        expect(invocation?.env.CCSTATUSLINE_WIDTH).toBe('90');
        // The client reports its physical working directory (pwd -P), which
        // on macOS resolves the /var -> /private/var symlink.
        expect(invocation?.cwd).toBe(fs.realpathSync(daemon.runtimeDir));
    });

    it('round-trips a Unicode model id byte-exact', async () => {
        const { daemon } = await start();
        const payload = JSON.stringify({ model: { id: 'модель-✓-Ünïcode' }, cwd: '/tmp' });

        const result = await runClient(daemon.runtimeDir, payload);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('модель-✓-Ünïcode');
    });

    it('fails with empty stdout when the daemon is not running', async () => {
        const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsd-client-none-'));
        try {
            const result = await runClient(runtimeDir, '{}');

            expect(result.status).not.toBe(0);
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('ccstatusline-ipc');
        } finally {
            fs.rmSync(runtimeDir, { recursive: true, force: true });
        }
    });

    it('fails with empty stdout on a wrong token (HTTP 401) instead of printing the error body', async () => {
        const { daemon } = await start();
        fs.writeFileSync(daemon.discoveryPath, fs.readFileSync(daemon.discoveryPath, 'utf8').replace(daemon.token, 'a'.repeat(64)));

        const result = await runClient(daemon.runtimeDir, JSON.stringify({ model: { id: 'm' }, cwd: '/tmp' }));

        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('ccstatusline-ipc');
    });

    it('fails with empty stdout when the discovery file names a dead socket', async () => {
        const { daemon } = await start();
        // stop() unlinks the socket and the discovery file but keeps the
        // runtime dir; recreate only the discovery pointing at the dead socket.
        await daemon.stop();
        fs.writeFileSync(daemon.discoveryPath, [
            'protocol=1',
            `socket=${daemon.socketPath}`,
            `token=${daemon.token}`
        ].join('\n') + '\n', { mode: 0o600 });

        const result = await runClient(daemon.runtimeDir, JSON.stringify({ model: { id: 'm' }, cwd: '/tmp' }));

        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
    });

    it('refuses a discovery file with an unsupported protocol version', async () => {
        const { daemon } = await start();
        fs.writeFileSync(daemon.discoveryPath, fs.readFileSync(daemon.discoveryPath, 'utf8').replace('protocol=1', 'protocol=99'));

        const result = await runClient(daemon.runtimeDir, JSON.stringify({ model: { id: 'm' }, cwd: '/tmp' }));

        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('protocol');
    });
});
