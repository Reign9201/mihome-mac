import fs from 'node:fs';
import vm from 'node:vm';
import { LANGUAGES, extractSources, localeFile, placeholderSet } from './i18n-source.mjs';

const sources = extractSources();
const expected = new Set(sources);
const overrides = JSON.parse(fs.readFileSync(new URL('./i18n-overrides.json', import.meta.url), 'utf8'));
const failures = [];
const warnings = [];
const allowedHan = /MiHome|Mi Home|小爱|米家|飞书|企业微信|钉钉/;
const hanScript = /[\u3400-\u9fff]/;
const chineseVariants = new Set(['zh-Hans', 'zh-Hant', 'zh-HK']);
const sentinel = /@@\s*\d+\s*@@|[\[［]{2}\s*[A-Z_]+\s*[\]］]{2}/;
const protectedTerms = [
  ['MiHome Mac', 'mihome mac'],
  ['Whisper.cpp', 'whisper.cpp'],
  ['Client Secret', 'client secret'],
  ['Client ID', 'client id'],
  ['AppSecret', 'appsecret'],
  ['AppKey', 'appkey'],
  ['OpenAI', 'openai'],
  ['WebSocket', 'websocket'],
  ['Webhook', 'webhook'],
  ['API Key', 'api key'],
  ['Token', 'token'],
  ['Cookie', 'cookie'],
  ['企业微信', 'wecom'],
  ['钉钉', 'dingtalk'],
  ['飞书', 'feishu'],
  ['米家', 'mi home'],
  ['小米', 'xiaomi'],
];
const forbiddenTranslations = [
  /Taiwan|Тайвань|台湾|臺灣|تايوان|ไต้หวัน|Đài Loan|Taïwan|Tajwan/i,
  /当座預金|Girokonto|Compte courant|Conto corrente|Текущий счет|Rachunek bieżący|Běžný účet|Folyószámla|Cari hesap|Lopende rekening|Løbende konto|Løpende konto|cuenta corriente|conta corrente/i,
  /障害者|장애인|Niepełnospraw|Discapacitad|殘障|残障|残疾人/i,
  /\b(?:Courir|Rennen|Bieganie|Běh|Futás|Alergarea|Correndo|Løber|Löpning)\s*·|الجري\s*·|ריצה\s*·|วิ่ง\s*·|Berlari\s*·|Трчање\s*·/i,
];
const contextualMistranslations = {
  '空间': /(?:^|\b)space\b|الفضاء|uzay|अंतरिक्ष|angkasa|อวกาศ|우주|宇宙|espace lointain|Weltraum/i,
  '监控': /^مرافق$|^مراقب$|^צג$|^Màn hình$|^จอภาพ$|^Οθόνη$/i,
  '在线设备': /الانترنت|internetowe|Διαδικτυακές/i,
  '中午好': /good noon|おはよう|좋은 정오/i,
};
const simplifiedHan = /[这为个说时会后里还没开关闭网线设备间电视门车马长见让从无与产业务动态样问题应该点击选择启确认删准备执帐户凭据仅当读项传们获请码优云连断过复摄录处异宫]/;
let checked = 0;
let checkedOverrides = 0;
let checkedTerms = 0;

function loadLocale(code) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(localeFile(code), 'utf8'), sandbox, { filename: localeFile(code) });
  return sandbox.window.MihomeI18nData?.[code] || {};
}

for (const language of LANGUAGES) {
  if (!fs.existsSync(localeFile(language.code))) {
    failures.push(`${language.code}: missing locale file`);
    continue;
  }
  const table = loadLocale(language.code);
  const keys = new Set(Object.keys(table));
  const languageOverrides = overrides[language.code] || {};
  for (const [source, translated] of Object.entries(languageOverrides)) {
    checkedOverrides += 1;
    if (!expected.has(source)) {
      failures.push(`${language.code}: override key is not an extracted source ${JSON.stringify(source)}`);
    } else if (table[source] !== translated) {
      failures.push(`${language.code}: override was not applied for ${JSON.stringify(source)}`);
    }
  }
  for (const source of expected) {
    if (!keys.has(source)) failures.push(`${language.code}: missing key ${JSON.stringify(source)}`);
  }
  for (const key of keys) {
    if (!expected.has(key)) warnings.push(`${language.code}: extra key ${JSON.stringify(key)}`);
  }
  for (const [source, translated] of Object.entries(table)) {
    checked += 1;
    if (typeof translated !== 'string' || !translated.trim()) {
      failures.push(`${language.code}: empty translation for ${JSON.stringify(source)}`);
      continue;
    }
    const sourcePlaceholders = [...placeholderSet(source)].sort().join(',');
    const targetPlaceholders = [...placeholderSet(translated)].sort().join(',');
    if (sourcePlaceholders !== targetPlaceholders) {
      failures.push(`${language.code}: placeholder mismatch for ${JSON.stringify(source)}`);
    }
    if (!chineseVariants.has(language.code)) {
      // Japanese legitimately uses Han characters, so only languages that do
      // not use Han script can be checked for accidental Chinese leftovers.
      if (language.code !== 'ja' && hanScript.test(translated) && !allowedHan.test(source)) {
        failures.push(`${language.code}: untranslated Han text for ${JSON.stringify(source)} -> ${JSON.stringify(translated)}`);
      }
      if (language.code !== 'ja' && translated === source && hanScript.test(source)) {
        failures.push(`${language.code}: unchanged Chinese source ${JSON.stringify(source)}`);
      }
    }
    if (/\{\d+\}/.test(translated) && !/\{\d+\}/.test(source)) {
      failures.push(`${language.code}: invented placeholder for ${JSON.stringify(source)}`);
    }
    if (sentinel.test(translated)) {
      failures.push(`${language.code}: protected translation token leaked for ${JSON.stringify(source)}`);
    }
    for (const pattern of forbiddenTranslations) {
      if (pattern.test(translated)) {
        failures.push(`${language.code}: forbidden mistranslation for ${JSON.stringify(source)} -> ${JSON.stringify(translated)}`);
      }
    }
    const contextualPattern = contextualMistranslations[source];
    if (contextualPattern?.test(translated)) {
      failures.push(`${language.code}: context mistranslation for ${JSON.stringify(source)} -> ${JSON.stringify(translated)}`);
    }
    if (['zh-Hant', 'zh-HK'].includes(language.code) && simplifiedHan.test(translated)) {
      failures.push(`${language.code}: simplified Han text for ${JSON.stringify(source)} -> ${JSON.stringify(translated)}`);
    }
    if (!chineseVariants.has(language.code)) {
      const lower = translated.toLowerCase();
      for (const [sourceTerm, targetTerm] of protectedTerms) {
        if (!source.includes(sourceTerm)) continue;
        checkedTerms += 1;
        if (!lower.includes(targetTerm)) {
          failures.push(`${language.code}: protected term ${JSON.stringify(sourceTerm)} changed for ${JSON.stringify(source)}`);
        }
      }
    }
  }
}

const report = {
  ok: failures.length === 0,
  locales: LANGUAGES.length,
  sources: sources.length,
  checkedTranslations: checked,
  checkedOverrides,
  checkedProtectedTerms: checkedTerms,
  failures,
  warnings,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
