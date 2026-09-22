// NIENTE JWT qui - il Worker Treasury non ha (e non deve avere) GOOGLE_SA_KEY.
// L'accessToken arriva già pronto dal Centrale via header X-SA-Token
// (vedi Pattern_SA_Token_Relay.md). Ogni funzione qui sotto lo riceve come
// primo parametro, esplicito, mai letto da env.

export async function readSheetTab(accessToken, sheetId, tabName) {
  const range = encodeURIComponent(tabName);
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId +
    '/values/' + range + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error('Sheets API error ' + resp.status + ' on tab "' + tabName + '": ' + text);
  }
  const json = await resp.json();
  const rows = json.values || [];
  if (rows.length < 1) return [];

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
    return obj;
  });
}

// Upsert su Permission_list - stesso pattern di upsertPermissionListRow in
// seedtag-hrdashboard: mai append duplicato, mai delete fisico, sempre
// update-in-place per riga se l'email esiste già.
export async function upsertPermissionListRow(accessToken, sheetId, email, employee, role) {
  const rows = await readRawSheet(accessToken, sheetId, 'Permission_list').catch(() => []);
  const headers = (rows[0] || ['Email', 'Employee', 'Role']).map((h) => String(h || '').trim());
  const emailColIdx = headers.indexOf('Email');
  const emailCol = emailColIdx >= 0 ? emailColIdx : 0;

  let existingIdx = -1; // riga reale nello sheet, 1-indexed
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][emailCol] || '').toLowerCase().trim() === email.toLowerCase()) { existingIdx = i + 1; break; }
  }

  const newRow = [email, employee || '', role];
  if (existingIdx > 0) {
    const range = encodeURIComponent('Permission_list!A' + existingIdx + ':C' + existingIdx);
    const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + range + '?valueInputOption=RAW', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] })
    });
    if (!res.ok) throw new Error('upsertPermissionListRow PUT ' + res.status + ': ' + await res.text());
  } else {
    const range = encodeURIComponent('Permission_list!A:C');
    const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + range + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] })
    });
    if (!res.ok) throw new Error('upsertPermissionListRow append ' + res.status + ': ' + await res.text());
  }
}

// Variante "raw" (array di array, non oggetti) - serve internamente all'upsert
// per trovare l'indice di riga reale da aggiornare.
async function readRawSheet(accessToken, sheetId, tabName) {
  const range = encodeURIComponent(tabName);
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + range;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) throw new Error('Sheets API error ' + res.status);
  const data = await res.json();
  return data.values || [];
}
