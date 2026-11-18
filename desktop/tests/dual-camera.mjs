#!/usr/bin/env node

// 双摄回归：一台物理设备展开成 ch0/ch1 两路，验证列表命名、计数、
// 固定镜头的云台/声音禁用，以及在线状态按物理 did 同步。

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cdp, mockSource, waitFor } from './ui-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const chromeBin = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const uiUrl = pathToFileURL(path.join(repo, 'desktop/ui/index.html')).href;
const failures = [];
let checks = 0;

const expect = (condition, message) => {
  checks += 1;
  if (!condition) failures.push(message);
};

const pageEval = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

let cdp;
let browser;
let profileDir;

try {
  profileDir = await mkdtemp(path.join(tmpdir(), 'mihome-dual-'));
  const debugPort = 9222 + Math.floor(Math.random() * 800);
  browser = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--allow-file-access-from-files',
    '--disable-web-security',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    uiUrl,
  ], { stdio: 'ignore' });

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return response.ok;
  });
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page');
  if (!target) throw new Error('Chrome page target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  cdp = new Cdp(socket);
  const runtimeErrors = [];
  cdp.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      runtimeErrors.push(detail?.exception?.description || detail?.text || 'uncaught exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      runtimeErrors.push(message.params.entry.text);
    }
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__MOCK_SCALE__ = { dualCameras: 1 };
      window.__DUAL_ERRORS__ = [];
      addEventListener('error', (event) => window.__DUAL_ERRORS__.push(String(event.error?.stack || event.message)));
      addEventListener('unhandledrejection', (event) => window.__DUAL_ERRORS__.push(String(event.reason?.stack || event.reason)));`,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      let entries = [];
      try { entries = JSON.parse(window.name || '[]'); } catch {}
      const values = new Map(Array.isArray(entries) ? entries : []);
      const persist = () => { window.name = JSON.stringify([...values]); };
      const storage = {
        getItem: (key) => values.has(String(key)) ? values.get(String(key)) : null,
        setItem: (key, value) => { values.set(String(key), String(value)); persist(); },
        removeItem: (key) => { values.delete(String(key)); persist(); },
        clear: () => { values.clear(); persist(); },
        key: (index) => [...values.keys()][index] ?? null,
        get length() { return values.size; },
      };
      Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
    })();`,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (!localStorage.getItem('mihome.language')) localStorage.setItem('mihome.language', 'zh-Hans');`,
  });
  await pageEval(cdp, `localStorage.setItem('mihome.language', 'zh-Hans'); location.reload(); true`);
  await waitFor(() => pageEval(cdp, `document.readyState === 'complete'`));
  try {
    await waitFor(() => pageEval(
      cdp,
      `Boolean(document.querySelector('#overviewView .page-head'))`,
    ));
  } catch (error) {
    const bootState = await pageEval(cdp, `(() => ({
      readyState: document.readyState,
      bodyText: document.body.innerText.slice(0, 240),
      hasI18n: Boolean(window.MihomeI18n),
      hasInvoke: Boolean(window.__MIHOME_TAURI__?.invoke),
      calls: (window.__MOCK_CALLS__ || []).map((item) => item.command),
      overviewHidden: document.querySelector('#overviewView')?.hidden,
      overviewHtml: document.querySelector('#overviewView')?.innerHTML.slice(0, 280),
      pageErrors: (window.__DUAL_ERRORS__ || []).slice(0, 5),
      logs: (window.__MOCK_CALLS__ || []).filter((item) => item.command === 'log_frontend').map((item) => item.args).slice(-8),
      errors: ${JSON.stringify(runtimeErrors.slice(0, 5))},
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(bootState)}`);
  }

  await pageEval(cdp, `document.querySelector('#cameraNav').click(); true`);
  await waitFor(() => pageEval(cdp, `document.querySelectorAll('#camList .cam-card').length === 4`));

  const list = await pageEval(cdp, `(() => {
    const cards = [...document.querySelectorAll('#camList .cam-card')];
    return {
      count: cards.length,
      fixed: cards.filter((card) => card.textContent.includes('固定画面')).length,
      dids: cards.map((card) => card.dataset.did),
      navCount: document.querySelector('#cameraCountNav')?.textContent,
    };
  })()`);
  expect(list.count === 4, `expected 4 camera streams, got ${list.count}`);
  expect(list.fixed === 1, `expected one fixed-lens card, got ${list.fixed}`);
  expect(list.dids.includes('cam-dual-0:ch0') && list.dids.includes('cam-dual-0:ch1'),
    `dual camera dids missing: ${list.dids.join(',')}`);
  expect(list.navCount === '3', `expected nav count 3 physical cameras, got ${list.navCount}`);

  // 固定镜头：本地画面、云台隐藏、声音按钮禁用。
  await pageEval(cdp, `document.querySelector('.cam-card[data-did="cam-dual-0:ch1"] .pill').click(); true`);
  await waitFor(() => pageEval(cdp, `document.querySelector('#camTitle').textContent.includes('固定画面')`));
  const fixedStage = await pageEval(cdp, `({
    title: document.querySelector('#camTitle').textContent,
    ptzHidden: document.querySelector('#camPtzOverlay').hidden,
    soundDisabled: document.querySelector('#camSound').disabled,
    calls: window.__MOCK_CALLS__.filter((item) => item.command === 'camera_start').map((item) => item.args.dids),
  })`);
  expect(fixedStage.title.includes('固定画面'), `fixed lens title: ${fixedStage.title}`);
  expect(fixedStage.ptzHidden === true, 'fixed lens still shows PTZ controls');
  expect(fixedStage.soundDisabled === true, 'fixed lens sound button is not disabled');
  expect(
    fixedStage.calls.some((dids) => Array.isArray(dids) && dids.includes('cam-dual-0:ch1')),
    'camera_start did not receive the fixed-lens stream id',
  );

  // 主镜头远程画面：云台和声音可用。
  await pageEval(cdp, `document.querySelector('.cam-card[data-did="cam-dual-0:ch0"] .pill.remote').click(); true`);
  await waitFor(() => pageEval(cdp, `document.querySelector('#camTransport').textContent === '远程通道已建立'`));
  const mainStage = await pageEval(cdp, `({
    ptzHidden: document.querySelector('#camPtzOverlay').hidden,
    soundDisabled: document.querySelector('#camSound').disabled,
    remoteDids: window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').map((item) => item.args.did),
  })`);
  expect(mainStage.ptzHidden === false, 'main lens PTZ controls are hidden');
  expect(mainStage.soundDisabled === false, 'main lens sound button is disabled');
  expect(mainStage.remoteDids.includes('cam-dual-0:ch0'), 'remote start missing main-lens did');

  // 在线状态按物理 did 同步到两路画面。
  await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('cam-dual-0', false); window.dispatchEvent(new Event('focus')); true`);
  await waitFor(() => pageEval(
    cdp,
    `['cam-dual-0:ch0', 'cam-dual-0:ch1'].every((did) => document.querySelector('.cam-card[data-did="' + did + '"]')?.classList.contains('offline'))`,
  ));
  const offline = await pageEval(cdp, `['cam-dual-0:ch0', 'cam-dual-0:ch1'].map((did) => document.querySelector('.cam-card[data-did="' + did + '"]')?.classList.contains('offline'))`);
  expect(offline.every(Boolean), `dual camera presence did not reach both lenses: ${JSON.stringify(offline)}`);
  await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('cam-dual-0', true); window.dispatchEvent(new Event('focus')); true`);
  await waitFor(() => pageEval(
    cdp,
    `['cam-dual-0:ch0', 'cam-dual-0:ch1'].every((did) => !document.querySelector('.cam-card[data-did="' + did + '"]')?.classList.contains('offline'))`,
  ));

  const unexpected = runtimeErrors.filter((text) => !text.startsWith('Failed to load resource:'));
  expect(unexpected.length === 0, `runtime errors: ${unexpected.slice(0, 3).join(' | ')}`);
} finally {
  try { cdp?.send('Browser.close'); } catch { /* ignore */ }
  browser?.kill('SIGTERM');
  if (profileDir) {
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      .catch(() => {});
  }
}

console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
