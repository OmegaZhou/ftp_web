import { createApp } from './server/app.ts';
const service = await createApp();
const port = Number(process.env.PORT ?? 9090);
const server = service.app.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(`FTP Web listening on ${process.env.HOST ?? '127.0.0.1'}:${port}`);
});
server.requestTimeout = 5 * 60 * 1000;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeIdleConnections();
  await closed;
  await service.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
