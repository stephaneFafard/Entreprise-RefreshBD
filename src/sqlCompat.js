const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');

// Adapte un dump de production (MySQL 8 ou MariaDB récente) pour l'import dans
// la MariaDB locale de XAMPP (10.4). Seules les lignes de structure sont
// modifiées : les lignes INSERT (les données) passent telles quelles.
const SKIPPED_LINE = new RegExp([
  /^SET @(@GLOBAL\.GTID_PURGED|@SESSION\.SQL_LOG_BIN|MYSQLDUMP_TEMP_LOG_BIN)/.source,
  // Ligne « sandbox mode » ajoutée par mariadb-dump >= 10.5.25 / 10.6.18, inconnue du client 10.4.
  /^\/\*M!999999\\- enable the sandbox mode \*\//.source,
].join('|'));

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// sourceSchema / targetSchema : les vues et triggers de production nomment parfois leurs
// tables avec le nom complet de la base (`clubinio_ClubIniouk`.`reservations`) ;
// on les redirige vers la base locale.
function createLineAdapter({ sourceSchema, targetSchema } = {}) {
  const schemaRef = sourceSchema && targetSchema && sourceSchema !== targetSchema
    ? new RegExp('`' + escapeRegExp(sourceSchema) + '`\\.', 'gi')
    : null;

  return (line) => {
    if (line.startsWith('INSERT INTO')) return line;
    if (SKIPPED_LINE.test(line)) return null;
    let out = line
      // Collations MySQL 8 inconnues de MariaDB.
      .replace(/utf8mb4_0900_\w+/g, 'utf8mb4_unicode_ci')
      // Commentaires exécutables propres à MySQL 8 (MariaDB 10.x les exécuterait).
      .replace(/\/\*!80\d{3}[\s\S]*?\*\//g, '')
      // L'utilisateur cPanel n'existe pas en local.
      .replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '');
    if (schemaRef) out = out.replace(schemaRef, '`' + targetSchema.replace(/\$/g, '$$$$') + '`.');
    return out;
  };
}

function createSqlCompatStream(options) {
  const adaptLine = createLineAdapter(options);
  // Le décodeur garde les octets d'un caractère accentué coupé entre deux morceaux.
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return new Transform({
    transform(chunk, encoding, callback) {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop();
      const out = lines.map(adaptLine).filter((l) => l !== null);
      callback(null, out.length ? out.join('\n') + '\n' : '');
    },
    flush(callback) {
      pending += decoder.end();
      const last = pending ? adaptLine(pending) : null;
      callback(null, last ?? '');
    },
  });
}

module.exports = { createSqlCompatStream };
