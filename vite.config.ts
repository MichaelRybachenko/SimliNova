import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      proxy: {
        '/api': {
          target: `http://localhost:${env.PORT || 3001}`,
          changeOrigin: true,
          secure: false,
        },
        '/nova-realtime': {
          target: 'wss://api.nova.amazon.com/v1/realtime',
          changeOrigin: true,
          ws: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/nova-realtime/, ''),
          configure: (proxy, _options) => {
            proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
              if (env.VITE_NOVA_API_KEY) {
                proxyReq.setHeader('Authorization', `Bearer ${env.VITE_NOVA_API_KEY}`);
              }
              proxyReq.setHeader('Origin', 'https://api.nova.amazon.com');
            });
          },
        },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor libraries
            'vendor-react': ['react', 'react-dom'],
            'vendor-simli': ['simli-client'],
          },
        },
      },
    },
  };
});
