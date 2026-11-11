import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  LANGUAGES,
  desktopRoot,
  extractSources,
  i18nDir,
  localeFile,
  placeholderSet,
} from './i18n-source.mjs';

const cacheFile = path.join(desktopRoot, '.i18n-cache.json');
const overridesFile = path.join(desktopRoot, 'scripts', 'i18n-overrides.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
const sources = extractSources();
const batchSize = 20;
const force = process.argv.includes('--force');
// --offline rebuilds locale files from the committed translations plus
// i18n-overrides.json without calling a translation service. New source
// strings must then have an override for every locale.
const offline = process.argv.includes('--offline');

function committedLocale(code) {
  const file = localeFile(code);
  if (!fs.existsSync(file)) return {};
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  return sandbox.window.MihomeI18nData?.[code] || {};
}
const chineseVariants = new Set(['zh-Hans', 'zh-Hant', 'zh-HK']);
const protectedTerms = [
  ['MiHome Mac', 'MiHome Mac'],
  ['Whisper.cpp', 'Whisper.cpp'],
  ['Client Secret', 'Client Secret'],
  ['Client ID', 'Client ID'],
  ['AppSecret', 'AppSecret'],
  ['AppKey', 'AppKey'],
  ['OpenAI', 'OpenAI'],
  ['WebSocket', 'WebSocket'],
  ['Webhook', 'Webhook'],
  ['API Key', 'API Key'],
  ['Token', 'Token'],
  ['Cookie', 'Cookie'],
  ['企业微信', 'WeCom'],
  ['钉钉', 'DingTalk'],
  ['飞书', 'Feishu'],
  ['米家', 'Mi Home'],
  ['小米', 'Xiaomi'],
];

function protectTerms(value, language) {
  if (chineseVariants.has(language.code)) return value;
  return protectedTerms.reduce(
    (text, [source], index) => text.split(source).join(`@@${String(index + 1).padStart(4, '0')}@@`),
    value,
  );
}

function restoreTerms(value) {
  const restored = value.replace(/@@\s*0*(\d+)\s*@@/g, (match, index) => (
    protectedTerms[Number(index) - 1]?.[1] || match
  ));
  return restored.replace(
    /(MiHome Mac|Whisper\.cpp|Client Secret|Client ID|AppSecret|AppKey|OpenAI|WebSocket|Webhook|API Key|Token|Cookie|WeCom|DingTalk|Feishu|Mi Home|Xiaomi)(?=[^\s\p{P}\d])/gu,
    '$1 ',
  );
}

const brandFixes = [
  [/\bWeChat Work\b/gi, 'WeCom'],
  [/\bEnterprise WeChat\b/gi, 'WeCom'],
  [/\bWeChat for Business\b/gi, 'WeCom'],
  [/\bWeChat Enterprise\b/gi, 'WeCom'],
  [/\bWeChat Business\b/gi, 'WeCom'],
  [/\bDing Talk\b/gi, 'DingTalk'],
  [/\bDingding\b/gi, 'DingTalk'],
  [/\bFeiShu\b/gi, 'Feishu'],
  [/\bLark\b/gi, 'Feishu'],
  [/\bMi Jia\b/gi, 'Mi Home'],
  [/\bMijia(?:'s|s)?\b/gi, 'Mi Home'],
];

function postprocess(value) {
  let output = value
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .trim();
  for (const [pattern, replacement] of brandFixes) output = output.replace(pattern, replacement);
  return output;
}

function cached(code, source) {
  return cache[`${code}\u0000${source}`];
}

function remember(code, source, translation) {
  cache[`${code}\u0000${source}`] = translation;
}

function saveCache() {
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

async function translateBatch(language, lines) {
  const query = lines.map((line) => protectTerms(line, language)).join('\n');
  const endpoints = [
    () => `https://clients5.google.com/translate_a/t?${new URLSearchParams({
      client: 'dict-chrome-ex',
      sl: 'zh-CN',
      tl: language.google,
      q: query,
    })}`,
    () => `https://translate.googleapis.com/translate_a/single?${new URLSearchParams({
      client: 'gtx',
      sl: 'zh-CN',
      tl: language.google,
      dt: 't',
      q: query,
    })}`,
  ];
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(endpoints[attempt % endpoints.length](), {
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const text = typeof payload?.[0] === 'string'
        ? payload[0]
        : (payload?.[0] || []).map((part) => part?.[0] || '').join('');
      const translated = text.split('\n');
      if (translated.length !== lines.length) {
        throw new Error(`line count ${translated.length} != ${lines.length}`);
      }
      return translated.map((line) => postprocess(restoreTerms(line)));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 650 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function translateLanguage(language) {
  if (language.code === 'zh-Hans') {
    return Object.fromEntries(sources.map((source) => [source, source]));
  }
  const result = {};
  const missing = [];
  const committed = offline ? committedLocale(language.code) : {};
  for (const source of sources) {
    const override = overrides[language.code]?.[source];
    if (override) {
      result[source] = override;
      continue;
    }
    if (offline) {
      if (committed[source]) result[source] = committed[source];
      else missing.push(source);
      continue;
    }
    const needsBrandRefresh = !chineseVariants.has(language.code)
      && protectedTerms.some(([term]) => source.includes(term));
    const value = force || needsBrandRefresh ? null : cached(language.code, source);
    if (value) result[source] = postprocess(restoreTerms(value));
    else missing.push(source);
  }
  if (offline && missing.length) {
    throw new Error(`${language.code}: add i18n-overrides.json entries for ${missing.map((item) => JSON.stringify(item)).join(', ')}`);
  }
  for (let offset = 0; offset < missing.length; offset += batchSize) {
    const lines = missing.slice(offset, offset + batchSize);
    let translations;
    try {
      translations = await translateBatch(language, lines);
    } catch {
      translations = [];
      for (const line of lines) translations.push(...await translateBatch(language, [line]));
    }
    lines.forEach((source, index) => {
      let translated = translations[index] || source;
      if ([...placeholderSet(source)].sort().join() !== [...placeholderSet(translated)].sort().join()) {
        translated = source;
      }
      result[source] = overrides[language.code]?.[source] || translated;
      remember(language.code, source, translated);
    });
    saveCache();
    process.stdout.write(`  ${language.code} ${Math.min(offset + lines.length, missing.length)}/${missing.length}\n`);
  }
  return result;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

fs.mkdirSync(i18nDir, { recursive: true });
console.log(`Sources: ${sources.length}; locales: ${LANGUAGES.length}`);
await runPool(LANGUAGES, 2, async (language) => {
  console.log(`Translating ${language.code}...`);
  const values = await translateLanguage(language);
  const body = [
    'window.MihomeI18nData = window.MihomeI18nData || {};',
    `window.MihomeI18nData[${JSON.stringify(language.code)}] = ${JSON.stringify(values, null, 2)};`,
    '',
  ].join('\n');
  fs.writeFileSync(localeFile(language.code), body);
});
if (!offline) saveCache();
console.log(`Wrote ${LANGUAGES.length} locale files to ${i18nDir}`);
