import { chromium } from 'playwright-extra';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://jobs.smartrecruiters.com/oneclick-ui/company/Wise/publication/23e1b5ff-414a-4a1f-ac5a-8bcf97f8fc7f?dcr_ci=Wise');
  
  // Wait for the "I'm interested" button
  await page.waitForSelector('#st-apply', { state: 'visible' });
  await page.click('#st-apply');
  
  // Wait for the form to appear
  await page.waitForTimeout(4000);
  
  // Dump all inputs and any validation errors
  const errors = await page.evaluate(() => {
    function queryAllShadows(root, selector, res = []) {
      const elements = root.querySelectorAll('*');
      for (const el of elements) {
        if (el.matches(selector)) res.push(el);
        if (el.shadowRoot) queryAllShadows(el.shadowRoot, selector, res);
      }
      return res;
    }
    const errEls = queryAllShadows(document, '[class*="error"], [class*="invalid"], .validation-message, [aria-invalid="true"]');
    return errEls.map(el => ({
      tag: el.tagName,
      cls: el.className,
      text: (el.innerText || el.textContent || '').trim()
    })).filter(e => e.text);
  });
  
  console.log("INITIAL ERRORS:");
  console.log(errors);
  
  await browser.close();
})();
