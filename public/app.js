const rowsEl = document.getElementById('db-rows');
const selectAllEl = document.getElementById('select-all');
const syncBtn = document.getElementById('sync-btn');
const messageEl = document.getElementById('message');
let syncing = false;

const dateFormatter = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });

function showMessage(text, type = 'info') {
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.hidden = false;
}

function hideMessage() {
  messageEl.hidden = true;
}

// Cases des bases qui ont un équivalent en production (les autres restent désactivées).
function rowCheckboxes() {
  return [...rowsEl.querySelectorAll('input[type="checkbox"]:not(.unavailable)')];
}

function selectedDatabases() {
  return rowCheckboxes().filter((cb) => cb.checked).map((cb) => cb.value);
}

function updateSelectionState() {
  const boxes = rowCheckboxes();
  const checked = boxes.filter((cb) => cb.checked).length;
  selectAllEl.checked = boxes.length > 0 && checked === boxes.length;
  selectAllEl.indeterminate = checked > 0 && checked < boxes.length;
  syncBtn.disabled = syncing || checked === 0;
}

function renderDatabases(databases) {
  rowsEl.replaceChildren();
  if (databases.length === 0) {
    rowsEl.innerHTML = '<tr><td colspan="3" class="placeholder">Aucune base locale trouvée.</td></tr>';
    return;
  }

  for (const db of databases) {
    const tr = document.createElement('tr');

    const checkTd = document.createElement('td');
    checkTd.className = 'col-check';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = db.name;
    checkbox.setAttribute('aria-label', `Sélectionner ${db.name}`);
    checkbox.addEventListener('change', updateSelectionState);
    checkTd.append(checkbox);

    const nameTd = document.createElement('td');
    nameTd.textContent = db.name;
    const prodEl = document.createElement('div');
    prodEl.className = 'prod-name';
    if (db.prodName) {
      prodEl.textContent = `Production : ${db.prodName}`;
    } else {
      prodEl.textContent = 'Pas en production';
      checkbox.disabled = true;
      checkbox.classList.add('unavailable');
      tr.classList.add('unavailable');
    }
    nameTd.append(prodEl);

    const dateTd = document.createElement('td');
    if (db.lastSync) {
      dateTd.textContent = dateFormatter.format(new Date(db.lastSync));
    } else {
      dateTd.textContent = 'Jamais';
      dateTd.className = 'never';
    }

    tr.append(checkTd, nameTd, dateTd);
    rowsEl.append(tr);
  }
}

async function scanDatabases() {
  try {
    const res = await fetch('/api/databases');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Erreur HTTP ${res.status}`);
    renderDatabases(body.databases);
    if (body.prodError) showMessage(`Production injoignable : ${body.prodError}`, 'error');
    updateSelectionState();
    return body;
  } catch (err) {
    rowsEl.innerHTML = '<tr><td colspan="3" class="placeholder">Scan impossible.</td></tr>';
    showMessage(err.message, 'error');
    updateSelectionState();
    return null;
  }
}

// --- Synchronisation ----------------------------------------------------

const progressEl = document.getElementById('progress');
const progressListEl = document.getElementById('progress-list');

function stepLabel(item) {
  switch (item.step) {
    case 'pending': return 'En attente';
    case 'download': return `Téléchargement depuis la production… ${(item.bytes / 1048576).toFixed(1)} Mo`;
    case 'backup': return 'Sauvegarde de la base locale…';
    case 'import': return 'Import en local…';
    case 'done': return item.message ? `Terminé ✓ — ${item.message}` : 'Terminé ✓';
    case 'error': return `Erreur : ${item.message}`;
    default: return item.step;
  }
}

function renderProgress(job) {
  progressEl.hidden = false;
  progressListEl.replaceChildren(...job.items.map((item) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'db';
    name.textContent = item.prodName === item.name ? item.name : `${item.prodName} → ${item.name}`;
    const step = document.createElement('span');
    step.className = `step ${item.step}`;
    step.textContent = stepLabel(item);
    li.append(name, step);
    return li;
  }));
}

function setSyncing(value) {
  syncing = value;
  selectAllEl.disabled = value;
  for (const cb of rowCheckboxes()) cb.disabled = value;
  syncBtn.textContent = value ? 'Synchronisation en cours…' : 'Synchroniser';
  updateSelectionState();
}

async function followJob(jobId) {
  setSyncing(true);
  try {
    for (;;) {
      const res = await fetch(`/api/sync/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || `Erreur HTTP ${res.status}`);
      renderProgress(job);
      if (job.status !== 'running') {
        const failed = job.items.filter((i) => i.step === 'error').length;
        if (failed === 0) showMessage('Synchronisation terminée.', 'success');
        else showMessage(`${failed} base(s) en erreur — voir le détail ci-dessous.`, 'error');
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    showMessage(err.message, 'error');
  }
  syncing = false;
  await scanDatabases();
  setSyncing(false);
}

selectAllEl.addEventListener('change', () => {
  for (const cb of rowCheckboxes()) cb.checked = selectAllEl.checked;
  updateSelectionState();
});

syncBtn.addEventListener('click', async () => {
  const databases = selectedDatabases();
  if (databases.length === 0) return;

  const ok = confirm(
    `Les ${databases.length} base(s) locale(s) sélectionnée(s) seront remplacées par les données de production.\n` +
    'Une sauvegarde locale est faite avant. Continuer ?',
  );
  if (!ok) return;

  hideMessage();
  setSyncing(true);
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ databases }),
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job.error || `Erreur HTTP ${res.status}`);
    renderProgress(job);
    await followJob(job.id);
  } catch (err) {
    showMessage(err.message, 'error');
    setSyncing(false);
  }
});

// À l'ouverture : scan, et reprise du suivi si une synchronisation tourne déjà.
scanDatabases().then((body) => {
  if (body?.runningJobId) followJob(body.runningJobId);
});
