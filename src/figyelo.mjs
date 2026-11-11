#!/usr/bin/env node
// WordPress figyelő
// Megnyitja a beállított oldalakat több képernyőméretben, hibákat keres
// (elrendezés, betöltési hibák, JS-hibák, PHP/WordPress hibaüzenetek),
// összeveti a képernyőképet egy elfogadott alapállapottal, és riaszt.
//
// Futtatás:
//   node src/figyelo.mjs                 ellenőrzés
//   node src/figyelo.mjs --alapallapot   az aktuális állapot elfogadása alapállapotnak
//
// Környezeti változók (mind opcionális):
//   NTFY_TOPIC, NTFY_SERVER   push értesítés az ntfy alkalmazásba
//   SLACK_WEBHOOK_URL         Slack üzenet
//   CHROMIUM_PATH             saját böngésző útvonala (helyi teszteléshez)
//   FIGYELO_CONFIG            másik beállítófájl útvonala

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const ROOT = process.cwd();
const BASELINE_MODE = process.argv.includes('--alapallapot');
const CONFIG_PATH = process.env.FIGYELO_CONFIG || path.join(ROOT, 'config.json');
const BASELINE_DIR = path.join(ROOT, 'alapallapot');
const BASELINE_FILE = path.join(BASELINE_DIR, 'alapallapot.json');
const REPORT_DIR = path.join(ROOT, 'riport');
const IMG_DIR = path.join(REPORT_DIR, 'kepek');
const STATE_DIR = path.join(ROOT, 'allapot');
const STATE_FILE = path.join(STATE_DIR, 'allapot.json');

const SEVERITY_RANK = { kritikus: 3, hiba: 2, figyelmeztetes: 1, info: 0 };
const SEVERITY_LABEL = { kritikus: 'KRITIKUS', hiba: 'HIBA', figyelmeztetes: 'figyelmeztetés', info: 'info' };

const UA_DESKTOP = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 WPFigyelo/1.0';
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 WPFigyelo/1.0';

const DEFAULTS = {
  nev: 'WordPress oldal',
  oldalak: [{ nev: 'fooldal', utvonal: '/' }],
  nezetek: [
    { nev: 'asztali', szelesseg: 1440, magassag: 900 },
    { nev: 'mobil', szelesseg: 375, magassag: 812, mobil: true },
  ],
  elemek: { fejlec: 'header', lablec: 'footer', szekcio: null },
  elrejtendo: [],
  maszkolando: [],
  blokkolt: [],
  hatarertekek: {
    kepElteresSzazalek: 3,
    kilogasPx: 2,
    lassuMs: 8000,
    nagyonLassuMs: 20000,
    fejlecValtozas: 0.4,
    oldalmagassagFigyelmeztetes: 0.5,
    oldalmagassagHiba: 1.5,
  },
  riasztas: { szintek: ['kritikus', 'hiba'], megerosites: { kritikus: 1, hiba: 2 }, ujraRiasztasOra: 12 },
  hibaSzovegek: [],
  figyelmenKivul: { url: [], konzol: [] },
};

// ---------------------------------------------------------------- segédek

function loadConfig() {
  const raw = JSON.parse(fss.readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw };
  cfg.elemek = { ...DEFAULTS.elemek, ...(raw.elemek || {}) };
  cfg.hatarertekek = { ...DEFAULTS.hatarertekek, ...(raw.hatarertekek || {}) };
  cfg.riasztas = { ...DEFAULTS.riasztas, ...(raw.riasztas || {}) };
  cfg.riasztas.megerosites = { ...DEFAULTS.riasztas.megerosites, ...(raw.riasztas?.megerosites || {}) };
  cfg.figyelmenKivul = { ...DEFAULTS.figyelmenKivul, ...(raw.figyelmenKivul || {}) };
  if (!cfg.alapUrl) throw new Error('A config.json-ból hiányzik az "alapUrl".');
  cfg.alapUrl = cfg.alapUrl.replace(/\/+$/, '');
  cfg._host = new URL(cfg.alapUrl).host;
  cfg._errorRegexes = cfg.hibaSzovegek.map((s) => new RegExp(s, 'i'));
  return cfg;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fss.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripQuery = (u) => String(u).split('#')[0].split('?')[0];
const shortUrl = (u, cfg) => stripQuery(u).replace(cfg.alapUrl, '').replace(/^https?:\/\//, '') || '/';
const normalize = (s) => String(s).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
const matchesAny = (text, patterns) => patterns.some((p) => String(text).includes(p));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pageUrl(cfg, pg) {
  const p = pg.utvonal.startsWith('/') ? pg.utvonal : '/' + pg.utvonal;
  return cfg.alapUrl + p;
}

async function gotoWithRetry(page, url) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      if (resp && resp.status() >= 500 && attempt === 1) { await sleep(10000); continue; }
      return resp;
    } catch (e) {
      lastErr = e;
      if (attempt === 1) await sleep(10000);
    }
  }
  throw lastErr;
}

// Végiggörget az oldalon, hogy a később betöltődő (lazy) képek és animációk lefussanak.
async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let i = 0; i < 80; i++) {
      const before = window.scrollY;
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 150));
      if (window.scrollY === before) break;
    }
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.evaluate(async () => {
    const pending = [...document.images].filter((i) => !i.complete && i.loading !== 'lazy');
    await Promise.race([
      Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
    if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
    window.scrollTo(0, 0);
  });
  await sleep(1000);
}

// A böngészőben fut: elrendezés-ellenőrzések és "ujjlenyomat".
function domProbe({ tol, patterns, sel }) {
  const de = document.documentElement;
  const vw = de.clientWidth; // mobilnézetben az innerWidth a kilógó tartalommal együtt nő
  const describe = (e) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    const cls = [...e.classList].filter((c) => !/\d/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const clipped = (e) => {
    for (let p = e.parentElement; p && p !== document.body && p !== de; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') return true;
    }
    return false;
  };

  // 1. Vízszintes kilógás
  const overflowPx = Math.max(0, de.scrollWidth - de.clientWidth);
  const culprits = [];
  if (overflowPx > tol) {
    const isOver = (e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.right > vw + tol || r.left < -tol);
    };
    for (const e of document.body.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (!isOver(e)) continue;
      const p = e.parentElement;
      if (p && p !== document.body && isOver(p)) continue;
      if (clipped(e)) continue;
      const r = e.getBoundingClientRect();
      culprits.push({ el: describe(e), text: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40), right: Math.round(r.right), left: Math.round(r.left) });
      if (culprits.length >= 5) break;
    }
  }

  // 2. Törött képek
  const brokenImages = [...document.images]
    .filter((i) => {
      const src = i.currentSrc || i.src;
      if (!src || src.startsWith('data:')) return false;
      const cs = getComputedStyle(i);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      return i.complete && i.naturalWidth === 0;
    })
    .map((i) => i.currentSrc || i.src);

  // 3. Hibaszövegek
  const text = document.body ? document.body.innerText : '';
  const errorTexts = [];
  for (const p of patterns) {
    const m = text.match(new RegExp(p, 'i'));
    if (m) errorTexts.push(m[0].slice(0, 200));
  }

  // 4. Betűtípusok
  const failedFonts = document.fonts ? [...new Set([...document.fonts].filter((f) => f.status === 'error').map((f) => f.family.replace(/["']/g, '')))] : [];

  // 5. Ujjlenyomat
  const box = (s) => {
    const e = s ? document.querySelector(s) : null;
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: Math.round(r.width), h: Math.round(r.height), visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 };
  };
  // A saját domainről ténylegesen betöltött (nem üres) CSS-fájlok száma; a beágyazott <style> blokkok száma ingadozhat
  const cssFiles = [...document.styleSheets].filter((s) => {
    try { return s.href && new URL(s.href).host === location.host && s.cssRules.length > 0; } catch { return false; }
  }).length;
  const heading = document.querySelector('h1, h2, h3');
  const fingerprint = {
    docHeight: de.scrollHeight,
    bodyFont: document.body ? getComputedStyle(document.body).fontFamily : null,
    headingFont: heading ? getComputedStyle(heading).fontFamily : null,
    header: box(sel.fejlec),
    footer: box(sel.lablec),
    sections: sel.szekcio ? document.querySelectorAll(sel.szekcio).length : null,
    cssFiles,
    title: document.title,
  };

  const nav = performance.getEntriesByType('navigation')[0];
  const loadMs = nav ? Math.round(nav.loadEventEnd || nav.duration) : null;

  return { overflowPx, culprits, brokenImages, errorTexts, failedFonts, fingerprint, loadMs };
}

function comparePng(aBuf, bBuf, diffPath) {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  if (a.width !== b.width || a.height !== b.height) return { percent: 100, sizeMismatch: true };
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const percent = (n / (a.width * a.height)) * 100;
  if (percent > 0.5 && diffPath) fss.writeFileSync(diffPath, PNG.sync.write(diff));
  return { percent };
}

// ---------------------------------------------------------- egy oldal, egy nézet

async function checkOne(context, cfg, pg, vp, baseline) {
  const id = `${pg.nev}|${vp.nev}`;
  const file = `${pg.nev}-${vp.nev}`;
  const url = pageUrl(cfg, pg);
  const findings = [];
  const result = { id, oldal: pg.nev, nezet: vp.nev, url, kep: null, diff: null, teljes: null, elteres: null, betoltesMs: null, ujAlapallapot: false };
  const add = (severity, type, message, keyDetail = '') => {
    findings.push({ severity, type, oldal: pg.nev, nezet: vp.nev, url, message, key: [pg.nev, vp.nev, type, normalize(keyDetail)].join('|') });
  };

  let page;
  try {
    page = await context.newPage();
  } catch (e) {
    await Promise.race([context.close().catch(() => {}), sleep(5000)]);
    throw e;
  }
  const net = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on('response', (r) => {
    if (r.status() >= 400) net.push({ url: r.url(), status: r.status(), type: r.request().resourceType() });
  });
  page.on('requestfailed', (req) => {
    const err = req.failure()?.errorText || '';
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|NS_BINDING_ABORTED/.test(err)) return;
    net.push({ url: req.url(), status: 0, type: req.resourceType(), error: err });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/^Failed to load resource/.test(t)) return; // ezt a hálózati ellenőrzés már jelzi
    consoleErrors.push(t);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)));

  try {
    let resp;
    try {
      resp = await gotoWithRetry(page, url);
    } catch (e) {
      add('kritikus', 'elerhetoseg', `Az oldal nem tölthető be: ${String(e.message).split('\n')[0]}`, 'nem-toltheto-be');
      return { findings, result };
    }
    const status = resp ? resp.status() : 0;
    result.statusz = status;
    if (status >= 400) add('kritikus', 'elerhetoseg', `Az oldal hibakódot ad vissza: HTTP ${status}`, `http-${status}`);

    const finalHost = new URL(page.url()).host;
    if (finalHost !== cfg._host) add('kritikus', 'atiranyitas', `Az oldal idegen domainre irányít át: ${page.url()} (feltört oldal jele lehet!)`, finalHost);

    await autoScroll(page);

    const css = [];
    if (cfg.elrejtendo.length) css.push(`${cfg.elrejtendo.join(', ')} { display: none !important; }`);
    css.push('*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }');
    await page.addStyleTag({ content: css.join('\n') }).catch(() => {});
    await sleep(300);

    const probe = await page.evaluate(domProbe, { tol: cfg.hatarertekek.kilogasPx, patterns: cfg.hibaSzovegek, sel: cfg.elemek });
    result.betoltesMs = probe.loadMs;
    result.ujjlenyomat = probe.fingerprint;

    // Hibaszövegek
    for (const t of probe.errorTexts) add('kritikus', 'hibaszoveg', `Hibaüzenet az oldalon: „${t}”`, t);

    // Kilógás
    if (probe.overflowPx > cfg.hatarertekek.kilogasPx) {
      const c = probe.culprits[0];
      const who = c ? `${c.el}${c.text ? ` („${c.text}”)` : ''}` : 'ismeretlen elem';
      add('hiba', 'kilogas', `Vízszintesen ${probe.overflowPx} px-szel kilóg az oldal, ezért oldalra görgethető. Okozója: ${who}`, c ? c.el : 'ismeretlen');
    }

    // Törött képek (a hálózati hibakóddal együtt, hogy ne legyen kétszer jelentve)
    const brokenSet = new Set(probe.brokenImages.map(stripQuery));
    for (const src of probe.brokenImages) {
      const hit = net.find((r) => stripQuery(r.url) === stripQuery(src));
      const why = hit ? ` (${hit.status ? `HTTP ${hit.status}` : hit.error})` : '';
      add('hiba', 'torott-kep', `Nem jelenik meg egy kép${why}: ${shortUrl(src, cfg)}`, stripQuery(src));
    }

    // Betűtípus
    for (const f of probe.failedFonts) add('hiba', 'betutipus', `Nem töltődött be a betűtípus: ${f}`, f);

    // Hálózat
    const seen = new Set();
    for (const r of net) {
      if (matchesAny(r.url, cfg.figyelmenKivul.url) || (r.error && matchesAny(r.error, cfg.figyelmenKivul.url))) continue;
      if (r.type === 'document' && stripQuery(r.url) === stripQuery(url)) continue; // fentebb már kezeltük
      const k = stripQuery(r.url);
      if (seen.has(k) || brokenSet.has(k)) continue;
      seen.add(k);
      let host = '';
      try { host = new URL(r.url).host; } catch {}
      const own = host === cfg._host;
      const what = r.status ? `HTTP ${r.status}` : r.error;
      const label = { stylesheet: 'Stíluslap (CSS)', script: 'JavaScript-fájl', image: 'Kép', font: 'Betűtípus', fetch: 'Adatlekérés', xhr: 'Adatlekérés', document: 'Beágyazott oldal' }[r.type] || 'Erőforrás';
      let sev = 'figyelmeztetes';
      if (own) sev = r.type === 'stylesheet' ? 'kritikus' : ['script', 'image', 'font', 'fetch', 'xhr', 'document'].includes(r.type) ? 'hiba' : 'figyelmeztetes';
      add(sev, 'eroforras', `${label} nem töltődött be (${what}): ${own ? shortUrl(r.url, cfg) : stripQuery(r.url)}`, k);
    }

    // JavaScript
    for (const e of [...new Set(pageErrors)]) {
      if (matchesAny(e, cfg.figyelmenKivul.konzol)) continue;
      add('hiba', 'js-hiba', `JavaScript-hiba: ${e.slice(0, 200)}`, e);
    }
    for (const e of [...new Set(consoleErrors)]) {
      if (matchesAny(e, cfg.figyelmenKivul.konzol)) continue;
      add('figyelmeztetes', 'konzol', `Konzolhiba: ${e.slice(0, 200)}`, e);
    }

    // Betöltési idő
    if (probe.loadMs != null) {
      if (probe.loadMs > cfg.hatarertekek.nagyonLassuMs) add('hiba', 'lassu', `Nagyon lassú betöltés: ${(probe.loadMs / 1000).toFixed(1)} mp`, 'nagyon-lassu');
      else if (probe.loadMs > cfg.hatarertekek.lassuMs) add('figyelmeztetes', 'lassu', `Lassú betöltés: ${(probe.loadMs / 1000).toFixed(1)} mp`, 'lassu');
    }

    // Képernyőkép (az első képernyőnyi rész), a változó tartalmak kitakarva
    const masks = cfg.maszkolando.map((s) => page.locator(s));
    const shotPath = path.join(IMG_DIR, `${file}.png`);
    const shot = await page.screenshot({ path: shotPath, animations: 'disabled', caret: 'hide', mask: masks, maskColor: '#FF00FF' });
    result.kep = `kepek/${file}.png`;

    const base = baseline.oldalak[id];
    const basePng = path.join(BASELINE_DIR, `${file}.png`);
    if (BASELINE_MODE || !base || !fss.existsSync(basePng)) {
      await fs.writeFile(basePng, shot);
      baseline.oldalak[id] = { ...probe.fingerprint, keszult: new Date().toISOString() };
      result.ujAlapallapot = true;
    } else {
      // Vizuális összevetés
      const cmp = comparePng(fss.readFileSync(basePng), shot, path.join(IMG_DIR, `${file}-elteres.png`));
      result.elteres = Math.round(cmp.percent * 100) / 100;
      if (cmp.percent > 0.5) {
        result.diff = `kepek/${file}-elteres.png`;
        await fs.copyFile(basePng, path.join(IMG_DIR, `${file}-alap.png`));
        result.alap = `kepek/${file}-alap.png`;
      }
      if (cmp.percent > cfg.hatarertekek.kepElteresSzazalek) {
        add('hiba', 'vizualis', 'Az oldal teteje látványosan eltér az elfogadott állapottól', '');
        findings[findings.length - 1].reszlet = `${result.elteres}%`;
      }
      // Ujjlenyomat összevetése
      const fp = probe.fingerprint;
      const t = cfg.hatarertekek;
      if (base.bodyFont && fp.bodyFont !== base.bodyFont) add('hiba', 'stilus', `Megváltozott az alap betűtípus (${base.bodyFont} → ${fp.bodyFont}). Valószínűleg nem töltődött be a CSS.`, 'body-font');
      if (base.headingFont && fp.headingFont && fp.headingFont !== base.headingFont) add('hiba', 'stilus', `Megváltozott a címsorok betűtípusa (${base.headingFont} → ${fp.headingFont})`, 'heading-font');
      if (base.cssFiles == null) {
        // Régebbi alapállapot: a hiányzó adatot most pótoljuk
        base.cssFiles = fp.cssFiles;
        baseline._valtozott = true;
      } else if (fp.cssFiles < base.cssFiles) {
        add('hiba', 'stilus', `Kevesebb saját CSS-fájl töltődött be, mint korábban (${base.cssFiles} → ${fp.cssFiles})`, 'css-fajlok');
      }
      if (base.header?.visible) {
        if (!fp.header?.visible) add('hiba', 'fejlec', 'Eltűnt a fejléc', 'eltunt');
        else {
          const ratio = fp.header.h / base.header.h;
          if (Math.abs(ratio - 1) > t.fejlecValtozas) add('hiba', 'fejlec', `Jelentősen megváltozott a fejléc magassága (${base.header.h} → ${fp.header.h} px)`, 'magassag');
        }
      }
      if (base.footer?.visible && !fp.footer?.visible) add('hiba', 'lablec', 'Eltűnt a lábléc', 'eltunt');
      if (base.docHeight) {
        const ratio = fp.docHeight / base.docHeight;
        const big = Math.max(ratio, 1 / ratio) - 1;
        if (big > t.oldalmagassagHiba) add('hiba', 'oldalmagassag', `Drasztikusan megváltozott az oldal hossza (${base.docHeight} → ${fp.docHeight} px)`, 'drasztikus');
        else if (big > t.oldalmagassagFigyelmeztetes) add('figyelmeztetes', 'oldalmagassag', `Jelentősen megváltozott az oldal hossza (${base.docHeight} → ${fp.docHeight} px)`, 'jelentos');
      }
      if (base.sections != null && fp.sections != null && fp.sections !== base.sections) add('figyelmeztetes', 'szekciok', `Megváltozott a szekciók száma (${base.sections} → ${fp.sections})`, 'szam');
    }

    // Teljes oldalas kép, ha hiba van, vagy alapállapot készül
    const serious = findings.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.hiba);
    if (serious || result.ujAlapallapot) {
      await page.screenshot({ path: path.join(IMG_DIR, `${file}-teljes.jpg`), fullPage: true, type: 'jpeg', quality: 60, animations: 'disabled', mask: masks, maskColor: '#FF00FF' }).catch(() => {});
      result.teljes = `kepek/${file}-teljes.jpg`;
    }
  } catch (e) {
    add('hiba', 'figyelo', `A figyelő nem tudta végigellenőrizni az oldalt: ${String(e.message).split('\n')[0]}`, 'belso-hiba');
  } finally {
    // Minden oldal saját böngészőkörnyezetben fut; a lezárás nem akaszthatja meg a futást
    await Promise.race([context.close().catch(() => {}), sleep(10000)]);
  }
  return { findings, result };
}

// ---------------------------------------------------------------- értesítések

async function notify(cfg, title, lines, priority = 'high') {
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const body = lines.join('\n') + (runUrl ? `\n\nRészletek: ${runUrl}` : '');
  const sent = [];
  if (process.env.NTFY_TOPIC) {
    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    try {
      const r = await fetch(server + '/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title, message: body.slice(0, 3900), priority: priority === 'high' ? 4 : 3, tags: [priority === 'high' ? 'warning' : 'white_check_mark'], ...(runUrl ? { click: runUrl } : {}) }),
      });
      sent.push(`ntfy: ${r.status}`);
    } catch (e) { sent.push(`ntfy hiba: ${e.message}`); }
  }
  if (process.env.SLACK_WEBHOOK_URL) {
    try {
      const r = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${title}*\n${body}`.slice(0, 3900) }),
      });
      sent.push(`Slack: ${r.status}`);
    } catch (e) { sent.push(`Slack hiba: ${e.message}`); }
  }
  if (sent.length) console.log(`Értesítés elküldve (${sent.join(', ')})`);
}

const findingText = (f) => f.message + (f.reszlet ? ` (${f.reszlet})` : '');
const findingLine = (f) => `• [${SEVERITY_LABEL[f.severity]}] ${f.oldal} / ${f.nezet}: ${findingText(f)}`;

// Az azonos hibákat (pl. ugyanaz a hiányzó CSS minden oldalon) egy sorba vonja össze.
function groupedLines(list) {
  const groups = new Map();
  for (const f of list) {
    const k = f.type + '|' + normalize(f.message);
    const g = groups.get(k) || { severity: f.severity, message: f.message, helyek: [] };
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[g.severity]) g.severity = f.severity;
    g.helyek.push(`${f.oldal}/${f.nezet}`);
    groups.set(k, g);
  }
  return [...groups.values()]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .map((g) => `• [${SEVERITY_LABEL[g.severity]}] ${g.message} — ${g.helyek.length > 4 ? `${g.helyek.slice(0, 4).join(', ')} és még ${g.helyek.length - 4} helyen` : g.helyek.join(', ')}`);
}

// ---------------------------------------------------------------- riport

async function writeReport(cfg, data) {
  await writeJson(path.join(REPORT_DIR, 'riport.json'), data);

  const rows = data.talalatok
    .slice()
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .map((f) => `<tr class="${f.severity}${f.ismert ? ' ismert' : ''}"><td>${SEVERITY_LABEL[f.severity]}${f.ismert ? '<br><small>ismert</small>' : ''}</td><td>${esc(f.oldal)}</td><td>${esc(f.nezet)}</td><td>${esc(findingText(f))}</td></tr>`)
    .join('\n');
  const cards = data.eredmenyek
    .map((r) => `<div class="card"><h3>${esc(r.oldal)} · ${esc(r.nezet)}</h3>
<p><a href="${esc(r.url)}">${esc(r.url)}</a><br>Betöltés: ${r.betoltesMs != null ? (r.betoltesMs / 1000).toFixed(1) + ' mp' : '–'} · Eltérés: ${r.elteres != null ? r.elteres + '%' : r.ujAlapallapot ? 'új alapállapot' : '–'}</p>
${r.alap ? `<div class="pair"><div><p>Elfogadott állapot</p><a href="${r.alap}"><img src="${r.alap}" alt="alapállapot"></a></div><div><p>Most</p><a href="${r.kep}"><img src="${r.kep}" alt="most"></a></div></div>` : r.kep ? `<a href="${r.kep}"><img src="${r.kep}" alt="képernyőkép"></a>` : ''}
${r.diff ? `<p>Eltérés (piros = változott):</p><a href="${r.diff}"><img src="${r.diff}" alt="eltérés"></a>` : ''}
${r.teljes ? `<p><a href="${r.teljes}">Teljes oldal megnyitása</a></p>` : ''}</div>`)
    .join('\n');
  const html = `<!DOCTYPE html><html lang="hu"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Figyelő riport – ${esc(cfg.nev)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;color:#1d2327;background:#f6f7f7}
h1{font-size:22px}table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #dcdcde;padding:6px 8px;text-align:left;vertical-align:top;font-size:14px}
tr.kritikus td:first-child{background:#d63638;color:#fff}tr.hiba td:first-child{background:#f0b849}tr.figyelmeztetes td:first-child{background:#f6f7f7}tr.ismert{opacity:.6}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-top:24px}.card{background:#fff;border:1px solid #dcdcde;padding:12px;border-radius:6px}
.card h3{margin:0 0 6px;font-size:16px}.card p{font-size:13px;margin:6px 0;word-break:break-all}.card img{width:100%;max-height:440px;object-fit:contain;object-position:top;border:1px solid #dcdcde;background:#fff}.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
</style></head><body>
<h1>${esc(cfg.nev)} – figyelő riport</h1>
<p>${esc(data.ido)} · mód: ${data.alapallapotMod ? 'alapállapot rögzítése' : 'ellenőrzés'} · ${data.talalatok.length} találat, ebből ${data.ujRiasztando.length} új riasztandó</p>
${rows ? `<table><tr><th>Súlyosság</th><th>Oldal</th><th>Nézet</th><th>Leírás</th></tr>${rows}</table>` : '<p><strong>Nem találtam hibát.</strong></p>'}
<div class="grid">${cards}</div>
</body></html>`;
  await fs.writeFile(path.join(REPORT_DIR, 'index.html'), html);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [
      `## ${cfg.nev} – figyelő`,
      '',
      data.alapallapotMod ? '**Alapállapot rögzítve.**' : data.ujRiasztando.length ? `**${data.ujRiasztando.length} új hiba – riasztás elküldve.**` : '**Nincs új riasztandó hiba.**',
      '',
      data.talalatok.length ? '| Súlyosság | Oldal | Nézet | Leírás |\n|---|---|---|---|\n' + data.talalatok.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).map((f) => `| ${SEVERITY_LABEL[f.severity]}${f.ismert ? ' (ismert)' : ''} | ${f.oldal} | ${f.nezet} | ${findingText(f).replace(/\|/g, '\\|')} |`).join('\n') : 'Nem találtam hibát.',
      '',
      '| Oldal | Nézet | Betöltés | Eltérés |\n|---|---|---|---|\n' + data.eredmenyek.map((r) => `| ${r.oldal} | ${r.nezet} | ${r.betoltesMs != null ? (r.betoltesMs / 1000).toFixed(1) + ' mp' : '–'} | ${r.elteres != null ? r.elteres + '%' : r.ujAlapallapot ? 'új alapállapot' : '–'} |`).join('\n'),
    ].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
}

// ---------------------------------------------------------------- fő program

async function main() {
  const cfg = loadConfig();
  await fs.rm(REPORT_DIR, { recursive: true, force: true });
  await fs.mkdir(IMG_DIR, { recursive: true });
  await fs.mkdir(BASELINE_DIR, { recursive: true });
  await fs.mkdir(STATE_DIR, { recursive: true });

  const hadBaseline = fss.existsSync(BASELINE_FILE);
  const baseline = BASELINE_MODE || !hadBaseline
    ? { alapUrl: cfg.alapUrl, oldalak: {}, ismertHibak: [] }
    : readJson(BASELINE_FILE, { oldalak: {}, ismertHibak: [] });
  if (!BASELINE_MODE && !hadBaseline) console.log('Még nincs alapállapot – most rögzítem az aktuális állapotot.');

  console.log(`${BASELINE_MODE ? 'Alapállapot rögzítése' : 'Ellenőrzés'}: ${cfg.nev} (${cfg.alapUrl}), ${cfg.oldalak.length} oldal × ${cfg.nezetek.length} nézet`);

  // Ha a böngésző összeomlik, újraindítjuk (a párhuzamos nézetek közösen használják)
  const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let browserP = launch();
  let generation = 0;
  const makeContext = async (vp) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = generation;
      const b = await browserP;
      try {
        return await newContextOn(b, vp);
      } catch (e) {
        if (attempt === 1) throw e;
        if (gen === generation) {
          generation++;
          console.log('  (a böngésző újraindul)');
          Promise.race([b.close(), sleep(5000)]).catch(() => {});
          browserP = launch();
        }
      }
    }
  };
  const newContextOn = async (browser, vp) => {
    const context = await browser.newContext({
      viewport: { width: vp.szelesseg, height: vp.magassag },
      deviceScaleFactor: 1,
      isMobile: !!vp.mobil,
      hasTouch: !!vp.mobil,
      userAgent: vp.mobil ? UA_MOBILE : UA_DESKTOP,
      locale: 'hu-HU',
      timezoneId: 'Europe/Budapest',
      reducedMotion: 'reduce',
    });
    if (cfg.blokkolt.length) {
      await context.route((u) => matchesAny(u.href, cfg.blokkolt), (route) => route.abort('blockedbyclient'));
    }
    return context;
  };
  const all = [];
  try {
    // A nézetek párhuzamosan futnak; egyik hibája sem állíthatja le a többit
    await Promise.allSettled(cfg.nezetek.map(async (vp) => {
      for (const pg of cfg.oldalak) {
        let r;
        for (let attempt = 1; !r; attempt++) {
          try {
            r = await checkOne(await makeContext(vp), cfg, pg, vp, baseline);
          } catch (e) {
            // Nem nyitható meg a böngésző/fül: még egyszer megpróbáljuk, utána hibaként jelezzük
            if (attempt >= 2) {
              const url = pageUrl(cfg, pg);
              r = {
                findings: [{ severity: 'hiba', type: 'figyelo', oldal: pg.nev, nezet: vp.nev, url, message: `A figyelő nem tudta megnyitni az oldalt: ${String(e.message).split('\n')[0]}`, key: `${pg.nev}|${vp.nev}|figyelo|belso-hiba` }],
                result: { id: `${pg.nev}|${vp.nev}`, oldal: pg.nev, nezet: vp.nev, url, kep: null, diff: null, teljes: null, elteres: null, betoltesMs: null, ujAlapallapot: false },
              };
            }
          }
        }
        all.push(r);
        const worst = r.findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), -1);
        console.log(`  ${pg.nev} / ${vp.nev}: ${r.findings.length ? `${r.findings.length} találat (legsúlyosabb: ${SEVERITY_LABEL[Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === worst)]})` : 'rendben'}${r.result.elteres != null ? `, eltérés ${r.result.elteres}%` : ''}`);
      }
    }));
  } finally {
    await Promise.race([browserP.then((b) => b.close()).catch(() => {}), sleep(10000)]);
  }

  const order = (id) => {
    const [p, v] = id.split('|');
    return cfg.oldalak.findIndex((x) => x.nev === p) * 100 + cfg.nezetek.findIndex((x) => x.nev === v);
  };
  const eredmenyek = all.map((r) => r.result).sort((a, b) => order(a.id) - order(b.id));
  const talalatok = all.flatMap((r) => r.findings);

  // Új alapállapot (teljes vagy egyes oldalakra): a most látott hibák "ismertek" lesznek
  const newBaselineIds = new Set(eredmenyek.filter((r) => r.ujAlapallapot).map((r) => r.id));
  const baselineDirty = !!baseline._valtozott;
  delete baseline._valtozott;
  if (newBaselineIds.size || baselineDirty) {
    const keep = (baseline.ismertHibak || []).filter((k) => !newBaselineIds.has(k.key.split('|').slice(0, 2).join('|')));
    const add = talalatok
      .filter((f) => newBaselineIds.has(`${f.oldal}|${f.nezet}`))
      .map((f) => ({ key: f.key, severity: f.severity, message: f.message }));
    baseline.ismertHibak = [...keep, ...add];
    baseline.alapUrl = cfg.alapUrl;
    baseline.frissitve = new Date().toISOString();
    await writeJson(BASELINE_FILE, baseline);
  }
  const knownKeys = new Set((baseline.ismertHibak || []).map((k) => k.key));
  for (const f of talalatok) f.ismert = knownKeys.has(f.key) || newBaselineIds.has(`${f.oldal}|${f.nezet}`);

  // Riasztási állapot (hogy ugyanazért ne riasszon minden futáskor)
  const now = Date.now();
  let state = BASELINE_MODE ? { hibak: {} } : readJson(STATE_FILE, { hibak: {} });
  const alertable = talalatok.filter((f) => !f.ismert && cfg.riasztas.szintek.includes(f.severity));
  const activeKeys = new Set();
  const active = [];
  let trigger = false;
  for (const f of alertable) {
    if (activeKeys.has(f.key)) continue;
    activeKeys.add(f.key);
    active.push(f);
    const st = state.hibak[f.key] || { elsoAlkalom: new Date(now).toISOString(), lattuk: 0 };
    st.lattuk += 1;
    st.utoljara = new Date(now).toISOString();
    Object.assign(st, { severity: f.severity, type: f.type, message: f.message, oldal: f.oldal, nezet: f.nezet });
    const need = cfg.riasztas.megerosites[f.severity] ?? 1;
    const lastAlert = st.riasztva ? Date.parse(st.riasztva) : 0;
    if (st.lattuk >= need && (!lastAlert || now - lastAlert > cfg.riasztas.ujraRiasztasOra * 3600e3)) {
      st.esedekes = true;
      trigger = true;
    }
    state.hibak[f.key] = st;
  }
  // Ha riasztunk, egy üzenetben megy minden aktív, még nem jelzett hiba is (egy esemény = egy értesítés)
  const ujRiasztando = [];
  if (trigger) {
    for (const f of active) {
      const st = state.hibak[f.key];
      if (st.esedekes || !st.riasztva) {
        st.riasztva = new Date(now).toISOString();
        ujRiasztando.push(f);
      }
    }
  }
  for (const st of Object.values(state.hibak)) delete st.esedekes;
  const megoldodott = [];
  for (const [k, st] of Object.entries(state.hibak)) {
    if (activeKeys.has(k)) continue;
    if (st.riasztva) megoldodott.push(st);
    delete state.hibak[k];
  }
  await writeJson(STATE_FILE, state);

  // Értesítések
  if (ujRiasztando.length) {
    const lines = groupedLines(ujRiasztando);
    const crit = ujRiasztando.some((f) => f.severity === 'kritikus');
    await notify(cfg, `${crit ? '🚨' : '⚠️'} ${cfg.nev}: ${lines.length} probléma a weboldalon`, lines.slice(0, 15), 'high');
  }
  if (megoldodott.length) {
    const lines = groupedLines(megoldodott);
    await notify(cfg, `✅ ${cfg.nev}: ${lines.length} probléma megszűnt`, lines.slice(0, 15), 'default');
  }
  if (!hadBaseline && !BASELINE_MODE) {
    const known = talalatok.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.hiba);
    await notify(cfg, `ℹ️ ${cfg.nev}: a figyelő elindult`, [`Alapállapot rögzítve (${eredmenyek.length} oldal/nézet).`, known.length ? `Induláskor talált, ismertként rögzített hibák:` : 'Induláskor nem találtam hibát.', ...groupedLines(known).slice(0, 10)], 'default');
  }

  const data = {
    ido: new Date(now).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
    alapallapotMod: BASELINE_MODE || !hadBaseline,
    talalatok,
    ujRiasztando,
    megoldodott,
    eredmenyek,
  };
  await writeReport(cfg, data);

  const problems = talalatok.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.hiba);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `problemak=${problems || newBaselineIds.size > 0}\nriasztas=${ujRiasztando.length > 0}\n`);
  }

  console.log(`\nÖsszesen ${talalatok.length} találat (${talalatok.filter((f) => f.ismert).length} ismert), új riasztás: ${ujRiasztando.length}, megszűnt: ${megoldodott.length}`);
  for (const f of ujRiasztando) console.log(findingLine(f));
  console.log(`Riport: ${path.relative(ROOT, path.join(REPORT_DIR, 'index.html'))}`);

  // Kilépési kód 1 = új hiba: a GitHub ilyenkor e-mailt küld a sikertelen futásról
  process.exitCode = ujRiasztando.length ? 1 : 0;
}

// Biztonsági időkorlát: ha valami beragadna, 15 perc után leáll
setTimeout(() => { console.error('A figyelő időtúllépés miatt leállt.'); process.exit(2); }, 15 * 60e3).unref();

main()
  .catch((e) => {
    console.error('A figyelő hibával leállt:', e);
    process.exitCode = 2;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
