import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { resolveRendererPath } from 'electron-renderer-protocol';
import {
  createRequestHandler,
  type ServerBuild,
  type AppLoadContext,
} from 'react-router';
import type { ViteDevServer } from 'vite';

export type DevServerOptions =
  | false
  | {
      /**
       * Serve the renderer through a Vite dev server behind the custom protocol.
       * Defaults to true in development, false keeps the build/watch + reload flow.
       */
      hmr?: boolean;
      host?: string;
      port?: number;
      strictPort?: boolean;
      /** Dedicated Vite config file for the renderer. */
      configFile?: string | false;
    };

export type ReactRouterProtocolOptions = {
  /** Custom scheme to register, `app` by default. */
  scheme?: string;
  /** Directory holding the React Router client build. */
  clientDir: string;
  /** Path to the React Router server build entry. */
  serverBuildFile: string;
  /** File rewritten after each build, used to reload the server build. */
  buildReadyFile?: string;
  mode: 'development' | 'production';
  /** Development only. `undefined` enables HMR through Vite, `false` serves the build. */
  devServer?: DevServerOptions;
};

/** Load context handed to React Router loaders and actions. */
export type ElectronLoadContext = {
  runtime: 'electron';
  protocol: string;
  url: string;
  dev: boolean;
};

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'font/otf',
};

const viteModuleExtensions = new Set([
  '.js',
  '.mjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.wasm',
]);

export function createCustomScheme(
  name: string,
  privileges: Electron.Privileges = {},
) {
  return {
    scheme: { scheme: name, privileges } as Electron.CustomScheme,
    unregisterHandler: () => protocol.unhandle(name),
    registerHandler: (handler: Parameters<typeof protocol.handle>[1]) =>
      protocol.handle(name, handler),
  };
}

async function isFile(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Streams a file from the client build through Chromium's own `file:` loader,
 * the same way electron-renderer-protocol does, so ranges and lengths come from
 * the platform.
 */
async function assetResponse(
  request: Request,
  clientDir: string,
  mode: ReactRouterProtocolOptions['mode'],
) {
  const result = resolveRendererPath(clientDir, new URL(request.url).pathname);

  if (!result.ok) {
    return new Response(result.status === 400 ? 'Bad request' : 'Forbidden', {
      status: result.status,
    });
  }

  if (!(await isFile(result.file))) {
    return new Response('Asset not found', { status: 404 });
  }

  const response = await net.fetch(pathToFileURL(result.file).href, {
    headers: request.headers,
  });
  const headers = new Headers(response.headers);
  const isImmutableAsset = result.file.includes(`${path.sep}assets${path.sep}`);

  headers.set(
    'content-type',
    MIME_TYPES[path.extname(result.file).toLowerCase()] ??
      'application/octet-stream',
  );
  headers.set(
    'cache-control',
    mode === 'production' && isImmutableAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  );

  return new Response(response.body, { status: response.status, headers });
}

function shouldUseViteDevServer(options: ReactRouterProtocolOptions) {
  if (options.mode !== 'development') return false;
  if (options.devServer === false) return false;
  return options.devServer?.hmr ?? true;
}

function getDevServerOptions(options: ReactRouterProtocolOptions) {
  const devServer = options.devServer ? options.devServer : {};

  return {
    host: devServer.host ?? '127.0.0.1',
    port: devServer.port ?? 5173,
    strictPort: devServer.strictPort ?? true,
    configFile: devServer.configFile,
  };
}

function isViteInternalRequest(pathname: string) {
  return (
    pathname === '/@vite/client' ||
    pathname === '/@react-refresh' ||
    pathname.startsWith('/@id/') ||
    pathname.startsWith('/@fs/') ||
    pathname.startsWith('/@vite/') ||
    pathname.startsWith('/node_modules/.vite/')
  );
}

function isProbablyViteModuleRequest(url: URL) {
  const ext = path.extname(url.pathname).toLowerCase();

  return (
    isViteInternalRequest(url.pathname) ||
    url.searchParams.has('import') ||
    url.searchParams.has('direct') ||
    url.searchParams.has('raw') ||
    url.searchParams.has('url') ||
    viteModuleExtensions.has(ext)
  );
}

/**
 * Serves a React Router (framework mode, SSR) app from the Electron main process
 * through a custom scheme such as `app://`. No HTTP server is involved: documents
 * go through React Router's request handler, static assets are streamed from the
 * client build, and in development everything can be proxied to a Vite dev server
 * with HMR.
 */
export function createReactRouterProtocol(options: ReactRouterProtocolOptions) {
  const {
    clientDir,
    serverBuildFile,
    buildReadyFile,
    mode,
    scheme = 'app',
  } = options;

  const useViteDevServer = shouldUseViteDevServer(options);
  const devServerOptions = getDevServerOptions(options);
  const viteOrigin = `http://${devServerOptions.host}:${devServerOptions.port}`;

  const customScheme = createCustomScheme(scheme, {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  });

  let vitePromise: Promise<ViteDevServer> | undefined;

  async function getVite() {
    if (!vitePromise) {
      vitePromise = import('vite').then(async ({ createServer }) => {
        const vite = await createServer({
          configFile: devServerOptions.configFile,
          appType: 'custom',
          server: {
            host: devServerOptions.host,
            port: devServerOptions.port,
            strictPort: devServerOptions.strictPort,
            hmr: {
              protocol: 'ws',
              host: devServerOptions.host,
              port: devServerOptions.port,
              clientPort: devServerOptions.port,
            },
          },
        });

        await vite.listen();

        return vite;
      });
    }

    return vitePromise;
  }

  let cachedBuild: ServerBuild | undefined;
  let cachedBuildId: string | undefined;

  async function getFileBuild(): Promise<ServerBuild> {
    const buildId = buildReadyFile
      ? await readFile(buildReadyFile, 'utf8').catch(() => 'initial')
      : 'production';

    if (cachedBuild && cachedBuildId === buildId) {
      return cachedBuild;
    }

    const url = pathToFileURL(serverBuildFile);
    url.searchParams.set('t', buildId.trim());

    cachedBuild = (await import(url.href)) as ServerBuild;
    cachedBuildId = buildId;

    return cachedBuild;
  }

  async function getBuild(): Promise<ServerBuild> {
    if (useViteDevServer) {
      const vite = await getVite();

      return vite.ssrLoadModule(
        'virtual:react-router/server-build',
      ) as Promise<ServerBuild>;
    }

    return getFileBuild();
  }

  const requestHandler = createRequestHandler(getBuild, mode);

  const handler = async (request: Request) => {
    const url = new URL(request.url);

    // In HMR mode Vite answers modules, CSS, imported assets, /@vite/client, /@fs, /@id…
    if (useViteDevServer && isProbablyViteModuleRequest(url)) {
      await getVite();

      return net.fetch(`${viteOrigin}${url.pathname}${url.search}`);
    }

    const ext = path.extname(url.pathname).toLowerCase();
    const isAssetRequest =
      url.pathname.startsWith('/assets/') || ext in MIME_TYPES;

    if (!useViteDevServer && isAssetRequest) {
      return assetResponse(request, clientDir, mode);
    }

    const loadContext = {
      runtime: 'electron',
      protocol: scheme,
      url: request.url,
      dev: useViteDevServer,
    } satisfies ElectronLoadContext as AppLoadContext;

    try {
      // SSR HTML is served as-is, like React Router's own dev server: running it through
      // vite.transformIndexHtml breaks the inline virtual:react-router/inject-hmr-runtime import
      return await requestHandler(request, loadContext);
    } catch (error) {
      if (useViteDevServer) {
        (await getVite()).ssrFixStacktrace(error as Error);
      }

      console.error(error);

      return new Response('Internal SSR error', {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  };

  const close = async () => {
    const vite = await vitePromise;
    await vite?.close();
  };

  return {
    scheme: customScheme,
    handler,
    close,
  };
}
