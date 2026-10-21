import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // inline so vi.mock('electron') also applies inside electron-renderer-protocol
    server: { deps: { inline: ['electron-renderer-protocol'] } },
  },
});
