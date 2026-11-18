import puppeteer from 'puppeteer-core';
import { config } from '../config.js';

/**
 * Prints a report's live page to PDF with headless Chrome, so the PDF always
 * matches what the live link shows. The page marks itself ready with
 * [data-report-ready] once everything on it has rendered.
 *
 * Needs Chrome or Chromium on the worker: set CHROME_PATH.
 */
export async function renderReportPdf(url: string): Promise<Buffer> {
  if (!config.chromePath) throw new Error('CHROME_PATH is not set on the worker, so PDFs cannot be made');
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'];
  // Development only: send agency hostnames to the local web app.
  if (config.pdfHostRules) args.push(`--host-resolver-rules=${config.pdfHostRules}`);
  const browser = await puppeteer.launch({ executablePath: config.chromePath, args, headless: true });
  try {
    const page = await browser.newPage();
    await page.emulateMediaType('print');
    const res = await page.goto(url, { waitUntil: 'networkidle0', timeout: 45_000 });
    if (!res || !res.ok()) throw new Error(`The report page answered ${res?.status() ?? 'nothing'}`);
    await page.waitForSelector('[data-report-ready]', { timeout: 20_000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
