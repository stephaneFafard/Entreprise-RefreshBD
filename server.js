require('dotenv').config();
const path = require('path');
const express = require('express');
const { listDatabases } = require('./src/localDb');
const { readHistory } = require('./src/syncHistory');
const { startSync, getJob, getRunningJob } = require('./src/syncJob');
const { getProdDatabases } = require('./src/prodCatalog');
const { resolveProdName } = require('./src/prodDump');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Scan des bases locales + date de dernière synchronisation + base de production correspondante.
app.get('/api/databases', async (req, res) => {
  try {
    const history = readHistory();
    const [local, prod] = await Promise.all([
      listDatabases(),
      getProdDatabases({ refresh: req.query.refresh === '1' }).then(
        (list) => ({ list }),
        (err) => ({ error: err.message }),
      ),
    ]);
    const databases = local.map((name) => ({
      name,
      lastSync: history[name] || null,
      prodName: prod.list ? resolveProdName(name, prod.list) : null,
    }));
    res.json({ databases, prodError: prod.error || null, runningJobId: getRunningJob()?.id || null });
  } catch (err) {
    console.error('Erreur lors du scan des bases locales :', err);
    res.status(500).json({ error: `Impossible de lire les bases locales : ${err.message}` });
  }
});

// Lance la synchronisation des bases sélectionnées à partir de la production.
app.post('/api/sync', async (req, res) => {
  const databases = Array.isArray(req.body?.databases) ? req.body.databases : [];
  if (databases.length === 0) {
    return res.status(400).json({ error: 'Aucune base sélectionnée.' });
  }
  try {
    const job = await startSync(databases);
    res.status(202).json(job);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Progression d'une synchronisation.
app.get('/api/sync/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Synchronisation introuvable.' });
  res.json(job);
});

const port = Number(process.env.PORT || 3100);
app.listen(port, '127.0.0.1', () => {
  console.log(`Refresh Local BD : http://localhost:${port}`);
});
