import { chromium } from 'playwright-extra';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://jobs.smartrecruiters.com/oneclick-ui/company/Wise/publication/23e1b5ff-414a-4a1f-ac5a-8bcf97f8fc7f?dcr_ci=Wise');
  await page.waitForTimeout(6000);

  // Dump all data-qa elements
  const results = await page.evaluate(() => {
    function queryAllShadows(root, selector, res = []) {
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.matches(selector)) res.push(el);
        if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
      }
      return res;
    }
    const qas = queryAllShadows(document, 'button, sr-button, spl-button, a');
    return qas.map(el => ({
      tag: el.tagName,
      qa: el.getAttribute('data-qa') || '',
      type: el.getAttribute('type') || '',
      cls: el.getAttribute('class') || '',
      text: (el.innerText || el.textContent || '').trim().replace(/\n/g, ' ').substring(0, 50)
    })).filter(el => el.text.length > 0);
  });
  
  console.log("DATA-QA ELEMENTS:");
  console.log(JSON.stringify(results, null, 2));
  
  await browser.close();
})();
