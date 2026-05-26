// Diagnostic: Open a multiselect, dump item structure and check which element handles click
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const contexts = browser.contexts();
const pages = contexts.flatMap(c => c.pages());
const page = pages.find(p => p.url().includes('smartrecruiters')) || pages[0];

console.log('Page:', page.url());

// Find the first multiselect and click it to open
const bbox = await page.evaluate(() => {
  function qas(root, sel, res = []) {
    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
    return res;
  }
  const msEls = qas(document, 'spl-multiselect-autocomplete');
  console.log('Found', msEls.length, 'multiselect elements');
  if (msEls.length === 0) return null;
  const ms = msEls[0];
  ms.scrollIntoView({ block: 'center' });
  const rect = ms.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});

if (!bbox) { console.log('No multiselect found'); process.exit(1); }

console.log('Clicking multiselect at', bbox);
await page.mouse.click(bbox.x, bbox.y);
await page.waitForTimeout(1000);

// Dump ALL spl-dropdown-item elements with full details
const items = await page.evaluate(() => {
  function qas(root, sel, res = []) {
    try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
    try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
    return res;
  }
  
  const allItems = qas(document, 'spl-dropdown-item');
  const results = [];
  for (const item of allItems) {
    const r = item.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    
    // Walk up to find parent chain
    const parents = [];
    let el = item;
    for (let i = 0; i < 10; i++) {
      const root = el.getRootNode();
      if (root === document) {
        parents.push(`DOCUMENT`);
        break;
      }
      const host = root?.host;
      if (host) {
        parents.push(`${host.tagName}${host.id ? '#' + host.id : ''}`);
        el = host;
      } else {
        break;
      }
    }
    
    // Check attributes
    const attrs = {};
    for (const attr of item.attributes) {
      attrs[attr.name] = attr.value;
    }
    
    // Check inner HTML structure
    const innerHTML = item.shadowRoot ? item.shadowRoot.innerHTML.substring(0, 200) : item.innerHTML.substring(0, 200);
    
    // Check if it has children
    const children = [];
    if (item.shadowRoot) {
      item.shadowRoot.querySelectorAll('*').forEach(c => {
        children.push({
          tag: c.tagName,
          role: c.getAttribute('role'),
          class: c.className?.substring?.(0, 30) || '',
        });
      });
    }
    
    results.push({
      text: (item.innerText || item.textContent || '').trim().substring(0, 50),
      tag: item.tagName,
      attrs,
      parentChain: parents,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hasShadow: !!item.shadowRoot,
      innerHTMLSnippet: innerHTML.substring(0, 150),
      children: children.slice(0, 5),
    });
  }
  return results;
});

console.log(`\n=== ${items.length} visible spl-dropdown-item elements ===\n`);
for (const item of items) {
  console.log(`--- "${item.text}" ---`);
  console.log(`  Parent chain: ${item.parentChain.join(' > ')}`);
  console.log(`  Rect: ${item.rect.x},${item.rect.y} ${item.rect.w}x${item.rect.h}`);
  console.log(`  Has shadow: ${item.hasShadow}`);
  console.log(`  Attrs:`, JSON.stringify(item.attrs));
  console.log(`  Children: ${item.children.map(c => `<${c.tag} role=${c.role}>`).join(', ')}`);
  console.log(`  innerHTML: ${item.innerHTMLSnippet}`);
  console.log();
}

// Now try clicking the first item that says "prefer not to answer"
const target = items.find(i => i.text.toLowerCase().includes('prefer not'));
if (target) {
  console.log(`\n=== Attempting to click "${target.text}" ===`);
  
  // Try 1: ElementHandle click
  const handle = await page.evaluateHandle((targetText) => {
    function qas(root, sel, res = []) {
      try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
      try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
      return res;
    }
    const items = qas(document, 'spl-dropdown-item');
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((el.innerText || '').trim().toLowerCase().includes(targetText)) return el;
    }
    return null;
  }, 'prefer not');
  
  const el = handle?.asElement();
  if (el) {
    // Check what the element looks like BEFORE click
    const beforeVal = await page.evaluate(() => {
      function qas(root, sel, res = []) {
        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
        return res;
      }
      const ms = qas(document, 'spl-multiselect-autocomplete')[0];
      const inp = ms?.shadowRoot?.querySelector('input');
      return { value: inp?.value, checked: ms?.getAttribute('value'), hostVal: ms?.value };
    });
    console.log('Before click - input value:', beforeVal);
    
    await el.click({ force: true });
    console.log('Clicked via ElementHandle.click({ force: true })');
    
    await page.waitForTimeout(1000);
    
    // Check AFTER click
    const afterVal = await page.evaluate(() => {
      function qas(root, sel, res = []) {
        try { root.querySelectorAll(sel).forEach(e => res.push(e)); } catch {}
        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) qas(el.shadowRoot, sel, res); }); } catch {}
        return res;
      }
      const ms = qas(document, 'spl-multiselect-autocomplete')[0];
      const inp = ms?.shadowRoot?.querySelector('input');
      return { value: inp?.value, checked: ms?.getAttribute('value'), hostVal: ms?.value };
    });
    console.log('After click - input value:', afterVal);
    
    el.dispose();
  }
}

// Close dropdown by pressing Escape
await page.keyboard.press('Escape');

await browser.close();
