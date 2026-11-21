import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ensureDefaultAdminAccount, seedDemoClusterIfEmpty } from './src/server/demoData';
import { BedcareCluster } from './src/server/p2pCluster';
import { createBedcareRouter } from './src/server/router';

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath === '/ws/p2p') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  });

  const dataDir = process.env.BEDCARE_DATA_DIR
    ? path.resolve(process.env.BEDCARE_DATA_DIR)
    : path.resolve(process.cwd(), 'data');

  const broadcastClusterSync = () => {
    const msg = JSON.stringify({ type: 'CLUSTER_EVENT_SYNC', timestamp: new Date().toISOString() });
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  };

  const cluster = new BedcareCluster({
    dataDir,
    onClusterUpdate: broadcastClusterSync,
  });
  seedDemoClusterIfEmpty(cluster);
  ensureDefaultAdminAccount(cluster);

  wss.on('connection', (ws) => {
    const extWs = ws as typeof ws & { isAlive?: boolean };
    extWs.isAlive = true;
    ws.on('pong', () => {
      extWs.isAlive = true;
    });
    ws.send(
      JSON.stringify({
        type: 'WS_CONNECTED',
        activeNodeId: cluster.activeNodeId,
        timestamp: new Date().toISOString(),
      })
    );
  });

  const keepAliveTimer = setInterval(() => {
    for (const client of wss.clients) {
      const extClient = client as typeof client & { isAlive?: boolean };
      if (extClient.isAlive === false) {
        client.terminate();
        continue;
      }
      extClient.isAlive = false;
      if (client.readyState === 1) {
        client.ping();
      }
    }
  }, 25000);
  server.on('close', () => clearInterval(keepAliveTimer));

  app.use(express.json({ limit: '25mb' }));
  app.use('/api', createBedcareRouter(cluster));

  // Serve generated deliverables for direct download if present
  app.use('/deliverables', express.static(path.resolve(process.cwd(), 'deliverables')));

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      plugins: [
        {
          name: 'bedcare-disable-vite-hmr-ws',
          enforce: 'post',
          transform(code, id) {
            const cleanId = id.split('?')[0];
            if (cleanId.endsWith('/dist/client/client.mjs') || cleanId.endsWith('/dist/client/bundledDevClient.mjs')) {
              return {
                code: code.replace(
                  'const createWebSocketModuleRunnerTransport = (options) => {',
                  'const createWebSocketModuleRunnerTransport = (_options) => { return { async connect() {}, disconnect() {}, send() {} };'
                ),
                map: null,
              };
            }
          },
        },
      ],
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`BEDCARE P2P Server đang chạy tại http://localhost:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Lỗi khởi động server BEDCARE:', err);
  process.exit(1);
});
