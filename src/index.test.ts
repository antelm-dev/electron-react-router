import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  createRequestHandler: vi.fn(),
  handleRequest: vi.fn(),
  netFetch: vi.fn(),
  protocolHandle: vi.fn(),
  protocolUnhandle: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: state.netFetch },
  protocol: { handle: state.protocolHandle, unhandle: state.protocolUnhandle },
}));

vi.mock('react-router', () => ({
  createRequestHandler: state.createRequestHandler,
}));

import { createReactRouterProtocol } from './index.js';

let clientDir: string;

beforeAll(async () => {
  clientDir = await mkdtemp(path.join(tmpdir(), 'rr-protocol-'));
  await mkdir(path.join(clientDir, 'assets'));
  await writeFile(path.join(clientDir, 'assets', 'app.js'), 'console.log(1)');
});

beforeEach(() => {
  vi.clearAllMocks();
  state.createRequestHandler.mockReturnValue(state.handleRequest);
  state.handleRequest.mockResolvedValue(new Response('document'));
  state.netFetch.mockResolvedValue(new Response('console.log(1)'));
});

function production() {
  return createReactRouterProtocol({
    mode: 'production',
    clientDir,
    serverBuildFile: path.join(clientDir, 'server.js'),
  });
}

describe('createReactRouterProtocol', () => {
  it('registers a privileged custom scheme', () => {
    const { scheme } = production();

    expect(scheme.scheme).toEqual({
      scheme: 'app',
      privileges: expect.objectContaining({ standard: true, secure: true }),
    });

    scheme.registerHandler(() => new Response());
    expect(state.protocolHandle).toHaveBeenCalledWith('app', expect.any(Function));

    scheme.unregisterHandler();
    expect(state.protocolUnhandle).toHaveBeenCalledWith('app');
  });

  it('streams immutable assets from the client build through the file loader', async () => {
    const response = await production().handler(
      new Request('app://host/assets/app.js'),
    );

    expect(state.netFetch).toHaveBeenCalledWith(
      pathToFileURL(path.join(clientDir, 'assets', 'app.js')).href,
      expect.anything(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    await expect(response.text()).resolves.toBe('console.log(1)');
    expect(state.handleRequest).not.toHaveBeenCalled();
  });

  it('rejects missing and escaping asset paths', async () => {
    const { handler } = production();

    const missing = await handler(new Request('app://host/assets/nope.js'));
    expect(missing.status).toBe(404);

    // encoded separators are refused by electron-renderer-protocol before touching the disk
    const escaping = await handler(
      new Request('app://host/assets/%2e%2e%2f%2e%2e%2fetc/passwd.txt'),
    );
    expect(escaping.status).toBe(400);
    expect(state.netFetch).not.toHaveBeenCalled();
  });

  it('hands document requests to React Router with the electron load context', async () => {
    const request = new Request('app://host/settings?tab=theme');

    const response = await production().handler(request);

    expect(state.handleRequest).toHaveBeenCalledWith(request, {
      runtime: 'electron',
      protocol: 'app',
      url: 'app://host/settings?tab=theme',
      dev: false,
    });
    await expect(response.text()).resolves.toBe('document');
  });

  it('proxies Vite module requests to the dev server in development', async () => {
    state.netFetch.mockResolvedValue(new Response('module'));
    vi.doMock('vite', () => ({
      createServer: vi.fn(async () => ({ listen: vi.fn(), close: vi.fn() })),
    }));

    const { handler, close } = createReactRouterProtocol({
      mode: 'development',
      clientDir,
      serverBuildFile: 'unused',
      devServer: { port: 4321 },
    });

    await handler(new Request('app://host/@vite/client'));

    expect(state.netFetch).toHaveBeenCalledWith('http://127.0.0.1:4321/@vite/client');
    await close();
  });
});
