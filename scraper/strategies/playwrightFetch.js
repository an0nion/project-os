/**
 * Strategy 2: Playwright / Puppeteer Headless
 * Handles JS-rendered pages. Two modes:
 *   - Local dev: full puppeteer
 *   - Vercel serverless: @sparticuz/chromium (fits 50MB function limit)
 *
 * Disabled by default — set ENABLE_PLAYWRIGHT=true to activate.
 * Most fellowship pages are SSR (Greenhouse, Lever, Google Forms),
 * so fall through to manual paste before reaching this.
 */

export async function playwrightFetch(url) {
  if (process.env.ENABLE_PLAYWRIGHT !== 'true') {
    throw new Error('Playwright disabled — set ENABLE_PLAYWRIGHT=true to enable');
  }

  let browser;
  try {
    // Vercel serverless path
    if (process.env.VERCEL) {
      const chromium = (await import('@sparticuz/chromium')).default;
      const puppeteer = (await import('puppeteer-core')).default;
      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // Local dev: puppeteer-core with the bundled chromium from @sparticuz/chromium
      // (same package, no extra install needed)
      const chromium = (await import('@sparticuz/chromium')).default;
      const puppeteer = (await import('puppeteer-core')).default;
      browser = await puppeteer.launch({
        args:            chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath:  await chromium.executablePath(),
        headless:        true,
      });
    }

    const page = await browser.newPage();

    // Block heavy assets for speed
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        req.abort();
      } else if (req.url().includes('analytics') || req.url().includes('tracking')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    // Try to expand accordion/show-more elements
    const expandSelectors = ['button', '[role="button"]', '.accordion-button', '.show-more'];
    for (const sel of expandSelectors) {
      const handles = await page.$$(sel);
      for (const handle of handles.slice(0, 10)) {
        try {
          await handle.click();
          await new Promise(r => setTimeout(r, 300));
        } catch {}
      }
    }

    const html = await page.content();
    return { html, method: 'playwright' };
  } catch (err) {
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
