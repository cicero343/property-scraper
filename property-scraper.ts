import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as readline from 'readline';

chromium.use(StealthPlugin());

// ─────────────────────────────────────────────
// BANNER
// ─────────────────────────────────────────────

function printBanner() {
  console.log(`
┏┓               ┏┓           
┃┃┏┓┏┓┏┓┏┓┏┓╋┓┏  ┗┓┏┏┓┏┓┏┓┏┓┏┓
┣┛┛ ┗┛┣┛┗ ┛ ┗┗┫  ┗┛┗┛ ┗┻┣┛┗ ┛ 
      ┛       ┛         ┛     
  ⚠  This tool is for personal, educational use only.
  ⚠  It demonstrates browser automation and scraping techniques.
  ⚠  Designed and tested for UK property sites only.
  ⚠  Please respect the terms of service of any site you interact with.
`);
}

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type Site = 'rightmove' | 'zoopla';

interface Property {
  id: string;
  site: Site;
  address: string;
  price: string;
  priceValue: number;
  priceQualifier: string;
  bedrooms: string;
  bathrooms: string;
  reception: string;       // Zoopla only; empty string for Rightmove
  floorArea: string;
  propertyType: string;
  agent: string;
  agentPhone: string;      // Rightmove only; empty string for Zoopla
  url: string;
  noChain: boolean;
  isSstc: boolean;
  isReduced: boolean;
  isNewHome: boolean;
  addedDate: string;
  tags: string[];
}

// ─────────────────────────────────────────────
// SEEN PROPERTIES (shared across both sites)
// ─────────────────────────────────────────────

const SEEN_FILE = 'seen-properties.json';

function loadSeenProperties(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf-8')));
  } catch {
    return new Set();
  }
}

function saveSeenProperties(seen: Set<string>) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen], null, 2));
}

// Unique key includes site prefix to avoid ID collisions between Rightmove and Zoopla
function seenKey(p: Property): string {
  return `${p.site}:${p.id}`;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomViewport() {
  const widths = [1280, 1366, 1440, 1536, 1920];
  const heights = [720, 768, 800, 900, 1080];
  return {
    width: widths[Math.floor(Math.random() * widths.length)],
    height: heights[Math.floor(Math.random() * heights.length)],
  };
}

function randomUserAgent(): string {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

async function simulateHuman(page: any) {
  try {
    // Randomised mouse movement across a realistic range
    const x1 = randomBetween(100, 900);
    const y1 = randomBetween(100, 600);
    await page.mouse.move(x1, y1, { steps: randomBetween(12, 25) });
    await page.waitForTimeout(randomBetween(300, 800));

    // Scroll down to simulate reading (instant, not smooth — smooth can cause navigation issues)
    const scrollAmount = randomBetween(300, 800);
    await page.evaluate((amount: number) => window.scrollBy(0, amount), scrollAmount);
    await page.waitForTimeout(randomBetween(800, 1800));

    // Occasionally move mouse again mid-scroll
    if (Math.random() < 0.5) {
      const x2 = randomBetween(100, 900);
      const y2 = randomBetween(200, 700);
      await page.mouse.move(x2, y2, { steps: randomBetween(8, 18) });
      await page.waitForTimeout(randomBetween(300, 700));
    }

    // Scroll back up slightly
    await page.evaluate((amount: number) => window.scrollBy(0, -amount), Math.floor(scrollAmount * 0.4));
    await page.waitForTimeout(randomBetween(300, 700));
  } catch {
    // Page may have navigated — ignore and continue
  }
}

// ─────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────

async function getSearchParams(rl: readline.Interface) {
  console.log('');

  // ── Site selection ──
  console.log('  Which sites to scrape?');
  console.log('  [1] Rightmove only');
  console.log('  [2] Zoopla only');
  console.log('  [3] Both');
  let sites: Site[] = ['rightmove', 'zoopla'];
  while (true) {
    const input = await ask(rl, '  Sites (1/2/3 or Enter for both): ');
    const trimmed = input.trim();
    if (!trimmed || trimmed === '3') { sites = ['rightmove', 'zoopla']; break; }
    if (trimmed === '1') { sites = ['rightmove']; break; }
    if (trimmed === '2') { sites = ['zoopla']; break; }
    console.log('  Please enter 1, 2, or 3.');
  }

  // ── Location ──
  let locationInput = '';
  while (!locationInput) {
    const input = await ask(rl, '\n  Location (postcode or area, e.g. London or SE10 9RB): ');
    const trimmed = input.trim();
    if (trimmed.length < 2) {
      console.log('  Please enter a valid location.');
    } else {
      locationInput = trimmed;
    }
  }

  // ── Radius ──
  const radiusOptions = ['0', '0.25', '0.5', '1', '3', '5', '10', '15', '20', '30', '40'];
  console.log(`\n  Radius: ${radiusOptions.join(', ')} miles (or Enter for 1)`);
  let radius = '1';
  while (true) {
    const input = await ask(rl, '  Radius in miles: ');
    const trimmed = input.trim();
    if (!trimmed) { radius = '1'; break; }
    if (!radiusOptions.includes(trimmed)) {
      console.log(`  Please enter one of: ${radiusOptions.join(', ')}`);
    } else {
      radius = trimmed; break;
    }
  }

  // ── Price ──
  console.log('\n  Min price — enter a value (e.g. 250000) or press Enter for any');
  let minPrice = '';
  while (true) {
    const input = await ask(rl, '  Min price (£): ');
    const trimmed = input.trim();
    if (!trimmed) { minPrice = ''; break; }
    if (!/^\d+$/.test(trimmed)) { console.log('  Please enter a number or press Enter to skip.'); }
    else { minPrice = trimmed; break; }
  }
  console.log('  Max price — enter a value or press Enter for any');
  let maxPrice = '';
  while (true) {
    const input = await ask(rl, '  Max price (£): ');
    const trimmed = input.trim();
    if (!trimmed) { maxPrice = ''; break; }
    if (!/^\d+$/.test(trimmed)) { console.log('  Please enter a number or press Enter to skip.'); }
    else { maxPrice = trimmed; break; }
  }

  // ── Bedrooms ──
  console.log('\n  Min bedrooms (0 = studio, or press Enter for any)');
  let minBeds = '';
  while (true) {
    const input = await ask(rl, '  Min bedrooms: ');
    const trimmed = input.trim();
    if (!trimmed) { minBeds = ''; break; }
    if (!/^\d+$/.test(trimmed) || parseInt(trimmed) > 10) { console.log('  Please enter 0–10 or press Enter.'); }
    else { minBeds = trimmed; break; }
  }
  console.log('  Max bedrooms (or press Enter for any)');
  let maxBeds = '';
  while (true) {
    const input = await ask(rl, '  Max bedrooms: ');
    const trimmed = input.trim();
    if (!trimmed) { maxBeds = ''; break; }
    if (!/^\d+$/.test(trimmed) || parseInt(trimmed) > 10) { console.log('  Please enter 0–10 or press Enter.'); }
    else { maxBeds = trimmed; break; }
  }

  // ── Bathrooms ──
  console.log('\n  Min bathrooms (or press Enter for any)');
  let minBaths = '';
  while (true) {
    const input = await ask(rl, '  Min bathrooms: ');
    const trimmed = input.trim();
    if (!trimmed) { minBaths = ''; break; }
    if (!['1','2','3','4','5'].includes(trimmed)) { console.log('  Please enter 1–5 or press Enter.'); }
    else { minBaths = trimmed; break; }
  }
  console.log('  Max bathrooms (or press Enter for any)');
  let maxBaths = '';
  while (true) {
    const input = await ask(rl, '  Max bathrooms: ');
    const trimmed = input.trim();
    if (!trimmed) { maxBaths = ''; break; }
    if (!['1','2','3','4','5'].includes(trimmed)) { console.log('  Please enter 1–5 or press Enter.'); }
    else { maxBaths = trimmed; break; }
  }

  // ── Property types ──
  const typeOptions = ['detached', 'semi-detached', 'terraced', 'flat', 'bungalow', 'land', 'park home'];
  console.log(`\n  Property types — comma separated, or press Enter for all`);
  console.log(`  Options: ${typeOptions.join(', ')}`);
  let propertyTypes: string[] = [];
  while (true) {
    const input = await ask(rl, '  Property types: ');
    const trimmed = input.trim();
    if (!trimmed) break;
    const parts = trimmed.split(',').map(p => p.trim().toLowerCase());
    const invalid = parts.filter(p => !typeOptions.includes(p));
    if (invalid.length > 0) { console.log(`  Unknown: ${invalid.join(', ')}`); }
    else { propertyTypes = parts; break; }
  }

  // ── Tenure ──
  console.log('\n  Tenure — freehold, leasehold, share-of-freehold, or press Enter for any');
  const tenureOptions = ['freehold', 'leasehold', 'share-of-freehold'];
  let tenure = '';
  while (true) {
    const input = await ask(rl, '  Tenure: ');
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) { tenure = ''; break; }
    if (!tenureOptions.includes(trimmed)) { console.log(`  Please enter one of: ${tenureOptions.join(', ')} or press Enter.`); }
    else { tenure = trimmed; break; }
  }

  // ── Chain free ──
  const chainFreeInput = await ask(rl, '\n  Chain-free only? (y/n or Enter for no): ');
  const chainFree = chainFreeInput.trim().toLowerCase() === 'y';

  // ── Must haves ──
  console.log('\n  Must haves — comma separated, or press Enter for none');
  console.log('  Options: garden, parking, balcony');
  const mustHaveMap: Record<string, string> = {
    'garden': 'Garden',
    'parking': 'Parking/garage',
    'balcony': 'Balcony/terrace',
  };
  let mustHaves: string[] = [];
  while (true) {
    const input = await ask(rl, '  Must haves: ');
    const trimmed = input.trim();
    if (!trimmed) break;
    const parts = trimmed.split(',').map(p => p.trim().toLowerCase());
    const invalid = parts.filter(p => !mustHaveMap[p]);
    if (invalid.length > 0) { console.log(`  Unknown: ${invalid.join(', ')}`); }
    else { mustHaves = parts; break; }
  }

  // ── Rightmove-only: Don't show ──
  let dontShow: string[] = [];
  if (sites.includes('rightmove')) {
    console.log('\n  [Rightmove] Don\'t show — comma separated, or press Enter for none');
    console.log('  Options: new-homes, retirement, buying-schemes, auction');
    const dontShowMap: Record<string, string> = {
      'new-homes': 'newHome', 'retirement': 'retirement',
      'buying-schemes': 'sharedOwnership', 'auction': 'auction',
    };
    while (true) {
      const input = await ask(rl, '  Don\'t show: ');
      const trimmed = input.trim();
      if (!trimmed) break;
      const parts = trimmed.split(',').map(p => p.trim().toLowerCase());
      const invalid = parts.filter(p => !dontShowMap[p]);
      if (invalid.length > 0) { console.log(`  Unknown: ${invalid.join(', ')}`); }
      else { dontShow = parts; break; }
    }
  }

  // ── Zoopla-only: include/exclude toggles ──
  let sharedOwnership = 'include';
  let retirementHomes = 'include';
  let auction = 'include';
  if (sites.includes('zoopla')) {
    console.log('\n  [Zoopla] Shared ownership: include, exclude, or only (or Enter to include)');
    while (true) {
      const input = await ask(rl, '  Shared ownership: ');
      const trimmed = input.trim().toLowerCase();
      if (!trimmed || trimmed === 'include') { sharedOwnership = 'include'; break; }
      if (['exclude', 'only'].includes(trimmed)) { sharedOwnership = trimmed; break; }
      console.log('  Please enter include, exclude, or only.');
    }
    console.log('  [Zoopla] Retirement homes: include, exclude, or only (or Enter to include)');
    while (true) {
      const input = await ask(rl, '  Retirement homes: ');
      const trimmed = input.trim().toLowerCase();
      if (!trimmed || trimmed === 'include') { retirementHomes = 'include'; break; }
      if (['exclude', 'only'].includes(trimmed)) { retirementHomes = trimmed; break; }
      console.log('  Please enter include, exclude, or only.');
    }
    console.log('  [Zoopla] Auction: include, exclude, or only (or Enter to include)');
    while (true) {
      const input = await ask(rl, '  Auction: ');
      const trimmed = input.trim().toLowerCase();
      if (!trimmed || trimmed === 'include') { auction = 'include'; break; }
      if (['exclude', 'only'].includes(trimmed)) { auction = trimmed; break; }
      console.log('  Please enter include, exclude, or only.');
    }
  }

  // ── Added time ──
  const addedTimeMap: Record<string, string> = {
    '': '', 'anytime': '',
    '24h': '24_hours', '24': '24_hours',
    '3d': '3_days',   '3':  '3_days',
    '7d': '7_days',   '7':  '7_days',
    '14d': '14_days', '14': '14_days',
    '30d': '30_days', '30': '30_days',
  };
  const addedOptions: Record<string, string> = {
    '': 'Anytime', '24_hours': 'Last 24 hours', '3_days': 'Last 3 days',
    '7_days': 'Last 7 days', '14_days': 'Last 14 days', '30_days': 'Last 30 days',
  };
  // Rightmove uses 1/3/7/14 days syntax
  const rmAddedMap: Record<string, string> = {
    '': '', 'anytime': '',
    '24h': '1',  '24': '1',
    '3d': '3',   '3':  '3',
    '7d': '7',   '7':  '7',
    '14d': '14', '14': '14',
    '30d': '14', '30': '14', // Rightmove max is 14, clamp to 14
  };
  console.log('\n  Listed within: anytime, 24h, 3d, 7d, 14d, 30d (or just the number, or Enter for anytime)');
  let addedTimeRaw = '';
  while (true) {
    const input = await ask(rl, '  Listed within: ');
    const trimmed = input.trim().toLowerCase();
    if (trimmed in addedTimeMap) { addedTimeRaw = trimmed; break; }
    console.log('  Please enter anytime, 24h, 3d, 7d, 14d, 30d — or just the number e.g. 14.');
  }
  const addedTimeZoopla = addedTimeMap[addedTimeRaw];
  const addedTimeRightmove = rmAddedMap[addedTimeRaw];

  // ── Sort ──
  const sortOptions: Record<string, string> = {
    '1': 'Lowest price', '2': 'Highest price',
    '6': 'Newest listed', '10': 'Oldest listed',
  };
  const zooplaSort: Record<string, string> = {
    '1': 'lowest_price', '2': 'highest_price',
    '6': 'newest_listings', '10': 'newest_listings',
  };
  console.log('\n  Sort order:');
  Object.entries(sortOptions).forEach(([k, v]) => console.log(`    [${k}] ${v}`));
  let sortType = '6';
  while (true) {
    const input = await ask(rl, '  Sort (1/2/6/10 or Enter for newest): ');
    const trimmed = input.trim();
    if (!trimmed) { sortType = '6'; break; }
    if (!sortOptions[trimmed]) { console.log('  Please enter 1, 2, 6, or 10.'); }
    else { sortType = trimmed; break; }
  }

  // ── Keywords ──
  console.log('\n  Keywords — comma separated, or press Enter to skip');
  const kwInput = await ask(rl, '  Keywords: ');
  const keywords = kwInput.trim() === ''
    ? [] : kwInput.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0);

  // ── Include SSTC ──
  const sstcInput = await ask(rl, '\n  Include Sold Subject to Contract / Under Offer? (y/n or Enter for no): ');
  const includeSstc = sstcInput.trim().toLowerCase() === 'y';

  return {
    sites, locationInput, radius, minPrice, maxPrice, minBeds, maxBeds,
    minBaths, maxBaths, propertyTypes, tenure, chainFree,
    mustHaves, mustHaveMap, dontShow,
    sharedOwnership, retirementHomes, auction,
    addedTimeZoopla, addedTimeRightmove, addedOptions, addedTimeRaw,
    sortType, sortZoopla: zooplaSort[sortType] ?? 'newest_listings',
    sortLabel: sortOptions[sortType],
    keywords, includeSstc,
  };
}

// ─────────────────────────────────────────────
// FINGERPRINT MASKING
// ─────────────────────────────────────────────

async function applyFingerprint(page: any) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type?: string) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 100) {
          imageData.data[i] = imageData.data[i] ^ 1;
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return toDataURL.call(this, type);
    };
  });
}

// ─────────────────────────────────────────────
// RIGHTMOVE — LOCATION RESOLUTION
// ─────────────────────────────────────────────

async function resolveRightmoveLocation(page: any, locationInput: string): Promise<{ locationIdentifier: string; locationDisplay: string } | null> {
  try {
    await page.goto('https://www.rightmove.co.uk/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(randomBetween(2500, 4000));

    // await page.pause(); // Uncomment to pause for manual inspection if needed

    // Dismiss OneTrust cookie banner
    const cookieBtn = page.locator('#onetrust-accept-btn-handler');
    if (await cookieBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await cookieBtn.click();
      await page.waitForTimeout(800);
    }

    // Fill the search input — confirmed selector: input#ta_searchInput
    const searchInput = page.locator('input#ta_searchInput, input[data-testid="typeahead-searchbox"]').first();
    await searchInput.waitFor({ timeout: 8000 });
    await searchInput.click();
    await searchInput.fill(locationInput);
    await page.waitForTimeout(1500);

    const firstWord = locationInput.split(/\s+/)[0];
    const suggestion = page.getByRole('button', { name: new RegExp(firstWord, 'i') }).first();
    if (await suggestion.isVisible({ timeout: 3000 }).catch(() => false)) {
      await suggestion.click();
      await page.waitForTimeout(800);
    } else {
      await searchInput.press('Enter');
      await page.waitForTimeout(1500);
    }

    // Click the Search button — data-testid="submit" on the for-sale search panel
    const searchBtn = page.locator('button[data-testid="submit"], button[data-testid="searchCta"]').first();
    if (await searchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchBtn.click();
      await page.waitForURL('**/find.html**', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(randomBetween(2500, 4000));
    }

    const currentUrl = page.url();
    const urlObj = new URL(currentUrl);
    const locationIdentifier = urlObj.searchParams.get('locationIdentifier') ?? '';
    const displayLocation = urlObj.searchParams.get('displayLocationIdentifier') ?? locationInput;

    if (!locationIdentifier) {
      console.log('  ⚠  Could not extract Rightmove location identifier from URL.');
      return null;
    }

    console.log(`  ✓  Rightmove location: ${displayLocation} (${locationIdentifier})`);
    return { locationIdentifier, locationDisplay: displayLocation };

  } catch (err: any) {
    console.log(`  ⚠  Rightmove location resolution error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// RIGHTMOVE — BUILD SEARCH URL
// ─────────────────────────────────────────────

function buildRightmoveUrl(params: any, locationIdentifier: string, index = 0): string {
  const base = 'https://www.rightmove.co.uk/property-for-sale/find.html';
  const p = new URLSearchParams();
  p.set('locationIdentifier', locationIdentifier);
  p.set('sortType', params.sortType);
  p.set('propertyTypes', '');
  p.set('channel', 'BUY');
  p.set('transactionType', 'BUY');
  // Rightmove uses _includeSSTC with underscore prefix when including SSTC
  if (params.includeSstc) p.set('_includeSSTC', 'on');
  p.set('mustHave', '');
  p.set('dontShow', '');
  p.set('furnishTypes', '');
  p.set('keywords', params.keywords.join(','));
  if (params.minPrice)   p.set('minPrice',    params.minPrice);
  if (params.maxPrice)   p.set('maxPrice',    params.maxPrice);
  if (params.minBeds !== '') p.set('minBedrooms', params.minBeds);
  if (params.maxBeds !== '') p.set('maxBedrooms', params.maxBeds);
  if (params.minBaths)   p.set('minBathrooms', params.minBaths);
  if (params.maxBaths)   p.set('maxBathrooms', params.maxBaths);
  if (params.radius && params.radius !== '0') p.set('radius', params.radius);
  if (params.addedTimeRightmove) p.set('maxDaysSinceAdded', params.addedTimeRightmove);

  // Property types
  const typeMap: Record<string, string> = {
    'detached': 'detached', 'semi-detached': 'semi-detached', 'terraced': 'terraced',
    'flat': 'flat', 'bungalow': 'bungalow', 'land': 'land', 'park home': 'park-home',
  };
  if (params.propertyTypes.length > 0) {
    p.set('propertyTypes', params.propertyTypes.map((t: string) => typeMap[t] ?? t).join(','));
  }

  // Tenure
  // Rightmove uses tenureTypes (plural) with uppercase values
  if (params.tenure) {
    const rmTenureMap: Record<string, string> = {
      'freehold': 'FREEHOLD',
      'leasehold': 'LEASEHOLD',
      'share-of-freehold': 'SHARE_OF_FREEHOLD',
    };
    const rmTenure = rmTenureMap[params.tenure];
    if (rmTenure) p.set('tenureTypes', rmTenure);
  }

  // Don't show
  if (params.dontShow.length > 0) {
    const dsMap: Record<string, string> = {
      'new-homes': 'newHome', 'retirement': 'retirement',
      'buying-schemes': 'sharedOwnership', 'auction': 'auction',
    };
    p.set('dontShow', params.dontShow.map((d: string) => dsMap[d] ?? d).join(','));
  }

  // Must haves — garden/parking from tags
  const mhMap: Record<string, string> = { 'garden': 'garden', 'parking': 'parking', 'balcony': '' };
  const rmMustHaves = params.mustHaves.map((m: string) => mhMap[m]).filter(Boolean);
  if (rmMustHaves.length > 0) p.set('mustHave', rmMustHaves.join(','));

  if (index > 0) p.set('index', String(index));
  return `${base}?${p.toString()}`;
}

// ─────────────────────────────────────────────
// RIGHTMOVE — SCRAPE
// ─────────────────────────────────────────────

async function scrapeRightmove(page: any, params: any, locationIdentifier: string): Promise<Property[]> {
  const properties: Property[] = [];
  let pageIndex = 0;
  let totalPages = 1;
  let pageNum = 1;

  try {
    // Navigate to first page of results directly
    const firstUrl = buildRightmoveUrl(params, locationIdentifier, 0);
    console.log(`  [Rightmove] Loading search...`);
    await page.goto(firstUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(randomBetween(2500, 4000));

    // Dismiss cookie banner if present
    const acceptBtn = page.locator('#onetrust-accept-btn-handler')
      .or(page.getByRole('button', { name: /accept all/i })).first();
    if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await acceptBtn.click();
      await page.waitForTimeout(800);
    }

    while (true) {
      if (pageIndex > 0) {
        // Click the pagination "Next" button — more natural than direct URL navigation
        // which can trigger challenges on Rightmove
        console.log(`  [Rightmove] Page ${pageNum}...`);
        const nextBtn = page.locator('button[data-testid="nextPage"]').first();
        const isDisabled = await nextBtn.getAttribute('disabled').catch(() => 'disabled');
        if (isDisabled !== null) {
          // Button is disabled — we're on the last page
          break;
        }
        if (await nextBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await nextBtn.click();
          // Wait for new cards to load — more reliable than navigation events
          await page.waitForTimeout(randomBetween(2500, 4000));
          await page.waitForSelector('[data-testid^="propertyCard-vrt-"]', { timeout: 30000 });
        } else {
          // Fallback: direct URL navigation
          const url = buildRightmoveUrl(params, locationIdentifier, pageIndex);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(randomBetween(2500, 4000));
        }
      } else {
        console.log(`  [Rightmove] Page 1...`);
      }

      // await page.pause(); // Uncomment to inspect page state

      // Check for last/single page BEFORE simulateHuman to avoid crashing on navigation
      const earlyExitCheck = await page.evaluate(() => {
        const btn = document.querySelector('button[data-testid="nextPage"]');
        const isLastPage = !btn || btn.hasAttribute('disabled');
        const cards = document.querySelectorAll('[data-testid^="propertyCard-vrt-"]').length;
        return { isLastPage, cards };
      });

      if (!earlyExitCheck.isLastPage) {
        // Only simulate human behaviour if there are more pages to go
        await simulateHuman(page);
      } else {
        // Brief pause only
        await page.waitForTimeout(randomBetween(800, 1500));
      }

      // Uncomment to debug page state before extraction:
      // const pageState = await page.evaluate(() => ({
      //   cards: document.querySelectorAll('[data-testid^="propertyCard-vrt-"]').length,
      //   nextDisabled: document.querySelector('button[data-testid="nextPage"]')?.hasAttribute('disabled') ?? true,
      //   pages: document.querySelector('select[data-testid="paginationSelect"]')?.querySelectorAll('option').length ?? 0,
      //   title: document.title.substring(0, 50),
      // }));
      // console.log(`  [Rightmove] Debug —`, pageState);

      await simulateHuman(page);

      // Get total pages from pagination select on page 1
      if (pageNum === 1) {
        totalPages = await page.evaluate(() => {
          const select = document.querySelector('select[data-testid="paginationSelect"]');
          if (!select) return 1;
          return select.querySelectorAll('option').length;
        });
        console.log(`  [Rightmove] ${totalPages} page${totalPages !== 1 ? 's' : ''} of results`);
      }

      // No results check
      const noResults = await page.evaluate(() => {
        const hard = !!document.querySelector('.NoResults_noResultsContainer__O4ENc') ||
                     !!document.querySelector('h2[data-testid="no-results-heading"]');
        const noKw = Array.from(document.querySelectorAll('h3'))
          .some((h: any) => h.textContent?.includes('No properties matching keywords'));
        return { hard, noKw };
      });
      if (noResults.hard) { console.log('  [Rightmove] No properties match your search.'); break; }
      if (noResults.noKw)  { console.log('  [Rightmove] No properties match keyword filters.'); break; }

      // Extract cards
      const pageProperties: Property[] = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid^="propertyCard-vrt-"]'));
        return cards.map((card: any) => {
          const linkEl = card.querySelector('a.propertyCard-link');
          const href = linkEl?.getAttribute('href') ?? '';
          const idMatch = href.match(/\/properties\/(\d+)/);
          const id = idMatch ? idMatch[1] : '';
          const url = id ? `https://www.rightmove.co.uk/properties/${id}` : '';

          const priceEl = card.querySelector('.PropertyPrice_price__VL65t');
          const priceRaw = priceEl?.textContent?.trim() ?? '';
          const priceValue = parseInt(priceRaw.replace(/[^0-9]/g, '')) || 0;
          const qualifierEl = card.querySelector('.PropertyPrice_priceQualifier__U1Qu7');
          const priceQualifier = qualifierEl?.textContent?.trim() ?? '';

          const addressEl = card.querySelector('address.PropertyAddress_address__LYRPq');
          const address = addressEl?.getAttribute('aria-label')?.replace('Property address: ', '') ??
                          addressEl?.textContent?.trim() ?? '';

          const typeEl = card.querySelector('.PropertyInformation_propertyType__u8e76');
          const propertyType = typeEl?.textContent?.trim() ?? '';

          const bedsEl = card.querySelector('.PropertyInformation_bedroomsCount___2b5R');
          const bedrooms = bedsEl?.textContent?.trim() ?? '';

          const bathContainer = card.querySelector('.PropertyInformation_bathContainer__ut8VY');
          const bathsEl = bathContainer?.querySelector('span[aria-label]');
          const bathrooms = bathsEl?.getAttribute('aria-label')?.replace(' in property', '') ?? '';

          const agentLinkEl = card.querySelector('a[data-testid^="property-branch-logo-"]:not([data-testid*="mobile"])');
          const agent = agentLinkEl?.getAttribute('title') ?? '';

          const phoneEl = card.querySelector('a[data-testid="contact-agent-phone-number"] span:first-child');
          const agentPhone = phoneEl?.textContent?.trim() ?? '';

          const dateEl = card.querySelector('.MarketedBy_addedOrReduced__Vtc9o');
          const addedDate = dateEl?.textContent?.trim() ?? '';

          const premiumTagEl = card.querySelector('.PropertyPrice_premiumListingText___2yCl');
          const premiumTag = premiumTagEl?.textContent?.trim() ?? '';

          const fullText = card.textContent?.toLowerCase() ?? '';
          const noChain = fullText.includes('no chain');
          const isSstc = fullText.includes('sstc') || fullText.includes('sold stc') || fullText.includes('under offer');
          const isReduced = dateEl?.textContent?.toLowerCase().includes('reduced') ?? false;
          const isNewHome = fullText.includes('new home') || fullText.includes('new build');

          const tags: string[] = [];
          if (premiumTag) tags.push(premiumTag.toLowerCase());
          if (isReduced) tags.push('reduced');
          if (isNewHome) tags.push('new home');

          // Floor area
          const sqFtMatch = card.textContent?.match(/(\d[\d,]*)\s*sq\.?\s*ft/i);
          const floorArea = sqFtMatch ? `${sqFtMatch[1]} sq ft` : '';

          return {
            id, site: 'rightmove', address, price: priceRaw, priceValue, priceQualifier,
            bedrooms, bathrooms, reception: '', floorArea, propertyType,
            agent, agentPhone, url, noChain, isSstc, isReduced, isNewHome,
            addedDate, tags: [...new Set(tags)],
          };
        }).filter((p: any) => p.id !== '');
      });

      if (pageProperties.length === 0) break;
      properties.push(...pageProperties);
      console.log(`  [Rightmove] Page ${pageNum} — ${pageProperties.length} properties`);

      // Check if Next button is disabled — belt and braces for single/last page detection
      const nextDisabled = await page.evaluate(() => {
        const btn = document.querySelector('button[data-testid="nextPage"]');
        return !btn || btn.hasAttribute('disabled');
      });
      if (nextDisabled) break;

      if (pageNum >= totalPages) break;

      if (Math.random() < 0.4) {
        console.log(`  [Rightmove] Pausing briefly...`);
        await page.waitForTimeout(randomBetween(8000, 15000));
      } else {
        await page.waitForTimeout(randomBetween(4000, 8000));
      }

      pageIndex += 24;
      pageNum++;
    }

    console.log(`  [Rightmove] Complete — ${properties.length} properties`);
    return properties;

  } catch (err: any) {
    console.log(`  [Rightmove] ⚠ Error: ${err.message}`);
    return properties;
  }
}

// ─────────────────────────────────────────────
// ZOOPLA — BUILD SEARCH URL
// ─────────────────────────────────────────────

function buildZooplaUrl(params: any, pageNum = 1): string {
  const base = 'https://www.zoopla.co.uk/for-sale/property/london/';
  const p = new URLSearchParams();
  p.set('q', params.locationInput);
  p.set('search_source', 'for-sale');
  if (params.radius)    p.set('radius',       params.radius);
  if (params.minPrice)  p.set('price_min',    params.minPrice);
  if (params.maxPrice)  p.set('price_max',    params.maxPrice);
  if (params.minBeds)   p.set('beds_min',     params.minBeds);
  if (params.maxBeds)   p.set('beds_max',     params.maxBeds);
  if (params.minBaths)  p.set('baths_min',    params.minBaths);
  if (params.maxBaths)  p.set('baths_max',    params.maxBaths);
  if (params.sortZoopla) p.set('results_sort', params.sortZoopla);
  if (params.keywords.length > 0) p.set('keywords', params.keywords.join(' '));
  if (params.addedTimeZoopla) p.set('added', params.addedTimeZoopla);
  if (params.chainFree) p.set('chain_free', 'true');
  if (params.includeSstc) p.set('include_sold', 'true');

  if (params.tenure) {
    const tenureMap: Record<string, string> = {
      'freehold': 'freehold', 'leasehold': 'leasehold', 'share-of-freehold': 'share_of_freehold',
    };
    p.set('tenure', tenureMap[params.tenure] ?? params.tenure);
  }

  if (params.sharedOwnership === 'exclude')  p.set('is_shared_ownership', 'false');
  if (params.sharedOwnership === 'only')     p.set('is_shared_ownership', 'true');
  if (params.retirementHomes === 'exclude')  p.set('is_retirement_home', 'false');
  if (params.retirementHomes === 'only')     p.set('is_retirement_home', 'true');
  if (params.auction === 'exclude')          p.set('is_auction', 'false');
  if (params.auction === 'only')             p.set('is_auction', 'true');

  if (params.propertyTypes.length > 0) {
    const subTypeMap: Record<string, string> = {
      'detached': 'detached', 'semi-detached': 'semi-detached', 'terraced': 'terraced',
      'flat': 'flats', 'bungalow': 'bungalows', 'land': 'farms_land', 'park home': 'park_homes',
    };
    const subTypes = params.propertyTypes.map((t: string) => subTypeMap[t]).filter(Boolean).join(',');
    if (subTypes) p.set('property_sub_type', subTypes);
  }

  if (pageNum > 1) p.set('pn', String(pageNum));
  return `${base}?${p.toString()}`;
}

// ─────────────────────────────────────────────
// ZOOPLA — APPLY MUST-HAVES VIA UI (garden/parking/balcony only)
// ─────────────────────────────────────────────

async function applyZooplaMusthaves(page: any, params: any): Promise<string> {
  if (params.mustHaves.length === 0) return page.url();

  const filtersBtn = page.getByRole('button', { name: /^filters/i });
  if (!await filtersBtn.isVisible({ timeout: 3000 }).catch(() => false)) return page.url();

  await filtersBtn.click();
  await page.waitForTimeout(800);

  for (const mh of params.mustHaves) {
    const label = params.mustHaveMap[mh];
    if (!label) continue;
    const btn = page.getByLabel('Search bar').getByText(label, { exact: true })
      .or(page.getByText(label, { exact: true })).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(300);
    }
  }

  const applyBtn = page.getByTestId('apply-filters');
  if (await applyBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await applyBtn.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await page.waitForTimeout(randomBetween(1200, 2000));
  }

  return page.url();
}

// ─────────────────────────────────────────────
// ZOOPLA — SCRAPE
// ─────────────────────────────────────────────

async function scrapeZoopla(page: any, params: any): Promise<Property[]> {
  const properties: Property[] = [];
  let pageNum = 1;
  let totalPages = 1;

  try {
    // Warm up Zoopla domain first so cookies are active before we hit the search URL
    const url = buildZooplaUrl(params, 1);
    console.log(`  [Zoopla] Page 1...`);
    await page.goto('https://www.zoopla.co.uk/for-sale/property/london/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(randomBetween(1000, 1500));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(randomBetween(2500, 4000));

    // await page.pause(); // Uncomment to pause for manual CAPTCHA solving if needed

    // Handle Cloudflare Turnstile if present
    const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
    const turnstileBody = turnstileFrame.locator('body');
    if (await turnstileBody.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log('  ⚠  Cloudflare CAPTCHA detected — please solve it in the browser window.');
      console.log('  ⚠  Waiting up to 30 seconds...');
      await page.waitForFunction(
        () => !document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        { timeout: 30000 }
      ).catch(() => console.log('  ⚠  Continuing anyway...'));
      await page.waitForTimeout(1000);
    }

    // Dismiss consent overlays
    const acceptBtn = page.getByRole('button', { name: /accept all/i });
    if (await acceptBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await acceptBtn.click();
      await page.waitForTimeout(600);
    }
    const ucAccept = page.locator('#usercentrics-cmp-ui')
      .getByRole('button', { name: /accept|save|confirm/i }).first();
    if (await ucAccept.isVisible({ timeout: 2000 }).catch(() => false)) {
      await ucAccept.click();
      await page.waitForTimeout(600);
    }
    await page.waitForSelector('#usercentrics-cmp-ui', { state: 'hidden', timeout: 4000 }).catch(() => {});

    // Apply must-haves via UI if needed
    if (params.mustHaves.length > 0) {
      await applyZooplaMusthaves(page, params);
    }

    while (true) {
      await simulateHuman(page);

      // Check for no results
      const noResults = await page.evaluate(() => {
        return !!document.querySelector('.NoResultsBanner_card__JGjrp') ||
               !!document.querySelector('[data-testid="no-results"]');
      });
      if (noResults) { console.log('  [Zoopla] No results.'); break; }

      // Wait for total results element and get pagination info on page 1
      await page.waitForSelector('[data-testid="total-results"]', { timeout: 5000 }).catch(() => {});
      const pageInfo = await page.evaluate(() => {
        const totalEl = document.querySelector('[data-testid="total-results"]');
        const listingCount = document.querySelectorAll('[data-testid="regular-listings"] [id^="listing_"]').length;
        const totalText = totalEl?.textContent?.trim() ?? 'not found';
        const totalCount = parseInt(totalText.replace(/[^0-9]/g, '')) || 0;
        return { totalCount, listingCount };
      });
      // console.log(`  [Zoopla] Page ${pageNum} debug — total: ${pageInfo.totalCount}, cards: ${pageInfo.listingCount}`);

      if (pageNum === 1 && pageInfo.listingCount > 0) {
        const perPage = pageInfo.listingCount;
        totalPages = Math.min(Math.ceil(pageInfo.totalCount / perPage), 100);
        console.log(`  [Zoopla] ${pageInfo.totalCount} results · ${totalPages} pages`);
      }

      if (pageInfo.listingCount === 0) break;

      // Extract listings
      const pageProperties: Property[] = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="regular-listings"] [id^="listing_"]'));
        return rows.map((row: any) => {
          const id = row.id.replace('listing_', '');
          const linkEl = row.querySelector('a[data-testid="listing-card-content"]');
          const href = linkEl?.getAttribute('href') ?? '';
          const url = href ? `https://www.zoopla.co.uk${href.split('?')[0]}` : '';

          const priceEl = row.querySelector('.price_priceText__TArfK');
          const priceRaw = priceEl?.textContent?.trim() ?? '';
          const priceValue = parseInt(priceRaw.replace(/[^0-9]/g, '')) || 0;
          const qualifierEl = row.querySelector('.price_priceTitle__lmVR9');
          const priceQualifier = qualifierEl?.textContent?.trim() ?? '';

          const addressEl = row.querySelector('address.summary_address__Y3xS6');
          const address = addressEl?.textContent?.trim() ?? '';

          const amenities = Array.from(row.querySelectorAll('.amenities_amenityItemSlim__CPhtG'))
            .map((el: any) => el.textContent?.trim() ?? '');

          const bedrooms  = amenities.find((a: string) => a.includes('bed'))      ?? '';
          const bathrooms = amenities.find((a: string) => a.includes('bath'))     ?? '';
          const reception = amenities.find((a: string) => a.includes('reception')) ?? '';
          const floorArea = amenities.find((a: string) => a.includes('sq ft') || a.includes('sq')) ?? '';

          const agentImgEl = row.querySelector('img.agent-logo_agentLogoImageSlim__vSUb2');
          const agent = agentImgEl?.getAttribute('alt') ?? '';

          const badges = Array.from(row.querySelectorAll('.badges_badgesListSlim__WE_Gn .ikxlt80'))
            .map((el: any) => el.textContent?.trim().toLowerCase() ?? '');
          const statusBadges = Array.from(row.querySelectorAll('.status_statusListSlim__JGNUs .ikxlt80'))
            .map((el: any) => el.textContent?.trim().toLowerCase() ?? '');
          const allBadges = [...badges, ...statusBadges];

          const noChain  = allBadges.some(b => b.includes('chain free'));
          const isSstc   = allBadges.some(b => b.includes('under offer') || b.includes('sold stc'));
          const isReduced = allBadges.some(b => b.includes('reduced'));
          const isNewHome = allBadges.some(b => b.includes('new home'));

          const addedDate = statusBadges.find(b =>
            b.includes('added') || b.includes('reduced') || b.includes('just')
          ) ?? '';

          const propertyType = '';

          const tags: string[] = [];
          if (isReduced) tags.push('reduced');
          if (isNewHome) tags.push('new home');
          const ownership = badges.find(b => b.includes('leasehold') || b.includes('freehold') || b.includes('share'));
          if (ownership) tags.push(ownership);

          return {
            id, site: 'zoopla', address, price: priceRaw, priceValue, priceQualifier,
            bedrooms, bathrooms, reception, floorArea, propertyType,
            agent, agentPhone: '', url, noChain, isSstc, isReduced, isNewHome,
            addedDate, tags,
          };
        }).filter((p: any) => p.id !== '');
      });

      if (pageProperties.length === 0) break;
      properties.push(...pageProperties);
      console.log(`  [Zoopla] +${pageProperties.length} properties`);

      if (pageNum >= totalPages) break;

      if (Math.random() < 0.4) {
        console.log(`  [Zoopla] Pausing briefly...`);
        await page.waitForTimeout(randomBetween(8000, 15000));
      } else {
        await page.waitForTimeout(randomBetween(4000, 8000));
      }

      pageNum++;
      const nextUrl = buildZooplaUrl(params, pageNum);
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(randomBetween(2500, 4000));
      console.log(`  [Zoopla] Page ${pageNum}...`);
    }

    console.log(`  [Zoopla] Complete — ${properties.length} properties`);
    return properties;

  } catch (err: any) {
    console.log(`  [Zoopla] ⚠ Error: ${err.message}`);
    return properties;
  }
}

// ─────────────────────────────────────────────
// HTML REPORT
// ─────────────────────────────────────────────

function generateReport(
  allProperties: Property[],
  params: any,
  seenProperties: Set<string>,
  sitesScraped: Site[]
): string {
  const today = new Date().toLocaleDateString('en-GB');

  // Site badge colours
  const siteBadge: Record<Site, string> = {
    rightmove: '#004f9f',
    zoopla:    '#7b2d8b',
  };
  const siteLabel: Record<Site, string> = {
    rightmove: 'Rightmove',
    zoopla:    'Zoopla',
  };

  // Identify within-run duplicates (same site only — cross-site same property is marked separately)
  const seenThisRun = new Map<string, number>(); // siteId -> first occurrence index
  allProperties.forEach((p, i) => {
    const key = seenKey(p);
    if (!seenThisRun.has(key)) seenThisRun.set(key, i);
  });
  const dupIds = new Set<string>();
  const tempSeen = new Set<string>();
  allProperties.forEach(p => {
    const key = seenKey(p);
    if (tempSeen.has(key)) dupIds.add(key);
    tempSeen.add(key);
  });

  // Cross-site duplicate detection — same address + similar price (within 2%)
  const addressPriceMap = new Map<string, Property[]>();
  allProperties.forEach(p => {
    const normAddress = p.address.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!addressPriceMap.has(normAddress)) addressPriceMap.set(normAddress, []);
    addressPriceMap.get(normAddress)!.push(p);
  });
  const crossSiteDupIds = new Set<string>();
  addressPriceMap.forEach((props) => {
    if (props.length > 1) {
      const sites = new Set(props.map(p => p.site));
      if (sites.size > 1) {
        // Same address on multiple sites — mark all but first as cross-site dup
        props.slice(1).forEach(p => crossSiteDupIds.add(seenKey(p)));
      }
    }
  });

  function clusterByAgent(list: Property[]): Property[] {
    const out: Property[] = [];
    const used = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      if (used.has(seenKey(list[i]))) continue;
      out.push(list[i]);
      used.add(seenKey(list[i]));
      const agentKey = list[i].agent.toLowerCase();
      const basePrice = list[i].priceValue;
      if (agentKey) {
        for (let j = i + 1; j < Math.min(i + 9, list.length); j++) {
          if (used.has(seenKey(list[j]))) continue;
          if (list[j].agent.toLowerCase() !== agentKey) continue;
          if (basePrice > 0 && list[j].priceValue > 0) {
            const ratio = Math.max(basePrice, list[j].priceValue) / Math.min(basePrice, list[j].priceValue);
            if (ratio > 1.2) continue;
          }
          out.push(list[j]);
          used.add(seenKey(list[j]));
        }
      }
    }
    return out;
  }

  // Classify
  const noChainProps:  Property[] = [];
  const mainProps:     Property[] = [];
  const sstcProps:     Property[] = [];
  const dupProps:      Property[] = [];

  let globalIndex = 0;

  allProperties.forEach(p => {
    const key = seenKey(p);
    const isPrevSeen  = seenProperties.has(key);
    const isDup       = !isPrevSeen && dupIds.has(key);
    const isCrossDup  = crossSiteDupIds.has(key);
    if (isDup || isPrevSeen || isCrossDup) {
      dupProps.push(p);
    } else if (p.noChain) {
      noChainProps.push(p);
    } else if (p.isSstc) {
      sstcProps.push(p);
    } else {
      mainProps.push(p);
    }
  });

  // Sort each section by price ascending (unified across both sites)
  // Properties with no price value (POA) go to the end
  const byPrice = (a: Property, b: Property) => {
    if (a.priceValue === 0 && b.priceValue === 0) return 0;
    if (a.priceValue === 0) return 1;
    if (b.priceValue === 0) return -1;
    return a.priceValue - b.priceValue;
  };
  noChainProps.sort(byPrice);
  mainProps.sort(byPrice);
  sstcProps.sort(byPrice);
  dupProps.sort(byPrice);

  function renderCard(p: Property, opacity = '1'): string {
    globalIndex++;
    const key = seenKey(p);
    const isPrevSeen  = seenProperties.has(key);
    const isDup       = !isPrevSeen && dupIds.has(key);
    const isCrossDup  = crossSiteDupIds.has(key);

    let badges = '';
    // Site badge always first
    badges += `<a href="${p.url}" style="background:${siteBadge[p.site]};color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;text-decoration:none;">${siteLabel[p.site]}</a>`;
    if (isPrevSeen) badges += '<span style="background:#e67e22;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;">SEEN BEFORE</span>';
    else if (isDup)       badges += '<span style="background:#8e44ad;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;">DUPLICATE</span>';
    else if (isCrossDup)  badges += '<span style="background:#8e44ad;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;">DUPLICATE</span>';
    if (p.noChain) badges += '<span style="background:#27ae60;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;">NO CHAIN</span>';
    if (p.isSstc)  badges += '<span style="background:#95a5a6;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.75rem;margin-right:6px;">SSTC</span>';

    const priceDisplay = p.priceQualifier ? `${p.priceQualifier} ${p.price}` : p.price || 'POA';

    const detailParts = [
      p.bedrooms    ? `🛏 ${p.bedrooms}`    : '',
      p.bathrooms   ? `🚿 ${p.bathrooms}`   : '',
      p.reception   ? `🛋 ${p.reception}`   : '',
      p.floorArea   ? `📐 ${p.floorArea}`   : '',
      p.propertyType ? p.propertyType       : '',
      ...p.tags.map(t =>
        `<span style="background:#eaf4fb;color:#2980b9;padding:1px 5px;border-radius:3px;font-size:0.75rem;">${t}</span>`
      ),
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');

    return `
      <div style="margin:6px 0;padding:7px 11px;border:1px solid #eee;border-radius:5px;opacity:${opacity};line-height:1.4;">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
          <span style="color:#999;font-size:0.8rem;">${globalIndex}.</span>
          ${badges}
          <a href="${p.url}" style="font-weight:600;font-size:0.95rem;color:#1a1a1a;text-decoration:none;"
             onmouseover="this.style.textDecoration='underline'"
             onmouseout="this.style.textDecoration='none'">${p.address || '(no address)'}</a>
          <span style="font-weight:bold;color:#c0392b;font-size:0.95rem;white-space:nowrap;">${priceDisplay}</span>
        </div>
        ${detailParts ? `<div style="color:#666;font-size:0.8rem;margin-top:2px;">${detailParts}</div>` : ''}
        <div style="color:#999;font-size:0.75rem;margin-top:2px;">
          ${p.agent     ? `<span>${p.agent}</span>`                                                           : ''}
          ${p.agentPhone ? `<span style="margin-left:10px;">📞 ${p.agentPhone}</span>`                       : ''}
          ${p.addedDate  ? `<span style="margin-left:10px;">${p.addedDate}</span>`                            : ''}
          <a href="${p.url}" style="margin-left:10px;color:#2980b9;font-size:0.75rem;">${p.url}</a>
        </div>
      </div>`;
  }

  function renderSection(list: Property[], heading: string, borderColor: string, opacity = '1'): string {
    if (!list.length) return '';
    const clustered = clusterByAgent(list);
    return `
      <div style="margin-top:1.75rem;">
        <h3 style="border-bottom:2px solid ${borderColor};padding-bottom:0.4rem;margin-bottom:0.5rem;">${heading}</h3>
        <p style="color:#888;font-size:0.8rem;margin-bottom:0.5rem;">${list.length} listing${list.length !== 1 ? 's' : ''}</p>
        ${clustered.map(p => renderCard(p, opacity)).join('')}
      </div>`;
  }

  let sections = '';
  sections += renderSection(noChainProps, '⛓️ No Chain', '#27ae60');

  const clustered = clusterByAgent(mainProps);
  if (clustered.length) {
    sections += `
      <div style="margin-top:1.75rem;">
        <p style="color:#888;font-size:0.8rem;margin-bottom:0.5rem;">${clustered.length} listing${clustered.length !== 1 ? 's' : ''}</p>
        ${clustered.map(p => renderCard(p)).join('')}
      </div>`;
  }

  sections += renderSection(sstcProps,  'Under Offer / Sold STC', '#95a5a6', '0.45');
  sections += renderSection(dupProps,   'Duplicates',              '#8e44ad', '0.45');

  const totalActive = noChainProps.length + mainProps.length;

  const siteNames = sitesScraped.map(s => siteLabel[s]).join(' + ');

  const paramSummary = [
    `📍 ${params.locationInput}`,
    params.radius !== '0' ? `within ${params.radius} mile${params.radius === '1' ? '' : 's'}` : 'this area only',
    params.minPrice && params.maxPrice
      ? `£${Number(params.minPrice).toLocaleString()} – £${Number(params.maxPrice).toLocaleString()}`
      : params.minPrice ? `from £${Number(params.minPrice).toLocaleString()}`
      : params.maxPrice ? `up to £${Number(params.maxPrice).toLocaleString()}` : '',
    params.minBeds || params.maxBeds ? `${params.minBeds || 'any'}–${params.maxBeds || 'any'} beds` : '',
    params.propertyTypes.length > 0 ? params.propertyTypes.join(', ') : '',
    params.tenure || '',
    params.chainFree ? 'chain free' : '',
    params.mustHaves.length > 0 ? `must have: ${params.mustHaves.join(', ')}` : '',
    params.keywords.length > 0 ? `keywords: ${params.keywords.join(', ')}` : '',
    params.addedTimeZoopla ? `listed within ${(params.addedOptions[params.addedTimeZoopla] ?? '').toLowerCase()}` : '',
    params.includeSstc ? 'including SSTC' : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Property Scraper${sitesScraped.length === 1 ? ' — ' + siteLabel[sitesScraped[0]] : ''} — ${params.locationInput}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.5; }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h3 { font-size: 1rem; margin-bottom: 0.25rem; }
    a { color: #2980b9; }
  </style>
</head>
<body>
  <h1>Property Scraper${sitesScraped.length === 1 ? ' — ' + siteLabel[sitesScraped[0]] : ''} — ${params.locationInput}</h1>
  <p style="color:#666;font-size:0.85rem;">
    ${today} &middot; ${allProperties.length} propert${allProperties.length !== 1 ? 'ies' : 'y'} found
    &middot; ${totalActive} active &middot; sorted by ${params.sortLabel}
    &middot; scraped from ${siteNames}
    ${noChainProps.length ? `&middot; <strong style="color:#27ae60;">${noChainProps.length} no chain</strong>` : ''}
    ${sstcProps.length    ? `&middot; <span style="color:#95a5a6;">${sstcProps.length} SSTC</span>` : ''}
    ${dupProps.length     ? `&middot; <span style="color:#8e44ad;">${dupProps.length} duplicate${dupProps.length !== 1 ? 's' : ''}</span>` : ''}
  </p>
  <p style="color:#888;font-size:0.8rem;">${paramSummary}</p>
  <p style="font-size:0.8rem;color:#888;margin-top:0.75rem;">
    <a href="#" style="background:#004f9f;color:#fff;padding:1px 5px;border-radius:3px;text-decoration:none;">Rightmove</a>
    <a href="#" style="background:#7b2d8b;color:#fff;padding:1px 5px;border-radius:3px;text-decoration:none;margin-left:4px;">Zoopla</a>
    &nbsp;= source site &nbsp;
    <span style="background:#27ae60;color:#fff;padding:1px 5px;border-radius:3px;">NO CHAIN</span> = no onward chain &nbsp;
    <span style="background:#95a5a6;color:#fff;padding:1px 5px;border-radius:3px;">SSTC</span> = under offer or sold STC &nbsp;
    <span style="background:#e67e22;color:#fff;padding:1px 5px;border-radius:3px;">SEEN BEFORE</span> = appeared in a previous run &nbsp;
    <span style="background:#8e44ad;color:#fff;padding:1px 5px;border-radius:3px;">DUPLICATE</span> = appeared more than once this run
  </p>
  <hr style="margin:1.5rem 0;border:none;border-top:1px solid #eee;">
  ${sections || '<p style="color:#888;">No properties found.</p>'}
</body>
</html>`;
}

// ─────────────────────────────────────────────
// RESULTS FILENAME
// ─────────────────────────────────────────────

function resultsFile(location: string, sites: Site[]): string {
  const slug = location.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const date = new Date().toISOString().slice(0, 10);
  const siteSlug = sites.length === 1 ? `-${sites[0]}` : '';
  return `results-property${siteSlug}-${slug}-${date}.html`;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

(async () => {
  printBanner();

  // ── Step 1: Collect params ──
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const params = await getSearchParams(rl);
  rl.close();

  // ── Step 2: Open browser ──
  console.log('\n  Opening browser...');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-http2',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: randomViewport(),
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    extraHTTPHeaders: { 'Accept-Language': 'en-GB,en;q=0.9' },
  });

  // Load cookies — try Rightmove and Zoopla cookie files
  const cookieFiles = ['rightmove-cookies.json', 'zoopla-cookies.json'];
  for (const cf of cookieFiles) {
    if (fs.existsSync(cf)) {
      try {
        const rawCookies = JSON.parse(fs.readFileSync(cf, 'utf-8'));
        const cookies = rawCookies.map((c: any) => ({
          ...c,
          sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
        }));
        await context.addCookies(cookies);
        console.log(`  ✓  Loaded ${cookies.length} cookies from ${cf}`);
      } catch (err: any) {
        console.log(`  ⚠  Could not load cookies from ${cf}: ${err.message}`);
      }
    }
  }

  const page = await context.newPage();
  await applyFingerprint(page);

  // ── Step 3: Scrape each site ──
  const allProperties: Property[] = [];
  const seenProperties = loadSeenProperties();

  try {
    if (params.sites.includes('rightmove')) {
      console.log('\n🏠 Scraping Rightmove...');
      const locationResult = await resolveRightmoveLocation(page, params.locationInput);
      if (locationResult) {
        const rmProps = await scrapeRightmove(page, params, locationResult.locationIdentifier);
        allProperties.push(...rmProps);
      } else {
        console.log('  ⚠  Rightmove location could not be resolved — skipping.');
      }
    }

    if (params.sites.includes('zoopla')) {
      console.log('\n🏠 Scraping Zoopla...');
      const zpProps = await scrapeZoopla(page, params);
      allProperties.push(...zpProps);
    }

  } finally {
    // await page.pause(); // Uncomment to inspect final page state before browser closes
    await browser.close();

    // ── Step 4: Generate report ──
    const html = generateReport(allProperties, params, seenProperties, params.sites);

    const newSeen = new Set(seenProperties);
    allProperties.forEach(p => newSeen.add(seenKey(p)));
    saveSeenProperties(newSeen);

    const outFile = resultsFile(params.locationInput, params.sites);
    fs.writeFileSync(outFile, html);

    console.log(`\n🎉 Results saved to ${outFile}`);
    console.log(`🏠 ${allProperties.length} propert${allProperties.length !== 1 ? 'ies' : 'y'} found`);
    console.log(`📁 Seen properties updated — ${newSeen.size} total tracked`);
  }
})();
