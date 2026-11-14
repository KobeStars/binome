import { startServer } from './server.ts';

const port = Number(process.env.PORT ?? 8787);
const server = await startServer(port);
console.log(`signalisation sur le port ${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
