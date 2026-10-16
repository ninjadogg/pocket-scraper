// Self-contained so Chrome can inject it into the tab without any dependencies.
export function captureFields(fields, expectedOrigin) {
  if (location.origin !== expectedOrigin) throw new Error('Open a page on the recipe’s website before extracting.');
  if (/^(just a moment|attention required)/i.test(document.title.trim()) && /cloudflare|security verification|verify you are human/i.test(document.body?.innerText || '')) {
    throw new Error('Finish the website’s browser verification before extracting.');
  }
  const warnings = [];
  const columns = fields.map(field => {
    let elements;
    try { elements = [...document.querySelectorAll(field.selector)]; }
    catch { throw new Error(`Invalid selector for ${field.name}. Pick that field again.`); }
    if (!elements.length) warnings.push(`No matches for ${field.name}. Pick that field again on this page.`);
    return elements.map(el => {
      if (field.kind === 'href') return el.href || el.getAttribute('href') || '';
      if (field.kind === 'html') return el.innerHTML.trim();
      if (field.kind === 'value') return String(el.value ?? el.getAttribute('value') ?? '');
      return (el.innerText || el.textContent || '').trim();
    });
  });
  const count = Math.max(0, ...columns.map(c => c.length));
  if (count > 5000) throw new Error('More than 5000 matches. Select a smaller part of the page.');
  const rows = [];
  for (let i = 0; i < count; i++) {
    const values = Object.fromEntries(fields.map((f, j) => [f.name, columns[j][i] ?? '']));
    if (Object.values(values).some(Boolean)) rows.push({ pageUrl: location.href, fields: values });
  }
  return { pageUrl: location.href, rows, warnings };
}
