// Usage: node dist/backup.js <output-file>
// Writes a consistent copy of the live database (safe while the server runs).
import { config } from './config.js';
import { Db } from './db.js';

const out = process.argv[2];
if (!out) {
  console.error('Usage: backup <output-file>');
  process.exit(1);
}
const db = new Db(config.databasePath);
db.backupTo(out);
db.close();
console.log(`Backed up ${config.databasePath} to ${out}`);
