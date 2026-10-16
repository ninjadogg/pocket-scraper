// Injected only after clicking a picker button in the extension popup.
// Entirely deterministic: creates a CSS selector from the clicked DOM element.
export function installPicker(mode, fieldName, kind, rowSelector = '') {
  if (window.__pocketScraperCleanup) window.__pocketScraperCleanup();
  let hovered = null;
  let selectionRoot = document;
  const banner = document.createElement('div');
  banner.textContent = `Pocket Scraper: click an element to select ${mode}; ESC to cancel`;
  Object.assign(banner.style, {
    position: 'fixed', inset: '8px auto auto 8px', zIndex: '2147483647',
    padding: '9px 12px', background: '#131a27', color: 'white',
    borderRadius: '8px', font: '13px system-ui', boxShadow: '0 2px 10px #0006',
    pointerEvents: 'none'
  });
  document.documentElement.append(banner);
  function safeCount(sel) { try { return selectionRoot.querySelectorAll(sel).length; } catch { return 0; } }
  function pickSelector(el, unique) {
    const clean = s => CSS.escape(s);
    if (unique && el.id && !/\d{5,}/.test(el.id)) return `#${clean(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].filter(c => c.length < 60 && !/[0-9]{5,}/.test(c));
    const choices = [];
    for (let count = Math.min(3, classes.length); count >= 1; count--) {
      choices.push(tag + classes.slice(0, count).map(c => `.${clean(c)}`).join(''));
    }
    choices.push(tag);
    if (!unique) {
      const multiple = choices.filter(s => safeCount(s) >= 2 && safeCount(s) <= 300);
      if (multiple.length) return multiple[0];
      if (el.id && !/\d{5,}/.test(el.id)) return `#${clean(el.id)}`;
      if (choices.find(s => safeCount(s) === 1)) return choices.find(s => safeCount(s) === 1);
    } else {
      const exact = choices.find(s => safeCount(s) === 1);
      if (exact) return exact;
    }
    const parts = [];
    for (let node = el; node && node !== selectionRoot && node.nodeType === 1 && parts.length < 12; node = node.parentElement) {
      let item = node.tagName.toLowerCase();
      if (node.id && !/\d{5,}/.test(node.id)) {
        parts.unshift(`#${clean(node.id)}`);
        return parts.join(' > ');
      }
      const siblings = [...(node.parentElement?.children || [])].filter(s => s.tagName === node.tagName);
      if (siblings.length > 1) item += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(item);
    }
    return parts.join(' > ');
  }
  function clearHighlight() {
    if (hovered) { hovered.style.outline = hovered.__pocketPrevOutline || ''; delete hovered.__pocketPrevOutline; }
    hovered = null;
  }
  function cleanup() {
    clearHighlight(); banner.remove();
    document.removeEventListener('mouseover', hover, true);
    document.removeEventListener('click', selected, true);
    document.removeEventListener('keydown', keydown, true);
    delete window.__pocketScraperCleanup;
  }
  function target(e) {
    let t = e.target;
    if (!(t instanceof Element)) return null;
    if (mode === 'row') return t.closest('article,li,tr') || t;
    if (kind === 'href') t = t.closest('a[href]') || t;
    if (mode === 'action' || mode === 'next') t = t.closest('a,button,[role="button"],input[type="submit"]') || t;
    return t;
  }
  function hover(e) {
    const el = target(e);
    if (el === hovered) return;
    clearHighlight();
    if (el && el !== banner) {
      hovered = el;
      el.__pocketPrevOutline = el.style.outline;
      el.style.outline = '3px solid #f97316';
    }
  }
  function selected(e) {
    const el = target(e);
    if (!el) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (mode === 'field' && rowSelector) {
      try { selectionRoot = el.closest(rowSelector); } catch { selectionRoot = null; }
      if (!selectionRoot) { banner.textContent = 'Click a field inside the selected record container.'; return; }
    }
    const selector = pickSelector(el, mode !== 'field' && mode !== 'row');
    const matches = safeCount(selector);
    cleanup();
    chrome.runtime.sendMessage({ type: 'PICK_RESULT', mode, selector, matches, fieldName, kind });
  }
  function keydown(e) { if (e.key === 'Escape') cleanup(); }
  document.addEventListener('mouseover', hover, true);
  document.addEventListener('click', selected, true);
  document.addEventListener('keydown', keydown, true);
  window.__pocketScraperCleanup = cleanup;
}
