// Ported from BankFieldsCheck.gs - same logic, same data, now living in the Worker.

export const SUBCOMPANY_COUNTRY = {
  'Seedtag Advertising Chile SPA': 'Chile',
  'Seedtag Advertising Colombia SAS': 'Colombia',
  'Seedtag Advertising Argentina SRL': 'Argentina',
  'Seedtag Publicidade Ltda. Brazil': 'Brasil',
  'Seedtag Advertising Perú S.A.C.': 'Peru',
  'Seedtag Advertising SL SA de CV Mexico': 'Mexico',
  'Seedtag Advertising Canada LTD': 'Canada',
  'Just Eggs Pty Limited': 'Australia',
  'Seedtag Advertising SL UAE': 'Dubai',
  'Seedtag Advertising SL UK': 'UK',
  'Seedtag Advertising US LLC': 'US',
  'Seedtag Advertising SL Spain': 'España',
  'Seedtag Advertising SL Italy': 'Italia',
  'Seedtag Advertising SL France': 'Francia',
  'Seedtag Advertising Germany GmbH': 'Alemania',
  'Seedtag Advertising SL Netherlands': 'Holanda',
  'Seedtag Advertising SL Belgium': 'Belgica'
};

export const COUNTRY_ALIASES = {
  australia: 'Australia', canada: 'Canada', colombia: 'Colombia',
  germany: 'Alemania', deutschland: 'Alemania', alemania: 'Alemania',
  spain: 'España', 'españa': 'España', espana: 'España',
  france: 'Francia', francia: 'Francia',
  netherlands: 'Holanda', 'the netherlands': 'Holanda', holanda: 'Holanda',
  belgium: 'Belgica', 'bélgica': 'Belgica', belgica: 'Belgica',
  italy: 'Italia', italia: 'Italia',
  uk: 'UK', 'united kingdom': 'UK',
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US',
  mexico: 'Mexico', 'méxico': 'Mexico',
  peru: 'Peru', 'perú': 'Peru',
  brazil: 'Brasil', brasil: 'Brasil',
  argentina: 'Argentina',
  uae: 'Dubai', dubai: 'Dubai', 'united arab emirates': 'Dubai',
  chile: 'Chile'
};

export const REQUIREMENTS = {
  Chile: { mandatory: ['Titular CL', 'CuentaRUT', 'Bank name CL', 'RUT Empleado', 'Beneficiario Banco Santander? (yes o no)', 'Codigo direccion CL'], optional: [] },
  Colombia: { mandatory: ['Account CO', 'Bank Code-Name CO', 'NIT', 'Type of Account'], optional: ['Account Address CO'] },
  Argentina: { mandatory: ['CBU', 'Bank name AR', 'Estado residencia beneficiario AR', 'CUIL'], optional: ['Bank Address AR'] },
  Brasil: { mandatory: ['Conta corriente', 'Bank name BR', 'CPF', 'Agency BR', 'Routing Code BR'], optional: ['Bank Address BR'] },
  Peru: { mandatory: ['CCI', 'Bank name PE', 'Peru routing code (3 Digits)', 'Bank country', 'BIC/SWIFT PE', 'RUC'], optional: ['Bank address'] },
  Mexico: { mandatory: ['CLABE', 'Bank Name MX', 'RFC'], optional: ['Account Address MX'] },
  Canada: { mandatory: ['Account Number CA', 'Bank name', 'Institution', 'Transit number CA'], optional: [] },
  Australia: { mandatory: ['Account AU', 'Bank Name AU', 'Bank Address AU', 'Bank Country AU', 'BSB'], optional: [] },
  Dubai: { mandatory: ['Bank Name UAE', 'IBAN UAE', 'Bank Address UAE', 'Bank Country UAE', 'SWIFT'], optional: [] },
  UK: { mandatory: ['Account UK', 'Sort Code'], optional: [] },
  US: { mandatory: ['Account US', 'Bank Name US', 'Routing Number'], optional: ['Bank Address US', 'ABA Code'] },
  'España': { mandatory: ['IBAN', 'SWIFT'], optional: [] },
  Italia: { mandatory: ['IBAN', 'SWIFT'], optional: [] },
  Francia: { mandatory: ['IBAN', 'SWIFT'], optional: [] },
  Alemania: { mandatory: ['IBAN', 'SWIFT'], optional: [] },
  Holanda: { mandatory: ['IBAN', 'SWIFT'], optional: [] },
  Belgica: { mandatory: ['IBAN', 'SWIFT'], optional: [] }
};

export function resolveCountry(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (REQUIREMENTS[s]) return s;
  const alias = COUNTRY_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  const subco = SUBCOMPANY_COUNTRY[s];
  if (subco) return subco;
  return '';
}

export function normalizeNameKey(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean).sort().join(' ');
}

export function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

// Valuta TUTTI gli employee del roster (AdjData), non solo quelli aggiunti
// a una richiesta mensile - usato dalla dashboard Overview per il conteggio
// aggregato per paese. Nessun input esterno da matchare: ogni riga AdjData
// è già la fonte di verità sull'email.
// Come evaluateRoster, ma ritorna anche la lista completa employee-per-employee
// (solo nomi dei campi mancanti, MAI i valori bancari) + il breakdown per
// status globale, per la pagina "Check Employees" in Overview.
export function evaluateRosterDetailed(bankRows, adjRows) {
  const bankByEmail = {};
  bankRows.forEach((r) => {
    const e = String(r.Email || '').trim().toLowerCase();
    if (e) bankByEmail[e] = r;
  });

  const employees = [];
  const statusCounts = {};
  const byCountry = {}; // country -> { country, OK, OK_MISSING_OPTIONAL, MISSING_MANDATORY, ON_LEAVE, COUNTRY_NOT_MAPPED }

  adjRows.forEach((adj) => {
    const email = String(adj.Email || '').trim().toLowerCase();
    if (!email) return;
    const rawStatus = String(adj.Status || '').trim().toLowerCase();
    // Nome dalla colonna "Employee" (come in AdjData), fallback First+Last name
    const name = adj.Employee || [adj['First name'], adj['Last name']].filter(Boolean).join(' ');

    let status, country, missingMand = [], missingOpt = [];
    if (rawStatus === 'leave') {
      country = resolveCountry(adj.Country) || adj.Country || 'Unmapped';
      status = 'ON_LEAVE';
    } else if (rawStatus !== 'active') {
      return; // INACTIVE - non ci interessa qui, escluso del tutto
    } else {
      const resolved = resolveCountry(adj.Country);
      if (!resolved || !REQUIREMENTS[resolved]) {
        country = adj.Country || 'Unmapped';
        status = 'COUNTRY_NOT_MAPPED';
      } else {
        country = resolved;
        const bankRec = bankByEmail[email] || {};
        const req = REQUIREMENTS[country];
        missingMand = req.mandatory.filter((f) => isEmpty(bankRec[f]));
        missingOpt = req.optional.filter((f) => isEmpty(bankRec[f]));
        status = missingMand.length ? 'MISSING_MANDATORY' : (missingOpt.length ? 'OK_MISSING_OPTIONAL' : 'OK');
      }
    }

    employees.push({
      name, email: adj.Email || email, country, status,
      missing_mandatory: missingMand.join(', '), missing_optional: missingOpt.join(', ')
    });

    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (!byCountry[country]) {
      byCountry[country] = { country, OK: 0, OK_MISSING_OPTIONAL: 0, MISSING_MANDATORY: 0, ON_LEAVE: 0, COUNTRY_NOT_MAPPED: 0 };
    }
    byCountry[country][status] = (byCountry[country][status] || 0) + 1;
  });

  const statusBreakdown = Object.keys(statusCounts).sort().map((s) => ({ status: s, count: statusCounts[s] }));
  const countryBreakdown = Object.values(byCountry).sort((a, b) => a.country.localeCompare(b.country));

  employees.sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name));

  return { employees, statusBreakdown, countryBreakdown };
}

export function evaluateRoster(bankRows, adjRows) {
  const bankByEmail = {};
  bankRows.forEach((r) => {
    const e = String(r.Email || '').trim().toLowerCase();
    if (e) bankByEmail[e] = r;
  });

  const byCountry = {};
  function bucket(country) {
    if (!byCountry[country]) {
      byCountry[country] = {
        country, total: 0, OK: 0, OK_MISSING_OPTIONAL: 0, MISSING_MANDATORY: 0,
        INACTIVE: 0, ON_LEAVE: 0, COUNTRY_NOT_MAPPED: 0
      };
    }
    return byCountry[country];
  }

  adjRows.forEach((adj) => {
    const email = String(adj.Email || '').trim().toLowerCase();
    if (!email) return;
    const rawStatus = String(adj.Status || '').trim().toLowerCase();

    let status, country;
    if (rawStatus === 'leave') {
      country = resolveCountry(adj.Country) || adj.Country || 'Unmapped';
      status = 'ON_LEAVE';
    } else if (rawStatus !== 'active') {
      country = resolveCountry(adj.Country) || adj.Country || 'Unmapped';
      status = 'INACTIVE';
    } else {
      const resolved = resolveCountry(adj.Country);
      if (!resolved || !REQUIREMENTS[resolved]) {
        country = adj.Country || 'Unmapped';
        status = 'COUNTRY_NOT_MAPPED';
      } else {
        country = resolved;
        const bankRec = bankByEmail[email] || {};
        const req = REQUIREMENTS[country];
        const missingMand = req.mandatory.filter((f) => isEmpty(bankRec[f]));
        const missingOpt = req.optional.filter((f) => isEmpty(bankRec[f]));
        status = missingMand.length ? 'MISSING_MANDATORY' : (missingOpt.length ? 'OK_MISSING_OPTIONAL' : 'OK');
      }
    }

    const b = bucket(country);
    b.total++;
    b[status] = (b[status] || 0) + 1;
  });

  return Object.values(byCountry).sort((a, b) => b.total - a.total);
}

// Detects an email-like column when there's no exact "Email" header,
// by scanning cell values in the first data row(s) for an "@" pattern.
export function findEmailKey(row) {
  if ('Email' in row) return 'Email';
  const emailLike = Object.keys(row).find((k) => /@/.test(String(row[k] || '')));
  return emailLike || null;
}

// bankRows: "Personio Active Employees" tab (bank fields ONLY, no reliable Status/Country) - Treasury Sheet
// adjRows: "[IMPORT] AdjData" tab (Status + Country, canonical roster) - HR Analytics Sheet
// inputRows: array of {name, email} pasted/uploaded by Treasury Ops
export function matchAndEvaluate(bankRows, adjRows, inputRows) {
  const bankByEmail = {};
  bankRows.forEach((row) => {
    const email = String(row.Email || '').trim().toLowerCase();
    if (email) bankByEmail[email] = row;
  });

  const adjByEmail = {};
  const adjByName = {};
  adjRows.forEach((row) => {
    const email = String(row.Email || '').trim().toLowerCase();
    if (email) adjByEmail[email] = row;
    const fn = row['First name'];
    const ln = row['Last name'];
    if (fn || ln) {
      const key = normalizeNameKey([fn, ln].filter(Boolean).join(' '));
      if (key) {
        if (!adjByName[key]) adjByName[key] = [];
        adjByName[key].push(row);
      }
    }
  });

  return inputRows.map((input) => {
    const email = String(input.email || '').trim().toLowerCase();
    const nameKey = normalizeNameKey(input.name);

    let adj = null;
    let matchedBy = null;

    if (email && adjByEmail[email]) {
      adj = adjByEmail[email];
      matchedBy = 'email';
    } else if (nameKey && adjByName[nameKey]) {
      const candidates = adjByName[nameKey];
      if (candidates.length === 1) {
        adj = candidates[0];
        matchedBy = 'name';
      } else {
        return {
          input_name: input.name || '', input_email: input.email || '',
          matched_email: '', matched_by: null, country: '',
          status: 'AMBIGUOUS',
          missing_mandatory: '', missing_optional: '',
          ambiguous_candidates: candidates.map((c) => c.Email).join(', ')
        };
      }
    }

    if (!adj) {
      return {
        input_name: input.name || '', input_email: input.email || '',
        matched_email: '', matched_by: null, country: '',
        status: 'NOT_FOUND', missing_mandatory: '', missing_optional: '', ambiguous_candidates: ''
      };
    }

    const matchedEmail = String(adj.Email || '').trim().toLowerCase();
    const rawStatus = String(adj.Status || '').trim().toLowerCase();

    if (rawStatus === 'leave') {
      return {
        input_name: input.name || '', input_email: adj.Email || input.email || '',
        matched_email: adj.Email || '', matched_by: matchedBy, country: resolveCountry(adj.Country) || adj.Country || '',
        status: 'ON_LEAVE', missing_mandatory: '', missing_optional: '', ambiguous_candidates: ''
      };
    }

    if (rawStatus !== 'active') {
      return {
        input_name: input.name || '', input_email: adj.Email || input.email || '',
        matched_email: adj.Email || '', matched_by: matchedBy, country: resolveCountry(adj.Country) || adj.Country || '',
        status: 'INACTIVE', missing_mandatory: '', missing_optional: '', ambiguous_candidates: ''
      };
    }

    const country = resolveCountry(adj.Country);
    if (!country || !REQUIREMENTS[country]) {
      return {
        input_name: input.name || '', input_email: adj.Email || input.email || '',
        matched_email: adj.Email || '', matched_by: matchedBy, country: adj.Country || '',
        status: 'COUNTRY_NOT_MAPPED', missing_mandatory: '', missing_optional: '', ambiguous_candidates: ''
      };
    }

    const bankRec = bankByEmail[matchedEmail] || {};
    const req = REQUIREMENTS[country];
    const missingMand = req.mandatory.filter((f) => isEmpty(bankRec[f]));
    const missingOpt = req.optional.filter((f) => isEmpty(bankRec[f]));

    let status;
    if (missingMand.length) status = 'MISSING_MANDATORY';
    else if (missingOpt.length) status = 'OK_MISSING_OPTIONAL';
    else status = 'OK';

    return {
      input_name: input.name || '', input_email: adj.Email || input.email || '',
      matched_email: adj.Email || '', matched_by: matchedBy, country,
      status, missing_mandatory: missingMand.join(', '), missing_optional: missingOpt.join(', '),
      ambiguous_candidates: ''
    };
  });
}
