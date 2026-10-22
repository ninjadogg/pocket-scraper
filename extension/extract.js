// Self-contained: shared by injected Chrome capture and the Playwright runner.
export function extractFields(fields, expectedOrigin, rowSelector = '') {
  let serialize = false;
  if (!Array.isArray(fields)) ({ fields, rowSelector = '', expectedOrigin, serialize = false } = fields);
  if (expectedOrigin && location.origin !== expectedOrigin) throw new Error('Open a page on the recipe’s website before extracting.');
  if (/^(just a moment|attention required)/i.test(document.title.trim()) && /cloudflare|security verification|verify you are human/i.test(document.body?.innerText || '')) throw new Error('Finish the website’s browser verification before extracting.');
  const warnings = [];
  const read = (el, kind) => {
    if (kind === 'href') return el.href || el.getAttribute('href') || '';
    if (kind === 'html') return el.innerHTML.trim();
    if (kind === 'value') return String(el.value ?? el.getAttribute('value') ?? '');
    return (el.innerText || el.textContent || '').trim();
  };
  const query = (root, selector, name) => {
    try { return [...root.querySelectorAll(selector)]; }
    catch { throw new Error(`Invalid selector for ${name}. Pick that field again.`); }
  };
  const roots = rowSelector ? query(document, rowSelector, 'record container') : [document];
  if (!roots.length) throw new Error('No record containers matched. Pick the record container again.');
  if (roots.length > 5000) throw new Error('More than 5000 records. Select a smaller page section.');
  const rows = [];
  for (const [index, root] of roots.entries()) {
    const columns = fields.map(field => query(root, field.selector, field.name).map(el => read(el, field.kind)));
    if (rowSelector) {
      // Multiple matches belong to this record (e.g. several release-note lists).
      const values = Object.fromEntries(fields.map((field, i) => [field.name, columns[i].join('\n')]));
      for (let i = 0; i < fields.length; i++) if (!columns[i].length && warnings.length < 30) warnings.push(`Record ${index + 1}: no matches for ${fields[i].name}`);
      if (Object.values(values).some(Boolean)) rows.push({ pageUrl: location.href, fields: values });
    } else {
      const counts = columns.map(c => c.length);
      if (new Set(counts).size > 1) throw new Error('Field match counts differ. Pick a record container to avoid pairing unrelated values.');
      const count = counts[0] || 0;
      if (count > 5000) throw new Error('More than 5000 matches. Select a smaller page section.');
      if (count > 1 && fields.length > 1) warnings.push('Legacy positional extraction: equal counts do not guarantee related fields. Pick a record container.');
      for (let i = 0; i < count; i++) {
        const values = Object.fromEntries(fields.map((field, j) => [field.name, columns[j][i]]));
        if (Object.values(values).some(Boolean)) rows.push({ pageUrl: location.href, fields: values });
      }
    }
  }
  const emptyFields = [];
  if (rows.length && fields.length > 1) {
    for (const field of fields) {
      if (rows.every(row => !row.fields[field.name])) emptyFields.push({ name: field.name, selector: field.selector });
    }
  }
  // Health warnings come first and the total stays within the 30 a tab capture accepts.
  const health = emptyFields.map(f => `Selector health: field "${f.name}" (${f.selector}) was empty across all ${rows.length} record(s)`);
  const output = { pageUrl: location.href, rows, warnings: [...health, ...warnings].slice(0, 30), emptyFields };
  return serialize ? JSON.stringify(output) : output;
}
