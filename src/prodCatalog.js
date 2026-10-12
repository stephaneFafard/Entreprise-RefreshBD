const { openSsh, listProdDatabases } = require('./prodDump');

// Liste des bases de production, gardée en mémoire quelques minutes
// pour ne pas ouvrir une connexion SSH à chaque affichage de la page.
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

async function getProdDatabases({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  const conn = await openSsh();
  try {
    const list = await listProdDatabases(conn);
    cache = { at: Date.now(), list };
    return list;
  } finally {
    conn.end();
  }
}

module.exports = { getProdDatabases };
