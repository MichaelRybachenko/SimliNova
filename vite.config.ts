import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import express from 'express';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [
      react(), 
      tailwindcss(),
      {
        name: 'bedrock-api-plugin',
        configureServer(server) {
          const app = express();
          app.use(express.json({ limit: '100mb' }));
          
          app.post('/api/bedrock-converse', async (req, res) => {
            try {
              const bedrockClient = new BedrockRuntimeClient({
                region: 'us-east-1',
                credentials: {
                  accessKeyId: env.VITE_AWS_ACCESS_KEY_ID || '',
                  secretAccessKey: env.VITE_AWS_SECRET_ACCESS_KEY || '',
                }
              });

              // Convert base64 back to Uint8Array for Bedrock SDK
              const { modelId, messages } = req.body;
              const parsedMessages = messages.map((msg: any) => {
                if (msg.content) {
                  msg.content = msg.content.map((block: any) => {
                    if (block.document?.source?.bytesBase64) {
                      block.document.source.bytes = Buffer.from(block.document.source.bytesBase64, 'base64');
                      delete block.document.source.bytesBase64;
                    }
                    if (block.image?.source?.bytesBase64) {
                      block.image.source.bytes = Buffer.from(block.image.source.bytesBase64, 'base64');
                      delete block.image.source.bytesBase64;
                    }
                    return block;
                  });
                }
                return msg;
              });

              const command = new ConverseCommand({
                modelId: modelId || "amazon.nova-lite-v1:0",
                messages: parsedMessages
              });
              
              const response = await bedrockClient.send(command);
              res.json(response);
            } catch (err: any) {
              console.error('Bedrock Proxy Error:', err);
              res.status(500).json({ error: err.message || String(err) });
            }
          });
          
          server.middlewares.use(app);
        }
      }
    ],
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
