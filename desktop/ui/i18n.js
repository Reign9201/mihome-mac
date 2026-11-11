(function () {
  const LANGUAGES = [
    { code: 'system', name: '跟随系统' },
    { code: 'en', name: 'English' },
    { code: 'zh-Hans', name: '简体中文' },
    { code: 'zh-Hant', name: '繁體中文' },
    { code: 'zh-HK', name: '繁體中文（香港）' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'pt-BR', name: 'Português (Brasil)' },
    { code: 'pt-PT', name: 'Português (Portugal)' },
    { code: 'it', name: 'Italiano' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'ru', name: 'Русский' },
    { code: 'uk', name: 'Українська' },
    { code: 'pl', name: 'Polski' },
    { code: 'cs', name: 'Čeština' },
    { code: 'sk', name: 'Slovenčina' },
    { code: 'hu', name: 'Magyar' },
    { code: 'ro', name: 'Română' },
    { code: 'el', name: 'Ελληνικά' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'ar', name: 'العربية' },
    { code: 'he', name: 'עברית' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'th', name: 'ไทย' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'id', name: 'Bahasa Indonesia' },
    { code: 'ms', name: 'Bahasa Melayu' },
    { code: 'ca', name: 'Català' },
    { code: 'da', name: 'Dansk' },
    { code: 'fi', name: 'Suomi' },
    { code: 'nb', name: 'Norsk bokmål' },
    { code: 'sv', name: 'Svenska' },
    { code: 'sr', name: 'Српски' },
  ];

  const STORAGE_KEY = 'mihome.language';
  const RTL = new Set(['ar', 'he']);
  const KNOWN = LANGUAGES.filter((item) => item.code !== 'system').map((item) => item.code);
  const DATA_NAME_SELECTOR = [
    '[data-i18n-ignore]',
    '.device-name',
    '.table-device',
    '.room-item > span:not(.room-glyph):not(.room-count)',
    '.room-title',
    '.account-text > strong',
    '.account-card-copy > strong',
    '#accountName',
    '#accountAvatar',
    '#settingsAccount',
    '#camTitle',
    '#camSubtitle',
    '.cam-card-info > strong',
    '.cam-tile-title',
    '.overview-cam-info > strong',
    '.scene-pill .sc-text strong',
    '.detail-heading > h3',
    '.sc-text > strong',
    '.auto-name',
    '.pop-device-label',
    '#popScenes > button',
    '#homeSelect option',
    '#autoScene option',
    '#pairHome option',
    '.binding-row > strong',
    '.palette-item > span:not(.sub)',
  ].join(', ');
  const data = (window.MihomeI18nData ||= {});
  const patternCache = new Map();
  let currentCode = 'zh-Hans';
  let table = {};
  let fallback = {};
  let patterns = [];
  let observer = null;

  function matchLanguage(tag) {
    const lower = String(tag || '').toLowerCase();
    if (lower.startsWith('zh')) {
      if (lower.includes('hant') || lower.includes('-tw')) return 'zh-Hant';
      if (lower.includes('-hk') || lower.includes('-mo')) return 'zh-HK';
      return 'zh-Hans';
    }
    if (lower.startsWith('pt')) return lower.includes('-pt') ? 'pt-PT' : 'pt-BR';
    const exact = KNOWN.find((code) => code.toLowerCase() === lower);
    if (exact) return exact;
    const base = lower.split('-')[0];
    return KNOWN.find((code) => code.toLowerCase() === base) || 'en';
  }

  function systemLanguage() {
    for (const tag of navigator.languages || [navigator.language || 'en']) {
      const matched = matchLanguage(tag);
      if (matched) return matched;
    }
    return 'en';
  }

  function resolveLanguage() {
    const selected = localStorage.getItem(STORAGE_KEY) || 'system';
    return selected === 'system' ? systemLanguage() : matchLanguage(selected);
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compiledPattern(source) {
    if (patternCache.has(source)) return patternCache.get(source);
    const pieces = source.split(/(\{\d+\})/g);
    const indexes = [];
    let regex = '^';
    for (const piece of pieces) {
      const match = /^\{(\d+)\}$/.exec(piece);
      if (match) {
        regex += '(.*?)';
        indexes.push(Number(match[1]));
      } else {
        regex += escapeRegExp(piece);
      }
    }
    regex += '$';
    const result = { regex: new RegExp(regex), indexes };
    patternCache.set(source, result);
    return result;
  }

  function replaceArgs(text, args) {
    return text.replace(/\{(\d+)\}/g, (placeholder, index) => (
      args[index] === undefined ? placeholder : String(args[index])
    ));
  }

  function translateCore(core) {
    if (!core || currentCode === 'zh-Hans') return core;
    if (Object.prototype.hasOwnProperty.call(table, core)) return table[core];
    if (Object.prototype.hasOwnProperty.call(fallback, core)) return fallback[core];
    return core;
  }

  function translateText(value, values = null) {
    const text = String(value ?? '');
    if (!text.trim()) return text;
    if (currentCode === 'zh-Hans') return values ? replaceArgs(text, values) : text;
    const leading = text.match(/^\s*/)[0];
    const trailing = text.match(/\s*$/)[0];
    const core = text.trim();
    const exact = translateCore(core);
    if (exact !== core) return leading + replaceArgs(exact, values || {}) + trailing;
    for (const source of patterns) {
      if (source.length > core.length + 12) continue;
      const { regex, indexes } = compiledPattern(source);
      const matched = regex.exec(core);
      if (!matched) continue;
      const args = values ? { ...values } : {};
      indexes.forEach((placeholderIndex, captureIndex) => {
        args[placeholderIndex] = matched[captureIndex + 1];
      });
      return leading + replaceArgs(table[source], args) + trailing;
    }
    return text;
  }

  function rebuildPatterns() {
    patterns = Object.keys(table)
      .filter((source) => source.includes('{'))
      .sort((left, right) => right.length - left.length);
  }

  function shouldSkip(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    if (parent.closest(DATA_NAME_SELECTOR)) return true;
    return ['SCRIPT', 'STYLE', 'TEXTAREA'].includes(parent.tagName);
  }

  function translateAttributes(element) {
    for (const name of ['title', 'placeholder', 'aria-label', 'alt']) {
      if (!element.hasAttribute(name)) continue;
      const source = element.getAttribute(name);
      const translated = translateText(source);
      if (translated !== source) element.setAttribute(name, translated);
    }
  }

  function translateSubtree(root) {
    // Source strings are Simplified Chinese, so there is nothing to do; this
    // also spares the per-text-node closest() check on every render.
    if (currentCode === 'zh-Hans') return;
    const target = root.nodeType === Node.TEXT_NODE ? root : root;
    if (target.nodeType === Node.TEXT_NODE) {
      if (shouldSkip(target)) return;
      const source = target.nodeValue;
      const translated = translateText(source);
      if (translated !== source) target.nodeValue = translated;
      return;
    }
    if (target.nodeType !== Node.ELEMENT_NODE && target.nodeType !== Node.DOCUMENT_NODE) return;
    if (target.nodeType === Node.ELEMENT_NODE) translateAttributes(target);
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!shouldSkip(node)) {
          const source = node.nodeValue;
          const translated = translateText(source);
          if (translated !== source) node.nodeValue = translated;
        }
      } else {
        translateAttributes(node);
      }
      node = walker.nextNode();
    }
  }

  function applyDirection(code) {
    const direction = RTL.has(code) ? 'rtl' : 'ltr';
    document.documentElement.lang = code;
    document.documentElement.dir = direction;
    document.body?.classList.toggle('rtl', direction === 'rtl');
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      observer.disconnect();
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          translateSubtree(mutation.target);
        } else if (mutation.type === 'attributes') {
          translateAttributes(mutation.target);
        } else {
          for (const node of mutation.addedNodes) translateSubtree(node);
        }
      }
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['title', 'placeholder', 'aria-label', 'alt'],
      });
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'placeholder', 'aria-label', 'alt'],
    });
  }

  function loadScript(code) {
    return new Promise((resolve, reject) => {
      if (data[code]) {
        resolve(data[code]);
        return;
      }
      const script = document.createElement('script');
      script.src = `i18n/${code}.js`;
      script.onload = () => data[code] ? resolve(data[code]) : reject(new Error(`missing i18n data: ${code}`));
      script.onerror = () => reject(new Error(`failed to load i18n: ${code}`));
      document.head.append(script);
    });
  }

  async function init() {
    document.documentElement.classList.add('i18n-loading');
    currentCode = resolveLanguage();
    applyDirection(currentCode);
    try {
      if (currentCode !== 'zh-Hans') {
        table = await loadScript(currentCode);
        rebuildPatterns();
        if (currentCode !== 'en') {
          try {
            fallback = await loadScript('en');
          } catch {
            fallback = {};
          }
        }
      }
      translateSubtree(document.body);
      // Changing the language reloads the page, so a zh-Hans page never needs
      // to translate nodes added later. Rendering 279 device cards otherwise
      // spent about a third of its time in this observer.
      if (currentCode !== 'zh-Hans') startObserver();
      populateLanguageSelect();
    } finally {
      document.documentElement.classList.remove('i18n-loading');
    }
  }

  function populateLanguageSelect() {
    const select = document.querySelector('#languageSetting');
    if (!select) return;
    const selected = localStorage.getItem(STORAGE_KEY) || 'system';
    select.replaceChildren(...LANGUAGES.map((language) => {
      const option = document.createElement('option');
      option.value = language.code;
      option.textContent = language.code === 'system'
        ? (currentCode === 'zh-Hans' ? '跟随系统' : translateText('跟随系统'))
        : language.name;
      return option;
    }));
    select.value = LANGUAGES.some((language) => language.code === selected) ? selected : 'system';
  }

  function weekdayNames() {
    const formatter = new Intl.DateTimeFormat(currentCode, { weekday: 'narrow' });
    return Array.from({ length: 7 }, (_, index) => (
      formatter.format(new Date(2024, 0, 1 + index))
    ));
  }

  function localizeWeekdays(root = document) {
    const names = weekdayNames();
    root.querySelectorAll('[data-i18n-weekday]').forEach((element) => {
      const index = Number(element.dataset.i18nWeekday) - 1;
      if (index >= 0 && index < names.length) element.textContent = names[index];
    });
  }

  function installLanguageSelect(select) {
    if (!select) return;
    populateLanguageSelect();
    select.addEventListener('change', () => {
      localStorage.setItem(STORAGE_KEY, select.value);
      location.reload();
    });
  }

  window.MihomeI18n = {
    languages: LANGUAGES,
    init,
    t: translateText,
    translate: translateText,
    translateSubtree,
    installLanguageSelect,
    populateLanguageSelect,
    localizeWeekdays,
    weekdayNames,
    get locale() { return currentCode; },
    get direction() { return RTL.has(currentCode) ? 'rtl' : 'ltr'; },
  };

  window.MihomeI18n.register = function register(code, values) {
    data[code] = values;
  };
})();
