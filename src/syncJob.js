const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listDatabases, recreateDatabase, backupDatabase, dumpRoutines, importDump } = require('./localDb');
const { openSsh, hasUnreadableRoutines, resolveProdName, downloadDump } = require('./prodDump');
const { getProdDatabases } = require('./prodCatalog');
const { recordSync } = require('./syncHistory');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const jobs = new Map();
let runningJob = null;

function getJob(id) {
  return jobs.get(id) || null;
}

function getRunningJob() {
  return runningJob;
}

// Démarre la synchronisation en arrière-plan ; l'interface suit la progression via getJob().
async function startSync(names) {
  if (runningJob) throw Object.assign(new Error('Une synchronisation est déjà en cours.'), { status: 409 });

  const local = new Set(await listDatabases());
  const unknown = names.filter((n) => !local.has(n));
  if (unknown.length) {
    throw Object.assign(new Error(`Base(s) locale(s) inconnue(s) : ${unknown.join(', ')}`), { status: 400 });
  }

  // Liste fraîche : on ne lance rien vers une base de production qui n'existe plus.
  const prodDatabases = await getProdDatabases({ refresh: true });
  const missing = names.filter((n) => !resolveProdName(n, prodDatabases));
  if (missing.length) {
    throw Object.assign(new Error(`Pas d'équivalent en production pour : ${missing.join(', ')}`), { status: 400 });
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    items: names.map((name) => ({
      name,
      prodName: resolveProdName(name, prodDatabases),
      step: 'pending',
      bytes: 0,
      message: '',
    })),
  };
  jobs.set(job.id, job);
  runningJob = job;

  runJob(job).finally(() => {
    job.finishedAt = new Date().toISOString();
    job.status = job.items.every((i) => i.step === 'done') ? 'done' : 'error';
    runningJob = null;
  });
  return job;
}

async function runJob(job) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  let conn;
  try {
    conn = await openSsh();
  } catch (err) {
    for (const item of job.items) Object.assign(item, { step: 'error', message: err.message });
    return;
  }

  try {
    for (const item of job.items) {
      try {
        await syncOne(conn, item);
      } catch (err) {
        console.error(`Synchronisation de ${item.name} :`, err);
        item.step = 'error';
        item.message = item.message ? `${err.message} — ${item.message}` : err.message;
      }
    }
  } finally {
    conn.end();
  }
}

async function syncOne(conn, item) {
  if (!/^[A-Za-z0-9_$-]+$/.test(item.prodName)) {
    throw new Error(`Nom de base de production invalide : ${item.prodName}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prodFile = path.join(TMP_DIR, `${item.name}.sql.gz`);
  const routinesFile = path.join(TMP_DIR, `${item.name}.routines.sql.gz`);
  const backupFile = path.join(BACKUP_DIR, `${item.name}_${stamp}.sql.gz`);

  try {
    // 1. Téléchargement complet AVANT de toucher la base locale.
    //    Les procédures/fonctions illisibles par l'utilisateur cPanel sont reprises de la base locale.
    item.step = 'download';
    const keepLocalRoutines = await hasUnreadableRoutines(conn, item.prodName);
    await downloadDump(conn, item.prodName, prodFile, (bytes) => { item.bytes = bytes; },
      { routines: !keepLocalRoutines });

    // 2. Sauvegarde de la base locale actuelle.
    item.step = 'backup';
    await backupDatabase(item.name, backupFile);
    if (keepLocalRoutines) await dumpRoutines(item.name, routinesFile);

    // 3. Remplacement par les données de production.
    item.step = 'import';
    try {
      await recreateDatabase(item.name);
      await importDump(item.name, prodFile, { sourceSchema: item.prodName });
      if (keepLocalRoutines) await importDump(item.name, routinesFile);
    } catch (err) {
      item.message = await restore(item.name, backupFile);
      throw err;
    }

    recordSync(item.name);
    item.step = 'done';
    if (keepLocalRoutines) {
      item.message = 'procédures et fonctions conservées de la base locale (illisibles en production)';
    }
    pruneBackups(item.name);
  } finally {
    fs.rmSync(prodFile, { force: true });
    fs.rmSync(routinesFile, { force: true });
  }
}

// En cas d'échec de l'import, on remet la base locale telle qu'elle était.
async function restore(name, backupFile) {
  try {
    await recreateDatabase(name);
    await importDump(name, backupFile);
    return 'base locale restaurée à son état précédent';
  } catch (err) {
    return `restauration impossible (${err.message}) — sauvegarde : ${backupFile}`;
  }
}

// Conserve seulement les N dernières sauvegardes de chaque base.
function pruneBackups(name) {
  const keep = Number(process.env.BACKUP_KEEP || 3);
  const prefix = `${name}_`;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.sql\.gz$/.test(f.slice(prefix.length)))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
}

module.exports = { startSync, getJob, getRunningJob };
