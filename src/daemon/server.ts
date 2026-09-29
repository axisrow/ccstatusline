import * as fs from 'node:fs';
import * as http from 'node:http';

import { renderStatusLines } from '../render';
import type { RenderInvocation } from '../types/RenderContext';
import type { StatusJSON } from '../types/StatusJSON';
import { StatusJSONSchema } from '../types/StatusJSON';
import type { LoadedSettings } from '../utils/config';
import {
    getConfigPath,
    loadSettingsFrom
} from '../utils/config';
import {
    getPackageVersion,
    getTerminalWidth,
    resetTerminalWidthCache
} from '../utils/terminal';

import {
    ensureRuntimeDir,
    getDiscoveryPath,
    getRuntimeDir,
    getSocketPath,
    prepareSocketPath
} from './paths';
import type { InvocationContext } from './protocol';
import {
    AUTH_SCHEME,
    CONTEXT_HEADER,
    ENV_ALLOWLIST,
    MAX_BODY_BYTES,
    MAX_IN_FLIGHT_RENDERS,
    PROTOCOL_VERSION,
    decodeContext,
    makeToken,
    tokensMatch
} from './protocol';

// Private IPC transport for the shared background renderer (#16): Node's
// built-in http server over a per-user Unix socket. No TCP listener, no web
// framework. Requests are authenticated with a bearer token published only
// through the 0600 discovery file in the 0700 runtime directory, so another
// user can neither connect to the socket nor read the token.
//
// Renders are strictly serialized inside the process: the render path still
// reads process.env/process.cwd in a few places (claude-settings, terminal
// width, custom-command caches), so each request applies its invocation
// context there, one at a time, and restores it afterwards.

export interface DaemonDependencies {
    loadSettings: (configPath: string) => Promise<LoadedSettings>;
    resolveTerminalWidth: (sessionId: string | undefined, ttlSeconds: number) => number | null;
    buildInvocation: (context: InvocationContext, terminalWidth: number | null) => RenderInvocation;
}

export interface DaemonServerOptions {
    dependencies: DaemonDependencies;
    maxInFlightRenders?: number;
}

export interface DaemonCounters {
    requests: number;
    ok: number;
    [errorCode: string]: number;
}

export interface DaemonServerHandle {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    readonly socketPath: string;
    readonly discoveryPath: string;
    readonly runtimeDir: string;
    readonly token: string;
    readonly counters: DaemonCounters;
}

class BodyTooLargeError extends Error {
    constructor() {
        super('request body exceeds the size limit');
    }
}

/** Production dependencies: same request-scoped wiring as the --serve loop. */
export function createProcessDaemonDependencies(): DaemonDependencies {
    return {
        loadSettings: configPath => loadSettingsFrom(configPath),
        resolveTerminalWidth: (sessionId, ttlSeconds) => {
            // Same rationale as serve.ts: the width memo is process-global,
            // so reset before each probe or a resize would serve stale widths.
            resetTerminalWidthCache();
            return getTerminalWidth({ sessionId, ttlSeconds });
        },
        buildInvocation: (context, terminalWidth) => ({
            configPath: getConfigPath(),
            cwd: context.cwd ?? process.cwd(),
            // The context is applied to process.env for the duration of the
            // render, so this snapshot is exactly what render-path reads see.
            env: { ...process.env },
            terminalWidth
        })
    };
}

/**
 * Unset an environment variable. `delete process.env[name]` is the only
 * correct unset (assigning undefined would stringify); the Reflect form is
 * the same operation, kept here so the dynamic-delete lint rule holds.
 */
function unsetEnv(name: string): void {
    Reflect.deleteProperty(process.env, name);
}

/**
 * Swap the allowlisted env slice for the request snapshot: names present in
 * the snapshot are set, names absent from it are cleared — that is what
 * preserves absent-vs-empty across the IPC boundary. Only ever called inside
 * the serialized render section.
 */
function applyContextEnvironment(env: InvocationContext['env']): { name: string; value: string | undefined }[] {
    const saved: { name: string; value: string | undefined }[] = [];
    for (const name of ENV_ALLOWLIST) {
        saved.push({ name, value: process.env[name] });
        const next = env[name];
        if (next === undefined) {
            unsetEnv(name);
        } else {
            process.env[name] = next;
        }
    }
    return saved;
}

function restoreEnvironment(saved: { name: string; value: string | undefined }[]): void {
    for (const { name, value } of saved) {
        if (value === undefined) {
            unsetEnv(name);
        } else {
            process.env[name] = value;
        }
    }
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServerHandle {
    const { dependencies } = options;
    const maxInFlight = options.maxInFlightRenders ?? MAX_IN_FLIGHT_RENDERS;

    const runtimeDir = getRuntimeDir();
    const socketPath = getSocketPath(runtimeDir);
    const discoveryPath = getDiscoveryPath(runtimeDir);
    const token = makeToken();
    const startedAt = new Date();

    const counters: DaemonCounters = { requests: 0, ok: 0 };
    let lastRenderMs: number | null = null;

    // Strict serialization: one render runs at a time; inFlight counts
    // renders that are running or queued, and overflow answers 503.
    let inFlight = 0;
    let renderTail: Promise<unknown> = Promise.resolve();
    let savedCwd = process.cwd();

    function serializeRender<T>(render: () => Promise<T>): Promise<T> {
        const run = renderTail.then(render, render);
        // Keep the tail resolved regardless of outcome; `run` itself still
        // propagates errors to the requesting handler.
        renderTail = run.catch(() => undefined);
        return run;
    }

    function renderOne(data: StatusJSON, context: InvocationContext): Promise<string> {
        return serializeRender(async () => {
            const savedEnv = applyContextEnvironment(context.env);
            let chdirApplied = false;
            if (context.cwd !== null) {
                try {
                    process.chdir(context.cwd);
                    chdirApplied = true;
                } catch {
                    // cwd vanished between validation and render: proceed in
                    // the daemon cwd rather than failing the repaint.
                }
            }
            try {
                const loaded = await dependencies.loadSettings(getConfigPath());
                const terminalWidth = dependencies.resolveTerminalWidth(
                    data.session_id,
                    loaded.settings.terminalWidthCacheTtlSeconds
                );
                const invocation = dependencies.buildInvocation(context, terminalWidth);
                const { text } = await renderStatusLines(data, loaded, invocation);
                return text;
            } finally {
                restoreEnvironment(savedEnv);
                if (chdirApplied) {
                    try {
                        process.chdir(savedCwd);
                    } catch {
                        // The daemon's own cwd was removed; fall back to the
                        // runtime directory, which this process created.
                        process.chdir(runtimeDir);
                        savedCwd = runtimeDir;
                    }
                }
            }
        });
    }

    const server = http.createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
            console.error('ccstatusline daemon: request handler failed:', error instanceof Error ? error.message : error);
            if (!response.headersSent) {
                fail(response, 500, 'internal');
            } else {
                response.destroy();
            }
        });
    });
    // Malformed HTTP (e.g. a probe writing garbage at the socket) must not
    // get the default clientError reply, which writes to raw sockets.
    server.on('clientError', (_error, socket) => {
        socket.destroy();
    });

    function sendJson(response: http.ServerResponse, status: number, payload: object): void {
        const body = JSON.stringify(payload);
        response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body)
        });
        response.end(body);
    }

    function sendText(response: http.ServerResponse, status: number, text: string): void {
        response.writeHead(status, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': Buffer.byteLength(text)
        });
        response.end(text);
    }

    function bump(code: string): void {
        counters[code] = (counters[code] ?? 0) + 1;
    }

    function fail(response: http.ServerResponse, status: number, code: string, message?: string): void {
        bump(code);
        sendJson(response, status, message === undefined ? { error: { code } } : { error: { code, message } });
    }

    function isAuthorized(request: http.IncomingMessage): boolean {
        const header = request.headers.authorization;
        if (typeof header !== 'string') {
            return false;
        }
        const separator = header.indexOf(' ');
        if (separator === -1) {
            return false;
        }
        if (header.slice(0, separator).toLowerCase() !== AUTH_SCHEME) {
            return false;
        }
        return tokensMatch(token, header.slice(separator + 1).trim());
    }

    function requestPath(request: http.IncomingMessage): string {
        return (request.url ?? '').split('?')[0] ?? '';
    }

    async function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        counters.requests++;

        if (!isAuthorized(request)) {
            fail(response, 401, 'unauthorized');
            return;
        }

        const pathname = requestPath(request);
        if (pathname === '/v1/health') {
            if (request.method !== 'GET') {
                fail(response, 405, 'method_not_allowed');
                return;
            }
            bump('ok');
            sendJson(response, 200, {
                protocol: PROTOCOL_VERSION,
                version: getPackageVersion(),
                pid: process.pid,
                runtime: process.version,
                startedAt: startedAt.toISOString(),
                uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
                lastRenderMs,
                counters
            });
            return;
        }

        if (pathname === '/v1/render') {
            if (request.method !== 'POST') {
                fail(response, 405, 'method_not_allowed');
                return;
            }
            await handleRender(request, response);
            return;
        }

        fail(response, 404, 'not_found');
    }

    async function readBodyCapped(request: http.IncomingMessage): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            request.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    // Do not destroy the socket: the 413 reply must reach the
                    // client, which then stops uploading on its own.
                    reject(new BodyTooLargeError());
                    return;
                }
                chunks.push(chunk);
            });
            request.on('end', () => { resolve(Buffer.concat(chunks)); });
            request.on('error', () => { reject(new Error('request aborted')); });
        });
    }

    async function handleRender(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        let body: Buffer;
        try {
            body = await readBodyCapped(request);
        } catch (error) {
            if (error instanceof BodyTooLargeError) {
                fail(response, 413, 'too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`);
            } else {
                fail(response, 400, 'bad_request', 'request aborted');
            }
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(body.toString('utf8'));
        } catch (error) {
            fail(response, 400, 'bad_request', `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const statusResult = StatusJSONSchema.safeParse(parsed);
        if (!statusResult.success) {
            fail(response, 400, 'bad_request', 'invalid status JSON');
            return;
        }

        const context: InvocationContext = { env: {}, cwd: null };
        const header = request.headers[CONTEXT_HEADER];
        const contextValue = Array.isArray(header) ? header[0] : header;
        if (contextValue !== undefined) {
            const decoded = decodeContext(contextValue);
            if (!decoded.ok) {
                fail(response, 400, 'bad_context', decoded.error);
                return;
            }
            Object.assign(context, decoded.context);
        }
        if (context.cwd !== null) {
            // Boundary validation before any work: the render chdirs here.
            try {
                if (!fs.statSync(context.cwd).isDirectory()) {
                    throw new Error('not a directory');
                }
            } catch {
                fail(response, 400, 'bad_context', `context cwd does not exist: ${context.cwd}`);
                return;
            }
        }

        if (inFlight >= maxInFlight) {
            fail(response, 503, 'busy', 'render queue is full');
            return;
        }
        inFlight++;
        try {
            const startedAtRender = Date.now();
            const text = await renderOne(statusResult.data, context);
            lastRenderMs = Date.now() - startedAtRender;
            bump('ok');
            sendText(response, 200, text);
        } catch (error) {
            fail(response, 500, 'render_failed', error instanceof Error ? error.message : String(error));
        } finally {
            inFlight--;
        }
    }

    function writeDiscoveryFile(): void {
        const lines = [
            '# ccstatusline daemon discovery v1 — one KEY=VALUE per line, safe to parse with a POSIX shell',
            `protocol=${PROTOCOL_VERSION}`,
            `version=${getPackageVersion()}`,
            `pid=${process.pid}`,
            `socket=${socketPath}`,
            `token=${token}`,
            `started=${startedAt.toISOString()}`
        ];
        const tempPath = `${discoveryPath}.${process.pid}.tmp`;
        fs.writeFileSync(tempPath, `${lines.join('\n')}\n`, { mode: 0o600 });
        fs.renameSync(tempPath, discoveryPath);
    }

    return {
        socketPath,
        discoveryPath,
        runtimeDir,
        token,
        counters,
        async start(): Promise<void> {
            ensureRuntimeDir(runtimeDir);
            prepareSocketPath(socketPath);
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error) => {
                    server.removeListener('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen({ path: socketPath });
            });
            // listen() honors the umask; pin the socket so only this user connects.
            fs.chmodSync(socketPath, 0o600);
            writeDiscoveryFile();
        },
        async stop(): Promise<void> {
            await new Promise<void>((resolve) => {
                server.closeIdleConnections();
                server.close(() => { resolve(); });
            });
            for (const stalePath of [socketPath, discoveryPath, `${discoveryPath}.${process.pid}.tmp`]) {
                try {
                    fs.unlinkSync(stalePath);
                } catch {
                    // Already gone.
                }
            }
        }
    };
}

/**
 * Daemon host entry (`ccstatusline daemon`, #16): starts the transport and
 * blocks until SIGINT/SIGTERM. Lifecycle (auto-start, respawn) is the
 * sibling issue's scope; this is the foreground server. The bearer token is
 * never logged — it is shared only through the discovery file.
 */
export async function runDaemonServer(): Promise<void> {
    if (process.platform === 'win32') {
        console.error('ccstatusline daemon: not supported on Windows (Unix socket transport)');
        process.exit(1);
    }

    const daemon = createDaemonServer({ dependencies: createProcessDaemonDependencies() });
    try {
        await daemon.start();
    } catch (error) {
        console.error(`ccstatusline daemon failed to start: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    console.error(`ccstatusline daemon listening on ${daemon.socketPath} (pid ${process.pid})`);

    let stopping = false;
    const shutdown = (signal: string) => {
        if (stopping) {
            return;
        }
        stopping = true;
        console.error(`ccstatusline daemon: received ${signal}, shutting down`);
        void daemon.stop().then(() => process.exit(0));
    };
    process.on('SIGINT', () => { shutdown('SIGINT'); });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
}
