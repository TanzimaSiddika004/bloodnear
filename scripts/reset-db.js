const fs = require('node:fs');
const path = require('node:path');
const db = path.join(__dirname, '..', 'data', 'bloodnear.sqlite');
for (const file of [db, `${db}-shm`, `${db}-wal`]) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
console.log('Database reset. Run npm start to recreate and seed it.');
