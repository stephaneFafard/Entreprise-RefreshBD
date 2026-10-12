const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const mysql = require('mysql2/promise');
const { createSqlCompatStream } = require('./sqlCompat');

// Bases système de MariaDB qu'on ne synchronise jamais.
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function connect() {
  return mysql.createConnection({
    host: process.env.LOCAL_DB_HOST || '127.0.0.1',
    port: Number(process.env.LOCAL_DB_PORT || 3306),
    user: process.env.LOCAL_DB_USER || 'root',
    password: process.env.LOCAL_DB_PASSWORD || '',
  });
}

async function listDatabases() {
  const conn = await connect();
  try {
    const [rows] = await conn.query('SHOW DATABASES');
    return rows
      .map((row) => row.Database)
      .filter((name) => !SYSTEM_DATABASES.has(name.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
  } finally {
    await conn.end();
  }
}

// Supprime puis recrée la base vide, en conservant son jeu de caractères.
async function recreateDatabase(name) {
  const conn = await connect();
  try {
    const [rows] = await conn.query(
      'SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [name],
    );
    const charset = rows[0]?.charset || 'utf8mb4';
    const collation = rows[0]?.collation || 'utf8mb4_unicode_ci';
    const id = conn.escapeId(name);
    await conn.query(`DROP DATABASE IF EXISTS ${id}`);
    await conn.query(`CREATE DATABASE ${id} CHARACTER SET ${charset} COLLATE ${collation}`);
  } finally {
    await conn.end();
  }
}

// --- Outils en ligne de commande de MariaDB (XAMPP) ----------------------

function cliPath(tool) {
  return path.join(process.env.LOCAL_MYSQL_BIN || 'C:\\xampp\\mysql\\bin', `${tool}.exe`);
}

function runCli(tool, args) {
  const child = spawn(cliPath(tool), [
    `--host=${process.env.LOCAL_DB_HOST || '127.0.0.1'}`,
    `--port=${process.env.LOCAL_DB_PORT || 3306}`,
    `--user=${process.env.LOCAL_DB_USER || 'root'}`,
    '--default-character-set=utf8mb4',
    ...args,
  ], {
    // Mot de passe par variable d'environnement : il n'apparaît pas dans la ligne de commande.
    env: { ...process.env, MYSQL_PWD: process.env.LOCAL_DB_PASSWORD || '' },
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${tool} a échoué (code ${code}) : ${stderr.trim()}`));
    });
  });
  return { child, done };
}

// Attend le flux et l'outil ; si l'outil échoue, c'est son message qu'on remonte
// (une erreur de flux comme « write EOF » n'en est que la conséquence).
async function waitBoth(streaming, done) {
  const [streamResult, cliResult] = await Promise.allSettled([streaming, done]);
  if (cliResult.status === 'rejected') throw cliResult.reason;
  if (streamResult.status === 'rejected') throw streamResult.reason;
}

// Sauvegarde compressée de la base locale avant écrasement.
async function backupDatabase(name, destFile) {
  const { child, done } = runCli('mysqldump', [
    '--single-transaction', '--quick', '--routines', '--triggers', name,
  ]);
  await waitBoth(pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(destFile)), done);
}

// Procédures et fonctions seules de la base locale (pour les remettre après l'import).
async function dumpRoutines(name, destFile) {
  const { child, done } = runCli('mysqldump', [
    '--routines', '--no-data', '--no-create-info', '--no-create-db', '--skip-triggers', name,
  ]);
  await waitBoth(pipeline(child.stdout, zlib.createGzip(), fs.createWriteStream(destFile)), done);
}

// Importe un dump .sql.gz dans la base (qui doit déjà exister).
// sourceSchema : nom de la base d'origine du dump, réécrit en `name` dans les vues/triggers.
async function importDump(name, gzFile, { sourceSchema } = {}) {
  const { child, done } = runCli('mysql', [name]);
  await waitBoth(
    pipeline(
      fs.createReadStream(gzFile), zlib.createGunzip(),
      createSqlCompatStream({ sourceSchema, targetSchema: name }), child.stdin,
    ),
    done,
  );
}

module.exports = { listDatabases, recreateDatabase, backupDatabase, dumpRoutines, importDump };
