import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { runTokenLifecycleSweep } from './modules/accounts/token-lifecycle.js';
import { runPublishingSweep } from './modules/content/publishing.js';
const server = app.listen(env.API_PORT, () => console.log(`GPA Social AI API listening on ${env.API_PORT}`));
// Refresh expiring OAuth tokens in the background. The database lease prevents duplicate
// refreshes when more than one API instance is running.
const publishSweep = setInterval(() => {
  void runPublishingSweep().catch((error) => console.error('Publishing sweep failed:', error));
}, 15_000);
publishSweep.unref();
void runPublishingSweep().catch((error) => console.error('Initial publishing sweep failed:', error));
const tokenSweep = setInterval(() => {
  void runTokenLifecycleSweep().catch((error) => console.error('Token lifecycle sweep failed:', error));
}, 60_000);
tokenSweep.unref();
void runTokenLifecycleSweep().catch((error) => console.error('Initial token lifecycle sweep failed:', error));
async function shutdown(signal: string) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(tokenSweep);
  clearInterval(publishSweep);
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
