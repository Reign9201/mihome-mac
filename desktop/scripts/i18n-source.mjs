import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const here = path.dirname(fileURLToPath(import.meta.url));
export const desktopRoot = path.resolve(here, '..');
export const repoRoot = path.resolve(desktopRoot, '..');
export const i18nDir = path.join(desktopRoot, 'ui', 'i18n');

export const LANGUAGES = [
  ['en', 'English', 'en'],
  ['zh-Hans', '简体中文', 'zh-CN'],
  ['zh-Hant', '繁體中文', 'zh-TW'],
  ['zh-HK', '繁體中文（香港）', 'zh-HK'],
  ['ja', '日本語', 'ja'],
  ['ko', '한국어', 'ko'],
  ['de', 'Deutsch', 'de'],
  ['fr', 'Français', 'fr'],
  ['es', 'Español', 'es'],
  ['pt-BR', 'Português (Brasil)', 'pt-BR'],
  ['pt-PT', 'Português (Portugal)', 'pt-PT'],
  ['it', 'Italiano', 'it'],
  ['nl', 'Nederlands', 'nl'],
  ['ru', 'Русский', 'ru'],
  ['uk', 'Українська', 'uk'],
  ['pl', 'Polski', 'pl'],
  ['cs', 'Čeština', 'cs'],
  ['sk', 'Slovenčina', 'sk'],
  ['hu', 'Magyar', 'hu'],
  ['ro', 'Română', 'ro'],
  ['el', 'Ελληνικά', 'el'],
  ['tr', 'Türkçe', 'tr'],
  ['ar', 'العربية', 'ar'],
  ['he', 'עברית', 'he'],
  ['hi', 'हिन्दी', 'hi'],
  ['th', 'ไทย', 'th'],
  ['vi', 'Tiếng Việt', 'vi'],
  ['id', 'Bahasa Indonesia', 'id'],
  ['ms', 'Bahasa Melayu', 'ms'],
  ['ca', 'Català', 'ca'],
  ['da', 'Dansk', 'da'],
  ['fi', 'Suomi', 'fi'],
  ['nb', 'Norsk bokmål', 'nb'],
  ['sv', 'Svenska', 'sv'],
  ['sr', 'Српски', 'sr'],
].map(([code, name, google]) => ({ code, name, google }));

const cjk = /[\u3400-\u9fff]/;
const debugValue = /\b(?:count|failed|request|controls|remote|tracks|grid|ready|paused|width|time|frames|status)=/;
const weekdays = new Set(['一', '二', '三', '四', '五', '六', '日']);
const manualSources = [
  '客厅',
  '卧室',
  '书房',
  '厨房',
  '玄关',
  '阳台',
  '卫生间',
  '全部房间',
  '{0} · 在线',
  '{0} · 离线',
];

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function extractMarkup(value, add) {
  if (!/<\/?[a-zA-Z][^>]*>/.test(value)) return false;
  for (const match of value.matchAll(/\b(?:title|placeholder|aria-label|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    add(match[1] ?? match[2]);
  }
  const textOnly = decodeEntities(value.replace(/<[^>]*>/g, '\n'));
  for (const fragment of textOnly.split('\n')) add(fragment);
  return true;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['start', 'end', 'loc'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit, node));
    else if (value && typeof value === 'object' && value.type) walk(value, visit, node);
  }
}

function flatten(node, state) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    let output = '';
    node.quasis.forEach((quasi, index) => {
      output += quasi.value.cooked ?? quasi.value.raw;
      if (index < node.expressions.length) output += `{${state.index++}}`;
    });
    return output;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = flatten(node.left, state);
    const right = flatten(node.right, state);
    return left == null || right == null ? null : left + right;
  }
  if (node.type === 'ParenthesizedExpression') return flatten(node.expression, state);
  return `{${state.index++}}`;
}

function shouldKeep(source) {
  return cjk.test(source)
    && source.length <= 500
    && !weekdays.has(source)
    && !debugValue.test(source)
    && /[\p{L}\p{N}]/u.test(source);
}

export function extractSources() {
  const sources = new Set();
  const add = (value) => {
    const source = normalize(value);
    if (shouldKeep(source)) sources.add(source);
  };
  for (const file of ['ui/app.js', 'ui/capabilities.js', 'ui/diagnostics.js']) {
    const source = fs.readFileSync(path.join(desktopRoot, file), 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    walk(ast, (node, parent) => {
      if (node.type === 'Literal' && typeof node.value === 'string' && cjk.test(node.value)) {
        if (!extractMarkup(node.value, add)) add(node.value);
      }
      if (node.type === 'TemplateLiteral') {
        const value = flatten(node, { index: 0 });
        if (value && cjk.test(value) && !extractMarkup(value, add)) add(value);
        // Expressions split a template into text nodes at runtime. Extract
        // each static quasi as well so labels such as "刷新状态" are not
        // stored only as a placeholder-prefixed pattern.
        for (const quasi of node.quasis) {
          const fragment = quasi.value.cooked ?? quasi.value.raw;
          if (!cjk.test(fragment)) continue;
          if (!extractMarkup(fragment, add)) add(fragment);
        }
      }
      if (
        node.type === 'BinaryExpression'
        && node.operator === '+'
        && (!parent || parent.type !== 'BinaryExpression' || parent.operator !== '+')
      ) {
        const value = flatten(node, { index: 0 });
        if (value && cjk.test(value) && !extractMarkup(value, add)) add(value);
      }
    });
  }
  const html = fs.readFileSync(path.join(desktopRoot, 'ui', 'index.html'), 'utf8');
  extractMarkup(html, add);
  manualSources.forEach(add);
  return [...sources].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export function placeholderSet(value) {
  return new Set([...String(value).matchAll(/\{(\d+)\}/g)].map((match) => match[1]));
}

export function localeFile(code) {
  return path.join(i18nDir, `${code}.js`);
}
