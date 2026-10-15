// Compiled migration entrypoint for the production image: `node dist/migrate-cli.js`.
// (scripts/migrate-cli.ts is the tsx/dev variant and is not part of the build.)
import { migrate } from './migrate.js';

try {
  await migrate();
  process.exit(0);
} catch (e) {
  console.error('[migrate] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}
