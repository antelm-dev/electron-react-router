# electron-react-router

Serve a [React Router](https://reactrouter.com) framework-mode app (SSR) from the
Electron main process through a custom scheme such as `app://`. No HTTP server:
documents go through React Router's request handler, static assets stream from the
client build, and in development requests can be proxied to a Vite dev server with HMR.

Sibling of [`electron-renderer-protocol`](https://github.com/antelm-dev/electron-renderer-protocol),
which it uses for path confinement and file streaming. Use that one for a plain SPA
bundle; use this one when the renderer is a React Router app with loaders and actions.

```ts
import { app, protocol } from 'electron';
import { createReactRouterProtocol } from 'electron-react-router';

const rr = createReactRouterProtocol({
  mode: app.isPackaged ? 'production' : 'development',
  clientDir: 'dist-app/client',
  serverBuildFile: 'dist-app/server/index.js',
  buildReadyFile: 'dist-app/.ready', // optional: touch it to reload the server build
  devServer: { port: 5173, configFile: 'vite.config.ts' },
});

protocol.registerSchemesAsPrivileged([rr.scheme.scheme]);

app.whenReady().then(() => {
  rr.scheme.registerHandler(rr.handler);
  new BrowserWindow().loadURL('app://host/');
});

app.on('before-quit', () => rr.close());
```

Loaders and actions receive `{ runtime: 'electron', protocol, url, dev }` as their
`context`.

Peer dependencies: `electron` 25+, `react-router` v7, and `vite` when using HMR.
