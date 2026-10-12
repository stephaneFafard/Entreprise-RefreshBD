const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { Client } = require('ssh2');

// Ouvre une connexion SSH vers le serveur cPanel (clé privée ou mot de passe).
function openSsh() {
  const config = {
    host: process.env.SSH_HOST,
    port: Number(process.env.SSH_PORT || 22),
    username: process.env.SSH_USER,
    readyTimeout: 30000,
    keepaliveInterval: 15000,
  };
  if (!config.host || !config.username) {
    throw new Error('SSH_HOST et SSH_USER doivent être renseignés dans .env.');
  }

  if (process.env.SSH_KEY_PATH) {
    config.privateKey = fs.readFileSync(process.env.SSH_KEY_PATH);
    if (process.env.SSH_KEY_PASSPHRASE) config.passphrase = process.env.SSH_KEY_PASSPHRASE;
  } else if (process.env.SSH_PASSWORD) {
    config.password = process.env.SSH_PASSWORD;
  } else {
    throw new Error('Renseigner SSH_KEY_PATH ou SSH_PASSWORD dans .env.');
  }

  // Empreinte attendue du serveur (format SHA256:xxxx) : protège contre l'usurpation d'hôte.
  const expected = process.env.SSH_HOST_FINGERPRINT;
  config.hostVerifier = (key) => {
    const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
    if (!expected) {
      console.warn(`Empreinte SSH du serveur : ${fingerprint} (ajouter SSH_HOST_FINGERPRINT dans .env pour la vérifier)`);
      return true;
    }
    return fingerprint === expected;
  };

  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(new Error(`Connexion SSH impossible : ${err.message}`)));
    conn.connect(config);
  });
}

// Fichier d'options MySQL envoyé par stdin : le mot de passe n'apparaît jamais en argument.
function mysqlCredentials() {
  const user = process.env.PROD_DB_USER || process.env.SSH_USER;
  const password = process.env.PROD_DB_PASSWORD || process.env.SSH_PASSWORD || '';
  return `[client]\nuser="${user}"\npassword="${password.replace(/"/g, '\\"')}"\n`;
}

// Exécute une requête SQL (sans guillemets doubles) en production ; renvoie les lignes de résultat.
function prodQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.exec(`mysql --defaults-extra-file=/dev/stdin -N -e "${sql}"`, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let stderr = '';
      stream.on('data', (chunk) => { out += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      stream.on('close', (code) => {
        if (code !== 0) return reject(new Error(`MySQL de production : ${stderr.trim() || `code ${code}`}`));
        resolve(out.split('\n').map((l) => l.trim()).filter(Boolean));
      });
      stream.end(mysqlCredentials());
    });
  });
}

// Liste des bases de production visibles par l'utilisateur MySQL.
async function listProdDatabases(conn) {
  return (await prodQuery(conn, 'SHOW DATABASES')).filter((name) => name !== 'information_schema');
}

// Vrai si la base contient des procédures/fonctions dont l'utilisateur cPanel ne peut pas
// lire le code (créées par root ou un autre utilisateur) : mysqldump --routines échouerait.
async function hasUnreadableRoutines(conn, prodDb) {
  const rows = await prodQuery(conn,
    `SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '${prodDb}' AND ROUTINE_DEFINITION IS NULL`);
  return Number(rows[0]) > 0;
}

// Correspondances explicites PROD_DB_MAP=local:prod,local2:prod2 (clés en minuscules).
function explicitMap() {
  const map = new Map();
  for (const pair of (process.env.PROD_DB_MAP || '').split(',')) {
    const [local, prod] = pair.split(':').map((s) => s?.trim());
    if (local && prod) map.set(local.toLowerCase(), prod);
  }
  return map;
}

// Nom réel de la base de production pour une base locale, ou null si elle n'existe pas.
// La MariaDB locale (Windows) met les noms en minuscules : la comparaison ignore la casse.
function resolveProdName(localName, prodDatabases) {
  const prefix = process.env.PROD_DB_PREFIX || '';
  const wanted = explicitMap().get(localName.toLowerCase())
    || (prefix && !localName.toLowerCase().startsWith(prefix.toLowerCase()) ? prefix + localName : localName);
  return prodDatabases.find((p) => p === wanted)
    || prodDatabases.find((p) => p.toLowerCase() === wanted.toLowerCase())
    || null;
}

// Lance mysqldump sur le serveur et enregistre le dump compressé dans destFile.
// Le mot de passe MySQL est envoyé par stdin (option file), jamais en argument.
function downloadDump(conn, prodDb, destFile, onProgress, { routines = true } = {}) {
  const command = [
    'mysqldump --defaults-extra-file=/dev/stdin',
    '--single-transaction --quick --no-tablespaces --triggers',
    routines ? '--routines' : '--skip-routines',
    '--default-character-set=utf8mb4',
    `'${prodDb}'`,
    '| gzip -c',
  ].join(' ');

  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);

      const file = fs.createWriteStream(destFile);
      const gunzip = zlib.createGunzip();
      let bytes = 0;
      let tail = '';
      let stderr = '';

      stream.on('data', (chunk) => {
        bytes += chunk.length;
        onProgress(bytes);
      });
      stream.pipe(file);
      stream.pipe(gunzip);
      // On garde la fin du dump pour vérifier qu'il est complet.
      gunzip.on('data', (chunk) => { tail = (tail + chunk.toString('utf8')).slice(-500); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

      let exitCode = null;
      stream.on('exit', (code) => { exitCode = code; });

      const fileDone = new Promise((res, rej) => { file.on('finish', res); file.on('error', rej); });
      const gunzipDone = new Promise((res) => { gunzip.on('end', res); gunzip.on('error', res); });
      Promise.all([fileDone, gunzipDone]).then(() => {
        if (!tail.includes('-- Dump completed')) {
          const detail = stderr.trim() || `code de sortie ${exitCode}`;
          return reject(new Error(`Dump de production incomplet (${prodDb}) : ${detail}`));
        }
        resolve(bytes);
      }, reject);

      stream.end(mysqlCredentials());
    });
  });
}

module.exports = { openSsh, listProdDatabases, hasUnreadableRoutines, resolveProdName, downloadDump };
