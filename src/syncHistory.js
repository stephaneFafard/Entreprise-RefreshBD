const fs = require('fs');
const path = require('path');

// Historique des synchronisations : { "<nom_bd>": "<date ISO>" }
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'sync-history.json');

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function recordSync(database, date = new Date()) {
  const history = readHistory();
  history[database] = date.toISOString();
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

module.exports = { readHistory, recordSync };
