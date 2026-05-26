'use strict';

/**
 * scraper.js
 * Cash Store — Puppeteer-based product data extraction engine.
 *
 * Supports major e-commerce platforms by trying multiple CSS selector
 * strategies in priority order. Returns a normalised product object or
 * null on any unrecoverable error so callers can decide how to handle.
 */

const puppeteer = require('puppeteer');

/* ─────────────────────────── CONSTANTS ───────────────────────────── */

const NAVIGATION_TIMEOUT_MS = 30_000;
const PAGE_LOAD_WAIT_MS = 2_500; // extra settle time after DOMContentLoaded

/**
 * Realistic desktop Chrome user-agent (Chrome 124 on Windows 11).
 * Helps bypass rudimentary bot-detection checks on some platforms.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * CSS selectors tried in priority order for each field.
 * The first selector that yields a non-empty string wins.
 */
const PRICE_SELECTORS = [
  '[data-testid="price"]',
  '[itemprop="price"]',
  '.product-price',
  '.price',
  '.a-price-whole',          // Amazon
  '.pdp-price',              // Zalando / various
  '#priceblock_ourprice',    // Amazon legacy
  '#priceblock_dealprice',
  '.offer-price',
  '.sale-price',
  '.current-price',
  '.price-current',
  '[class*="price"]',        // catch-all wildcard
];

const TITLE_SELECTORS = [
  '[itemprop="name"]',
  '[data-testid="product-title"]',
  '.product-title',
  '.product-name',
  '#productTitle',           // Amazon
  'h1.title',
  'h1',
];

const IMAGE_SELECTORS = [
  '[itemprop="image"]',
  '[data-testid="hero-image"] img',
  '#landingImage',           // Amazon
  '.product-image img',
  '.gallery-image img',
  'img[alt][src*="product"]',
  'img[alt]',
];

/* ───────────────────────── HELPERS ──────────────────────────────── */

/**
 * Strips all currency symbols, thousands separators, whitespace,
 * and "USD"/"EUR" etc. labels, then parses the result as a float.
 *
 * Returns NaN if the string cannot be parsed.
 *
 * @param {string} raw
 * @returns {number}
 */
function parsePriceString(raw) {
  if (!raw || typeof raw !== 'string') return NaN;

  const cleaned = raw
    .replace(/[^\d.,]/g, '')   // keep only digits, dots, commas
    .replace(/,(\d{3})/g, '$1') // remove thousands commas: 1,299 → 1299
    .replace(/,/g, '.')         // European decimal comma → dot
    .trim();

  // Handle "1.299.00" edge-case by keeping only the last decimal section
  const parts = cleaned.split('.');
  const normalised =
    parts.length > 2
      ? parts.slice(0, -1).join('') + '.' + parts[parts.length - 1]
      : cleaned;

  const parsed = parseFloat(normalised);
  return isNaN(parsed) ? NaN : Math.round(parsed * 100) / 100; // 2 dp
}

/**
 * Resolves a potentially relative image URL against the page origin.
 *
 * @param {string} src
 * @param {string} pageUrl
 * @returns {string}
 */
function resolveImageUrl(src, pageUrl) {
  if (!src) return '';
  try {
    return new URL(src, pageUrl).href;
  } catch {
    return src;
  }
}

/* ─────────────────── PAGE EVALUATION FUNCTION ───────────────────── */

/**
 * Executed inside the browser page context via page.evaluate().
 * Receives serialisable selector lists and returns raw strings.
 *
 * NOTE: No Node.js module APIs are available here — browser DOM only.
 *
 * @param {string[]} priceSelectors
 * @param {string[]} titleSelectors
 * @param {string[]} imageSelectors
 * @returns {{ rawPrice: string, rawTitle: string, rawImageSrc: string }}
 */
function extractPageData(priceSelectors, titleSelectors, imageSelectors) {
  /**
   * Tries each selector in order and returns the first non-empty text match.
   * @param {string[]} selectors
   * @returns {string}
   */
  function firstMatch(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const text = (el.getAttribute('content') || el.innerText || '').trim();
        if (text) return text;
      } catch (_) {
        // malformed selector — skip
      }
    }
    return '';
  }

  /**
   * Tries each image selector in order and returns the first valid src.
   * @param {string[]} selectors
   * @returns {string}
   */
  function firstImageSrc(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const src =
          el.getAttribute('src') ||
          el.getAttribute('data-src') ||
          el.getAttribute('content') ||
          '';
        if (src && !src.startsWith('data:image/gif')) return src.trim();
      } catch (_) {
        // skip
      }
    }
    return '';
  }

  return {
    rawPrice: firstMatch(priceSelectors),
    rawTitle: firstMatch(titleSelectors),
    rawImageSrc: firstImageSrc(imageSelectors),
  };
}

/* ──────────────────────── PUBLIC API ────────────────────────────── */

/**
 * Scrapes a product page and returns normalised data.
 *
 * @param {string} url  Full URL of the product page to scrape.
 * @returns {Promise<{ title: string, price: number, imageUrl: string, originalUrl: string } | null>}
 */
async function scanProductPrice(url) {
  if (!url || typeof url !== 'string') {
    console.error('[scraper] scanProductPrice called with invalid URL:', url);
    return null;
  }

  // Minimal URL validity check before launching a browser
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Protocol must be http or https');
    }
  } catch (err) {
    console.error('[scraper] Invalid URL provided:', url, err.message);
    return null;
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: 'new',  // use the new headless mode (Puppeteer ≥ 20)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',      // avoids /dev/shm OOM in Docker
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--no-first-run',
        '--single-process',             // reduce memory in production
      ],
    });

    const page = await browser.newPage();

    // ── Anti-detection hardening ────────────────────────────────────
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    });
    await page.setViewport({ width: 1440, height: 900 });

    // Block non-essential resource types to speed up page load
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blocked = ['font', 'media', 'websocket'];
      if (blocked.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // ── Navigation ─────────────────────────────────────────────────
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    // Allow dynamic JS to populate price/title elements
    await new Promise((resolve) => setTimeout(resolve, PAGE_LOAD_WAIT_MS));

    // ── Data extraction ─────────────────────────────────────────────
    const { rawPrice, rawTitle, rawImageSrc } = await page.evaluate(
      extractPageData,
      PRICE_SELECTORS,
      TITLE_SELECTORS,
      IMAGE_SELECTORS
    );

    // ── Post-processing ─────────────────────────────────────────────
    const price = parsePriceString(rawPrice);
    const title = rawTitle.replace(/\s+/g, ' ').trim().substring(0, 500);
    const imageUrl = resolveImageUrl(rawImageSrc, url);

    if (isNaN(price) || price <= 0) {
      console.warn(
        `[scraper] Could not extract a valid price from "${url}". ` +
          `Raw price string was: "${rawPrice}"`
      );
      return null;
    }

    if (!title) {
      console.warn(`[scraper] Could not extract a product title from "${url}".`);
      return null;
    }

    const result = {
      title,
      price,
      imageUrl,
      originalUrl: url,
    };

    console.info(
      `[scraper] Successfully scraped "${title}" at $${price} from ${url}`
    );

    return result;
  } catch (err) {
    console.error(`[scraper] Failed to scrape "${url}":`, err.message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch((closeErr) => {
        console.error('[scraper] Error closing browser:', closeErr.message);
      });
    }
  }
}

module.exports = { scanProductPrice };
