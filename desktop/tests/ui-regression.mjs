#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LANGUAGES } from '../scripts/i18n-source.mjs';
import { Cdp, mockSource, waitFor } from './ui-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const chromeBin = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const rounds = Number(process.env.UI_REGRESSION_ROUNDS || 10);
const screenshots = process.env.UI_REGRESSION_SCREENSHOTS !== '0';
const outputDir = process.env.UI_REGRESSION_OUTPUT
  || path.join(here, 'artifacts');
const uiUrl = pathToFileURL(path.join(repo, 'desktop/ui/index.html')).href;

const pageEval = async (cdp, expression) => {
  let result;
  try {
    result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
  } catch (error) {
    const preview = expression.replace(/\s+/g, ' ').slice(0, 360);
    throw new Error(`${error.message}: ${preview}`);
  }
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

const click = (selector) => pageEval(cdp, `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) throw new Error('missing selector: ' + ${JSON.stringify(selector)});
  node.click();
  return true;
})()`);

const waitForSelector = (selector) => waitFor(() =>
  pageEval(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`));

let cdp;
let browser;
let profileDir;

try {
  profileDir = await mkdtemp(path.join(tmpdir(), 'mihome-ui-'));
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

  const version = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return response.ok ? response.json() : null;
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
  const ignoredResourceErrors = [];
  const recordRuntimeError = (text) => {
    if (String(text).startsWith('Failed to load resource:')) ignoredResourceErrors.push(String(text));
    else runtimeErrors.push(String(text));
  };
  cdp.onEvent = (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails;
      recordRuntimeError(detail?.exception?.description || detail?.text || 'uncaught exception');
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      recordRuntimeError(message.params.entry.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      recordRuntimeError(text || 'console.error');
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
  await pageEval(cdp, `window.__MIHOME_RELOAD_PROBE__ = 1; localStorage.setItem('mihome.language', 'zh-Hans'); location.reload(); true`);
  await waitFor(() => pageEval(cdp, `document.readyState === 'complete' && window.__MIHOME_RELOAD_PROBE__ === undefined`));
  try {
    await waitForSelector('#overviewView .page-head');
  } catch (error) {
    const bootState = await pageEval(cdp, `(() => ({
      readyState: document.readyState,
      htmlClass: document.documentElement.className,
      loginDisplay: document.querySelector('#loginLayer')?.style.display,
      bodyText: document.body.innerText.slice(0, 240),
      hasI18n: Boolean(window.MihomeI18n),
      hasInvoke: Boolean(window.__MIHOME_TAURI__?.invoke),
      calls: (window.__MOCK_CALLS__ || []).map((item) => item.command),
    }))()`);
    throw new Error(`${error.message}: boot state ${JSON.stringify(bootState)}; runtime errors ${runtimeErrors.slice(0, 3).join(' | ')}`);
  }

  const failures = [];
  const timings = [];
  const screenshotFiles = [];
  let viewportWidth = 1440;
  let viewportHeight = 900;
  let checks = 0;
  const screenshot = async (name) => {
    if (!screenshots) return;
    await pageEval(cdp, `document.querySelectorAll('#toastStack .toast').forEach((node) => node.remove()); true`);
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const buffer = Buffer.from(result.data, 'base64');
    const file = path.join(outputDir, `${name}.png`);
    await writeFile(file, buffer);
    const png = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 0;
    expect(png, `screenshot ${name}: invalid PNG`);
    expect(buffer.length > 2048, `screenshot ${name}: suspiciously small (${buffer.length} bytes)`);
    expect(
      width === viewportWidth && height === viewportHeight,
      `screenshot ${name}: expected ${viewportWidth}x${viewportHeight}, got ${width}x${height}`,
    );
    screenshotFiles.push({ name, file, width, height, bytes: buffer.length });
  };

  const actionTime = async (expression, label) => {
    const result = await pageEval(cdp, `(async () => {
      const start = performance.now();
      ${expression}
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    })()`);
    timings.push({ label, ms: result });
    return result;
  };

  const expect = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };

  if (screenshots) await import('node:fs/promises').then(({ mkdir }) => mkdir(outputDir, { recursive: true }));

  for (let round = 1; round <= rounds; round += 1) {
    await pageEval(cdp, `window.__MIHOME_RELOAD_PROBE__ = 1; location.reload(); true`);
    await waitFor(() => pageEval(cdp, `document.readyState === 'complete' && window.__MIHOME_RELOAD_PROBE__ === undefined`));
    await waitForSelector('#overviewView .page-head');

    const overview = await pageEval(cdp, `({
      title: document.querySelector('#overviewView .page-title')?.textContent,
      rows: document.querySelectorAll('#overviewView .device-row').length,
      hasTopnav: Boolean(document.querySelector('.topnav')),
      hasSidebar: Boolean(document.querySelector('.sidebar')),
      hasStatus: Boolean(document.querySelector('.statusbar')),
      hasMenuBar: Boolean(document.querySelector('#btnMenuBar')),
      hasThemeToggle: Boolean(document.querySelector('#btnTheme svg')),
      hasAddRoom: Boolean(document.querySelector('#btnAddRoom')),
      hasHud: Boolean(document.querySelector('#hud')),
      overflow: document.documentElement.scrollWidth > innerWidth,
    })`);
    expect(overview.hasTopnav && overview.hasSidebar && overview.hasStatus, `round ${round}: shell missing`);
    expect(
      overview.hasMenuBar && overview.hasThemeToggle && overview.hasAddRoom && overview.hasHud,
      `round ${round}: prototype shell controls missing`,
    );
    expect(overview.rows === 10, `round ${round}: expected 10 overview rows, got ${overview.rows}`);
    expect(overview.overflow === false, `round ${round}: horizontal overflow on overview`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#overviewView .device-row[data-did="router1"] .device-meta')?.textContent.includes('连接设备数')`,
    ));
    const routerCard = await pageEval(cdp, `({
      meta: document.querySelector('#overviewView .device-row[data-did="router1"] .device-meta')?.textContent,
      switch: Boolean(document.querySelector('#overviewView .device-row[data-did="router1"] .inline-switch')),
      offline: document.querySelector('#overviewView .device-row[data-did="router1"]')?.classList.contains('off'),
    })`);
    expect(!routerCard.offline, `round ${round}: online router is rendered offline`);
    expect(!routerCard.switch, `round ${round}: router indicator light is exposed as router power`);
    expect(
      !/已关闭|离线/.test(routerCard.meta || ''),
      `round ${round}: router card shows the wrong state: ${routerCard.meta}`,
    );
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#envTempValue')?.textContent.includes('23.6')`,
    ));
    const environment = await pageEval(cdp, `({
      temperature: document.querySelector('#envTempValue')?.textContent,
      humidity: document.querySelector('#envHumidityValue')?.textContent,
      powered: document.querySelector('#envPoweredValue')?.textContent,
      consumable: document.querySelector('#envConsumableValue')?.textContent,
      attention: document.querySelector('#envConsumable')?.classList.contains('attention'),
      capsuleWidth: document.querySelector('#envCapsule')?.getBoundingClientRect().width,
      capsuleRight: document.querySelector('#envCapsule')?.getBoundingClientRect().right,
    })`);
    expect(environment.temperature === '23.6°', `round ${round}: top temperature ${environment.temperature}`);
    expect(environment.humidity === '51%', `round ${round}: top humidity ${environment.humidity}`);
    expect(environment.powered === '5', `round ${round}: top powered count ${environment.powered}`);
    expect(environment.consumable === '1', `round ${round}: top consumable count ${environment.consumable}`);
    expect(environment.attention, `round ${round}: low consumable is not highlighted`);
    expect(
      environment.capsuleWidth > 0 && environment.capsuleRight <= viewportWidth,
      `round ${round}: top environment capsule is clipped`,
    );
    await click('#envCapsule');
    const environmentPopover = await pageEval(cdp, `({
      open: !document.querySelector('#envPopover')?.hidden,
      expanded: document.querySelector('#envCapsule')?.getAttribute('aria-expanded'),
      temp: document.querySelector('#envPopTemp')?.textContent,
      online: document.querySelector('#envPopOnline')?.textContent,
      consumable: document.querySelector('#envPopConsumable')?.textContent,
      inside: document.querySelector('#envPopover')?.getBoundingClientRect().right <= innerWidth,
    })`);
    expect(environmentPopover.open, `round ${round}: environment details did not open`);
    expect(environmentPopover.expanded === 'true', `round ${round}: environment aria-expanded missing`);
    expect(environmentPopover.temp === '23.6 °C', `round ${round}: environment detail temperature ${environmentPopover.temp}`);
    expect(environmentPopover.online === '9 / 10', `round ${round}: environment detail online ${environmentPopover.online}`);
    expect(environmentPopover.consumable === '1 / 1', `round ${round}: environment detail consumable ${environmentPopover.consumable}`);
    expect(environmentPopover.inside, `round ${round}: environment details are clipped`);
    await screenshot(`r${round}-01b-environment-details`);
    await click('#envCapsule');
    await screenshot(`r${round}-01-overview`);

    await click('#btnMenuBar');
    const quickPanel = await pageEval(cdp, `({
      open: document.querySelector('#menubarPop').classList.contains('open'),
      devices: document.querySelectorAll('#popGrid .pop-device').length,
      scenes: document.querySelectorAll('#popScenes button').length,
    })`);
    expect(quickPanel.open, `round ${round}: quick panel did not open`);
    expect(quickPanel.devices > 0 && quickPanel.scenes > 0, `round ${round}: quick panel is empty`);
    await screenshot(`r${round}-02-quick-panel`);
    await click('#popOpen');
    expect(
      await pageEval(cdp, `!document.querySelector('#menubarPop').classList.contains('open')`),
      `round ${round}: quick panel did not close`,
    );

    const themeBefore = await pageEval(cdp, `document.body.dataset.theme`);
    await click('#btnTheme');
    expect(
      await pageEval(cdp, `document.body.dataset.theme !== ${JSON.stringify(themeBefore)}`),
      `round ${round}: titlebar theme toggle failed`,
    );
    await click('#btnTheme');

    await click('#btnHud');
    await waitForSelector('#hud.show');
    const hudState = await pageEval(cdp, `({
      visible: document.querySelector('#hud').classList.contains('show'),
      dom: document.querySelector('#hudDom').textContent,
      inflight: document.querySelector('#hudInflight').textContent,
    })`);
    expect(hudState.visible, `round ${round}: performance HUD did not open`);
    expect(hudState.dom !== '--' && Number(hudState.dom) > 0, `round ${round}: performance HUD has no DOM metric`);
    expect(Number(hudState.inflight) >= 0, `round ${round}: performance HUD has invalid inflight metric`);
    await screenshot(`r${round}-03-performance-hud`);
    await click('#hudClose');

    await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('fan1', false); window.dispatchEvent(new Event('focus')); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('.device-row[data-did="fan1"]')?.classList.contains('off') === true`,
    ));
    await pageEval(cdp, `window.__SET_DEVICE_ONLINE__('fan1', true); window.dispatchEvent(new Event('focus')); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('.device-row[data-did="fan1"]')?.classList.contains('off') === false`,
    ));
    expect(
      await pageEval(cdp, `document.querySelector('.device-row[data-did="fan1"] .device-meta')?.textContent !== '设备离线'`),
      `round ${round}: online device still shows offline metadata`,
    );
    await screenshot(`r${round}-04-device-online-recovered`);

    await actionTime(`document.querySelector('[data-room="living"]')?.click()`, 'room-filter');
    const room = await pageEval(cdp, `({
      title: document.querySelector('#overviewView .page-title')?.textContent,
      rows: document.querySelectorAll('#overviewView .device-row').length,
    })`);
    expect(room.title === '客厅', `round ${round}: room filter title ${room.title}`);
    expect(room.rows === 6, `round ${round}: room filter rows ${room.rows}`);
    await screenshot(`r${round}-05-room-filter`);
    await click('[data-room="all"]');

    for (const [nav, view] of [
      ['#cameraNav', '#cameraView'],
      ['#sceneNav', '#sceneView'],
      ['#automationNav', '#automationView'],
      ['#accessNav', '#accessView'],
      ['#devicesNav', '#devicesView'],
      ['#overviewNav', '#overviewView'],
    ]) {
      await actionTime(`document.querySelector(${JSON.stringify(nav)}).click()`, `nav-${nav.replace(/^#/, '')}`);
      const visible = await pageEval(cdp, `({
        view: !document.querySelector(${JSON.stringify(view)}).hidden,
        active: document.querySelector(${JSON.stringify(nav)}).classList.contains('active'),
        overflow: document.documentElement.scrollWidth > innerWidth,
      })`);
      expect(visible.view, `round ${round}: ${nav} did not show ${view}`);
      expect(visible.active, `round ${round}: ${nav} active state missing`);
      expect(visible.overflow === false, `round ${round}: horizontal overflow on ${nav}`);
    }

    await click('#accessNav');
    const accessPage = await pageEval(cdp, `({
      title: document.querySelector('#accessView .page-title')?.textContent,
      mode: document.querySelector('#accessConnectionMode')?.value,
      webhookFieldsHidden: document.querySelector('#accessVerificationTokenField')?.hidden
        && document.querySelector('#accessEncryptKeyField')?.hidden,
      connection: document.querySelector('#accessConnectionState')?.textContent,
      reconnectHidden: document.querySelector('#accessReconnect')?.hidden,
      helpHidden: document.querySelector('#accessConnectionHelp')?.hidden,
      copyWebhookHidden: document.querySelector('#copyWebhookUrl')?.hidden,
      hasUserGuide: Boolean(document.querySelector('#copyUserOnboarding')),
    })`);
    expect(accessPage.title === '接入中心', `round ${round}: access title ${accessPage.title}`);
    expect(accessPage.mode === 'websocket', `round ${round}: access mode ${accessPage.mode}`);
    expect(accessPage.webhookFieldsHidden, `round ${round}: websocket fields should hide webhook secrets`);
    expect(accessPage.connection === '已连接', `round ${round}: access connection ${accessPage.connection}`);
    expect(accessPage.reconnectHidden, `round ${round}: reconnect should be hidden while connected`);
    expect(accessPage.helpHidden, `round ${round}: connection help should be hidden while connected`);
    expect(accessPage.copyWebhookHidden, `round ${round}: callback copy should be hidden in websocket mode`);
    expect(accessPage.hasUserGuide, `round ${round}: user onboarding guide missing`);

    await pageEval(cdp, `window.__MOCK_SET_CONNECTION__('feishu_ws', {
      running: false,
      state: 'error',
      connected_seconds: null,
      last_error: 'websocket heartbeat timed out',
    })`);
    await click('#accessRefresh');
    await waitFor(() => pageEval(cdp,
      `document.querySelector('#accessReconnect')?.hidden === false`));
    const reconnectVisible = await pageEval(cdp, `({
      label: document.querySelector('#accessReconnect')?.textContent,
      disabled: document.querySelector('#accessReconnect')?.disabled,
      helpVisible: !document.querySelector('#accessConnectionHelp')?.hidden,
      helpTitle: document.querySelector('#accessConnectionHelpTitle')?.textContent,
      helpHint: document.querySelector('#accessConnectionHelpHint')?.textContent,
    })`);
    expect(reconnectVisible.label === '重新连接',
      `round ${round}: reconnect label ${reconnectVisible.label}`);
    expect(reconnectVisible.disabled === false,
      `round ${round}: reconnect should be enabled`);
    expect(reconnectVisible.helpVisible,
      `round ${round}: connection help should be visible after a websocket error`);
    expect(reconnectVisible.helpTitle === '长连接心跳超时',
      `round ${round}: unexpected connection help title ${reconnectVisible.helpTitle}`);
    expect((reconnectVisible.helpHint || '').includes('重新连接'),
      `round ${round}: connection help does not explain recovery`);
    await click('#accessReconnect');
    await waitFor(() => pageEval(cdp,
      `document.querySelector('#accessConnectionState')?.textContent === '已连接'`));
    expect(
      await pageEval(cdp, `document.querySelector('#accessConnectionHelp')?.hidden === true`),
      `round ${round}: connection help did not clear after reconnect`,
    );

    await pageEval(cdp, `document.querySelector('[data-access-platform="wecom"]').click(); true`);
    const wecomAccess = await pageEval(cdp, `({
      label: document.querySelector('#accessAppIdLabel')?.textContent,
      webhookDisabled: document.querySelector('#accessConnectionMode option[value="webhook"]')?.disabled,
    })`);
    expect(wecomAccess.label === 'Bot ID', `round ${round}: wecom credential label ${wecomAccess.label}`);
    expect(wecomAccess.webhookDisabled, `round ${round}: wecom webhook mode should be disabled`);

    await pageEval(cdp, `document.querySelector('[data-access-platform="dingtalk"]').click(); true`);
    const dingtalkAccess = await pageEval(cdp, `({
      label: document.querySelector('#accessAppIdLabel')?.textContent,
      secretLabel: document.querySelector('#accessAppSecretLabel')?.textContent,
      webhookDisabled: document.querySelector('#accessConnectionMode option[value="webhook"]')?.disabled,
      hasAsr: Boolean(document.querySelector('#asrProvider')),
    })`);
    expect(dingtalkAccess.label === 'Client ID', `round ${round}: dingtalk credential label ${dingtalkAccess.label}`);
    expect(dingtalkAccess.secretLabel === 'Client Secret',
      `round ${round}: dingtalk secret label ${dingtalkAccess.secretLabel}`);
    expect(dingtalkAccess.webhookDisabled, `round ${round}: dingtalk webhook mode should be disabled`);
    expect(dingtalkAccess.hasAsr, `round ${round}: asr configuration missing`);

    await pageEval(cdp, `document.querySelector('[data-access-platform="feishu"]').click(); true`);
    await pageEval(cdp, `(() => {
      const select = document.querySelector('#accessConnectionMode');
      select.value = 'webhook';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const webhookAccess = await pageEval(cdp, `({
      mode: document.querySelector('#accessConnectionMode')?.value,
      fieldsVisible: !document.querySelector('#accessVerificationTokenField')?.hidden
        && !document.querySelector('#accessEncryptKeyField')?.hidden,
      callback: document.querySelector('#accessWebhookPath')?.textContent,
      callbackUrl: document.querySelector('#accessWebhookPath')?.dataset.url,
      copyVisible: !document.querySelector('#copyWebhookUrl')?.hidden,
      helpTitle: document.querySelector('#accessConnectionHelpTitle')?.textContent,
    })`);
    expect(webhookAccess.mode === 'webhook' && webhookAccess.fieldsVisible,
      `round ${round}: webhook mode did not reveal verification fields`);
    expect(webhookAccess.callback === 'http://127.0.0.1:17666/v1/platform/feishu',
      `round ${round}: unexpected webhook callback ${webhookAccess.callback}`);
    expect(webhookAccess.callbackUrl === webhookAccess.callback,
      `round ${round}: callback copy value is inconsistent`);
    expect(webhookAccess.copyVisible,
      `round ${round}: callback copy button should be visible in webhook mode`);
    expect(webhookAccess.helpTitle === '本地网关未启动',
      `round ${round}: webhook mode should explain the stopped gateway, got ${webhookAccess.helpTitle}`);

    await click('#devicesNav');
    const devicesPage = await pageEval(cdp, `({
      title: document.querySelector('#devicesView .page-title')?.textContent,
      filters: document.querySelectorAll('#deviceFilters .filter-chip').length,
      rows: document.querySelectorAll('#deviceList .table-row').length,
      hasSearch: Boolean(document.querySelector('#deviceSearch')),
      hasTableHead: Boolean(document.querySelector('#devicesView .table-head')),
    })`);
    expect(devicesPage.title === '全部设备', `round ${round}: devices title ${devicesPage.title}`);
    expect(devicesPage.filters === 4, `round ${round}: expected 4 device filters, got ${devicesPage.filters}`);
    expect(devicesPage.rows === 10, `round ${round}: expected 10 table rows, got ${devicesPage.rows}`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#deviceList .table-row[data-did="router1"] .state-pill')?.textContent === '在线'`,
    ));
    const routerState = await pageEval(cdp, `({
      state: document.querySelector('#deviceList .table-row[data-did="router1"] .state-pill')?.textContent,
      summary: document.querySelector('#deviceList .table-row[data-did="router1"] .table-device')?.textContent,
    })`);
    expect(routerState.state === '在线', `round ${round}: online router shows ${routerState.state}`);
    expect(
      !/关闭|离线/.test(routerState.summary || ''),
      `round ${round}: router summary conflates indicator light with router power`,
    );
    expect(devicesPage.hasSearch && devicesPage.hasTableHead, `round ${round}: devices toolbar is incomplete`);
    await screenshot(`r${round}-06-devices`);
    await pageEval(cdp, `(() => {
      const input = document.querySelector('#deviceSearch');
      input.value = '摄像机';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 2`));
    await screenshot(`r${round}-07-devices-search`);
    await pageEval(cdp, `(() => {
      const input = document.querySelector('#deviceSearch');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-device-filter="local"]').click();
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 1`));
    await screenshot(`r${round}-08-devices-local-filter`);
    await click('[data-device-filter="all"]');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#deviceList .table-row').length === 10`));
    await waitForSelector('#deviceList .table-row[data-did="light1"]');
    await click('#deviceList .table-row[data-did="light1"]');
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector').classList.contains('open')`));
    const inspector = await pageEval(cdp, `({
      open: document.querySelector('#inspector').classList.contains('open'),
      title: document.querySelector('#inspector .detail-heading h3')?.textContent,
      controls: document.querySelectorAll('#inspector .detail-control-row, #inspector .detail-range, #inspector .detail-segment').length,
    })`);
    expect(inspector.open && inspector.title, `round ${round}: inspector did not open`);
    expect(inspector.controls > 0, `round ${round}: inspector has no controls`);
    const setCallsBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'set_property').length`);
    const switched = await pageEval(cdp, `(() => {
      const control = document.querySelector('#inspector .detail-switch:not(:disabled)');
      if (!control) return false;
      control.click();
      return true;
    })()`);
    if (switched) {
      await waitFor(() => pageEval(
        cdp,
        `window.__MOCK_CALLS__.filter((item) => item.command === 'set_property').length > ${setCallsBefore}`,
      ));
    }
    expect(switched, `round ${round}: inspector has no enabled switch`);
    await screenshot(`r${round}-09-device-inspector`);
    await click('#inspector .insp-close');
    await waitForSelector('#deviceList .table-row[data-did="fan1"]');
    await click('#deviceList .table-row[data-did="fan1"]');
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector').classList.contains('open')`));
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .detail-segment').length > 0`));
    const fanLabels = await pageEval(cdp, `[
      ...document.querySelectorAll('#inspector .detail-segment'),
    ].map((node) => node.textContent)`);
    expect(
      !fanLabels.some((label) => label.includes('未知选项') || /unknown option/i.test(label)),
      `round ${round}: inspector exposes untranslatable mode buttons`,
    );
    expect(
      fanLabels.includes('阅读') && fanLabels.includes('照明'),
      `round ${round}: known fan-light modes are missing`,
    );
    await screenshot(`r${round}-09b-fan-inspector`);
    await click('#inspector .insp-close');

    // Energy statistics on a metering plug.
    const statsBefore = await pageEval(cdp, `(window.__MOCK_STATS_QUERIES__ || []).length`);
    await pageEval(cdp, `(() => { state.statsCache.clear(); return true; })()`);
    await click('#deviceList .table-row[data-did="plug1"]');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-chart .stats-bar').length > 0`));
    await pageEval(cdp, `new Promise((resolve) => setTimeout(resolve, 300))`);
    expect(
      await pageEval(cdp, `window.__MOCK_STATS_QUERIES__.length - ${statsBefore} === 1`),
      `round ${round}: opening the plug detail requested statistics more than once`,
    );
    await pageEval(cdp, `document.querySelector('#inspector .stats-tab[data-range="7d"]').click()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-chart .stats-bar').length === 7`));
    const plugStats = await pageEval(cdp, `({
      tabs: [...document.querySelectorAll('#inspector .stats-tab')].map((node) => node.dataset.range),
      active: document.querySelector('#inspector .stats-tab.active')?.dataset.range,
      bars: document.querySelectorAll('#inspector .stats-bar').length,
      missing: document.querySelectorAll('#inspector .stats-fill.missing').length,
      total: document.querySelector('#inspector .stats-figure strong')?.textContent,
      metrics: [...document.querySelectorAll('#inspector .detail-metric-label')].map((node) => node.textContent),
      query: window.__MOCK_STATS_QUERIES__.at(-1),
    })`);
    expect(plugStats.tabs.join(',') === '7d,30d,12m' && plugStats.active === '7d', `round ${round}: stats tabs ${JSON.stringify(plugStats)}`);
    expect(plugStats.missing === 1, `round ${round}: stats should mark one day without records, got ${plugStats.missing}`);
    expect(/kWh$/.test(plugStats.total || ''), `round ${round}: stats total ${plugStats.total}`);
    expect(plugStats.metrics.includes('功率') && plugStats.metrics.includes('用电量'), `round ${round}: plug metrics ${plugStats.metrics}`);
    expect(
      plugStats.query.key === '11.1' && plugStats.query.data_type === 'stat_day_v3' && plugStats.query.limit === 7
        && plugStats.query.time_start < plugStats.query.time_end,
      `round ${round}: stats query ${JSON.stringify(plugStats.query)}`,
    );
    await pageEval(cdp, `document.querySelector('#inspector .stats-tab[data-range="30d"]').click()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-bar').length === 30`));
    await pageEval(cdp, `document.querySelector('#inspector .stats-tab[data-range="12m"]').click()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-bar').length === 12`));
    expect(
      await pageEval(cdp, `window.__MOCK_STATS_QUERIES__.at(-1).data_type === 'stat_month_v3'`),
      `round ${round}: monthly stats used the wrong data type`,
    );
    await screenshot(`r${round}-09c-plug-statistics`);
    const statsCalls = await pageEval(cdp, `window.__MOCK_STATS_QUERIES__.length`);
    await pageEval(cdp, `document.querySelector('#inspector .stats-tab[data-range="7d"]').click()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-bar').length === 7`));
    expect(
      await pageEval(cdp, `window.__MOCK_STATS_QUERIES__.length === ${statsCalls}`),
      `round ${round}: a cached stats range was fetched again`,
    );
    await pageEval(cdp, `(() => { state.statsCache.clear(); window.__MOCK_STATS_ERROR__ = 'mock stats offline'; document.querySelector('#inspector .stats-tab[data-range="30d"]').click(); return true; })()`);
    await waitFor(() => pageEval(cdp, `Boolean(document.querySelector('#inspector .stats-error .stats-retry'))`));
    await pageEval(cdp, `(() => { window.__MOCK_STATS_ERROR__ = null; document.querySelector('#inspector .stats-retry').click(); return true; })()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-bar').length === 30`));
    await pageEval(cdp, `document.querySelector('#inspector .stats-tab[data-range="7d"]').click()`);
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#inspector .stats-bar').length === 7`));
    await click('#inspector .insp-close');
    await click('#deviceList .table-row[data-did="light1"]');
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector').classList.contains('open')`));
    expect(
      await pageEval(cdp, `!document.querySelector('#inspector .stats-section')`),
      `round ${round}: a light without energy metering shows statistics`,
    );
    await click('#inspector .insp-close');

    // Xiao AI speaker: text command, read-aloud and transport keys.
    await click('#deviceList .table-row[data-did="speaker1"]');
    await waitForSelector('#inspector .speaker-section .speaker-input');
    const speakerPanel = await pageEval(cdp, `({
      keys: document.querySelectorAll('#inspector .speaker-key').length,
      silent: Boolean(document.querySelector('#inspector .speaker-silent input')),
      genericActions: [...document.querySelectorAll('#inspector .detail-actions .detail-action')].map((node) => node.textContent),
      volume: Boolean(document.querySelector('#inspector .detail-range input[type="range"]')),
    })`);
    expect(speakerPanel.keys === 4, `round ${round}: speaker transport keys ${speakerPanel.keys}`);
    expect(speakerPanel.silent && speakerPanel.volume, `round ${round}: speaker panel ${JSON.stringify(speakerPanel)}`);
    expect(speakerPanel.genericActions.length === 1, `round ${round}: speaker generic actions ${speakerPanel.genericActions}`);
    const speakerAction = (expression) => pageEval(cdp, `(() => {
      window.__MOCK_ACTIONS__ = [];
      const input = document.querySelector('#inspector .speaker-input');
      ${expression}
      return true;
    })()`);
    const lastAction = () => pageEval(cdp, `window.__MOCK_ACTIONS__.at(-1) || null`);
    await speakerAction(`input.value = '  '; input.form.requestSubmit();`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await lastAction() === null, `round ${round}: an empty speaker command was sent`);
    await speakerAction(`input.value = '打开客厅灯'; input.form.requestSubmit();`);
    await waitFor(async () => Boolean(await lastAction()));
    let sent = await lastAction();
    expect(
      sent.siid === 5 && sent.aiid === 5 && JSON.stringify(sent.params) === JSON.stringify(['打开客厅灯', false]),
      `round ${round}: speaker directive ${JSON.stringify(sent)}`,
    );
    await waitFor(() => pageEval(cdp, `document.querySelector('#inspector .speaker-input').value === '' && !document.querySelector('#inspector .speaker-input').disabled`));
    await speakerAction(`document.querySelector('#inspector .speaker-silent input').click(); input.value = '关窗帘'; input.form.requestSubmit();`);
    await waitFor(async () => Boolean(await lastAction()));
    sent = await lastAction();
    expect(JSON.stringify(sent.params) === JSON.stringify(['关窗帘', true]), `round ${round}: silent directive ${JSON.stringify(sent)}`);
    await waitFor(() => pageEval(cdp, `!document.querySelector('#inspector .speaker-input').disabled`));
    await pageEval(cdp, `document.querySelector('#inspector .speaker-silent input').click()`);
    await speakerAction(`input.value = '晚饭好了'; document.querySelector('#inspector .speaker-send.secondary').click();`);
    await waitFor(async () => Boolean(await lastAction()));
    sent = await lastAction();
    expect(
      sent.siid === 5 && sent.aiid === 1 && JSON.stringify(sent.params) === JSON.stringify(['晚饭好了']),
      `round ${round}: speaker read-aloud ${JSON.stringify(sent)}`,
    );
    await waitFor(() => pageEval(cdp, `!document.querySelector('#inspector .speaker-input').disabled`));
    await speakerAction(`document.querySelector('#inspector .speaker-key[aria-label="播放"]').click();`);
    await waitFor(async () => Boolean(await lastAction()));
    sent = await lastAction();
    expect(sent.siid === 3 && sent.aiid === 1 && sent.params.length === 0, `round ${round}: speaker play ${JSON.stringify(sent)}`);
    await speakerAction(`window.__MOCK_ACTION_ERROR__ = 'mock speaker offline'; input.value = '开灯'; input.form.requestSubmit();`);
    await waitFor(() => pageEval(cdp, `!document.querySelector('#inspector .speaker-input').disabled && window.__MOCK_ACTIONS__.length === 1`));
    expect(
      await pageEval(cdp, `document.querySelector('#inspector .speaker-input').value === '开灯'`),
      `round ${round}: a failed speaker command cleared the text`,
    );
    await pageEval(cdp, `window.__MOCK_ACTION_ERROR__ = null`);
    await screenshot(`r${round}-09d-speaker`);
    await click('#inspector .insp-close');

    await click('#sceneNav');
    await waitFor(() => pageEval(cdp, `document.querySelectorAll('#sceneList .scene-card').length === 3`));
    await screenshot(`r${round}-10-scenes`);
    const beforeScenes = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'run_scene').length`);
    await click('#sceneList [data-run-scene]');
    await waitFor(() => pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'run_scene').length > ${beforeScenes}`));

    await click('#automationNav');
    await waitFor(() => pageEval(cdp, `document.querySelector('#autoForm') !== null`));
    await screenshot(`r${round}-11-automation-form`);
    await pageEval(cdp, `(() => {
      document.querySelector('#autoName').value = '测试定时';
      document.querySelector('#autoTime').value = '08:15';
      document.querySelector('#autoForm').requestSubmit();
      return true;
    })()`);
    await waitFor(() => pageEval(cdp, `window.__MOCK_CALLS__.some((item) => item.command === 'save_automation')`));
    await screenshot(`r${round}-12-automation-created`);
    const toggleAutoBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'toggle_automation').length`);
    await pageEval(cdp, `(() => {
      const input = [...document.querySelectorAll('#autoList [data-toggle-auto]')].at(-1);
      if (!input) throw new Error('new automation toggle missing');
      input.click();
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'toggle_automation').length > ${toggleAutoBefore}`,
    ));
    const deleteAutoBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'delete_automation').length`);
    await pageEval(cdp, `(() => {
      const button = [...document.querySelectorAll('#autoList [data-delete-auto]')].at(-1);
      if (!button) throw new Error('new automation delete missing');
      button.click();
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'delete_automation').length > ${deleteAutoBefore}`,
    ));

    await click('#settingsNav');
    await screenshot(`r${round}-13-settings`);

    // 菜单栏面板的常用设备：弹层列出设备，选两项保存，按钮显示已选数量。
    await click('#settingsQuickDevices');
    await waitForSelector('#quickPickLayer:not([hidden]) .quick-pick-item');
    const pickInitial = await pageEval(cdp, `({
      title: document.querySelector('#quickPickTitle').textContent,
      count: document.querySelectorAll('#quickPickList .quick-pick-item').length,
      checked: document.querySelectorAll('#quickPickList .quick-pick-item[aria-checked="true"]').length,
    })`);
    expect(pickInitial.title.includes('常用设备'), `round ${round}: quick pick title was ${pickInitial.title}`);
    expect(pickInitial.count > 6, `round ${round}: quick pick listed ${pickInitial.count} devices`);
    await pageEval(cdp, `(() => {
      const items = [...document.querySelectorAll('#quickPickList .quick-pick-item')];
      items[2].click(); items[0].click();
      return true;
    })()`);
    const pickSelected = await pageEval(cdp, `({
      checked: document.querySelectorAll('#quickPickList .quick-pick-item[aria-checked="true"]').length,
      count: document.querySelector('#quickPickCount').textContent,
    })`);
    expect(pickSelected.checked === 2, `round ${round}: quick pick selected ${pickSelected.checked} devices`);
    expect(pickSelected.count.includes('2/12'), `round ${round}: quick pick counter was ${pickSelected.count}`);
    await pageEval(cdp, `document.querySelector('#quickPickSave').click(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#quickPickLayer').hidden === true`));
    const devicesLabel = await pageEval(cdp, `document.querySelector('#settingsQuickDevices').textContent`);
    expect(devicesLabel.includes('2'), `round ${round}: devices button was ${devicesLabel}`);
    const savedPrefs = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'save_quick_prefs').at(-1)?.args`);
    expect(
      Array.isArray(savedPrefs?.devices) && savedPrefs.devices.length === 2,
      `round ${round}: save_quick_prefs got ${JSON.stringify(savedPrefs)}`,
    );

    // 常用场景：只选一个，保存后按钮同样显示数量。
    await click('#settingsQuickScenes');
    await waitForSelector('#quickPickLayer:not([hidden]) .quick-pick-item');
    await pageEval(cdp, `document.querySelectorAll('#quickPickList .quick-pick-item')[0].click(); true`);
    const sceneTitle = await pageEval(cdp, `document.querySelector('#quickPickTitle').textContent`);
    expect(sceneTitle.includes('常用场景'), `round ${round}: quick pick scene title was ${sceneTitle}`);
    await pageEval(cdp, `document.querySelector('#quickPickSave').click(); true`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#quickPickLayer').hidden === true`));
    const prefsAfterScenes = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'save_quick_prefs').at(-1)?.args`);
    expect(
      Array.isArray(prefsAfterScenes?.scenes) && prefsAfterScenes.scenes.length === 1,
      `round ${round}: second save lost scenes ${JSON.stringify(prefsAfterScenes)}`,
    );
    expect(
      Array.isArray(prefsAfterScenes?.devices) && prefsAfterScenes.devices.length === 2,
      `round ${round}: saving scenes dropped the device selection ${JSON.stringify(prefsAfterScenes)}`,
    );

    // 关掉弹层不保存，配置应保持上一次的结果。
    const savesBeforeClose = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'save_quick_prefs').length`);
    await click('#settingsQuickDevices');
    await waitForSelector('#quickPickLayer:not([hidden]) .quick-pick-item');
    const reopenedChecked = await pageEval(cdp, `document.querySelectorAll('#quickPickList .quick-pick-item[aria-checked="true"]').length`);
    expect(reopenedChecked === 2, `round ${round}: reopened picker showed ${reopenedChecked} selected`);
    await pageEval(cdp, `document.querySelectorAll('#quickPickList .quick-pick-item')[1].click(); true`);
    await click('#quickPickClose');
    await waitFor(() => pageEval(cdp, `document.querySelector('#quickPickLayer').hidden === true`));
    const savesAfterClose = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'save_quick_prefs').length`);
    expect(savesAfterClose === savesBeforeClose, `round ${round}: closing the picker saved anyway (${savesAfterClose - savesBeforeClose})`);
    const devicesLabelAfterClose = await pageEval(cdp, `document.querySelector('#settingsQuickDevices').textContent`);
    expect(devicesLabelAfterClose.includes('2'), `round ${round}: close changed the label to ${devicesLabelAfterClose}`);

    await click('[data-theme-set="dark"]');
    expect(await pageEval(cdp, `document.body.dataset.theme === 'dark'`), `round ${round}: dark theme failed`);
    await screenshot(`r${round}-14-settings-dark`);
    await click('[data-theme-set="light"]');
    await click('[data-density-set="compact"]');
    expect(await pageEval(cdp, `document.body.dataset.density === 'compact'`), `round ${round}: compact density failed`);
    await screenshot(`r${round}-15-settings-compact`);
    await click('[data-density-set="comfortable"]');
    await click('[data-style-set="classic"]');
    expect(await pageEval(cdp, `document.body.dataset.style === 'classic'`), `round ${round}: classic style failed`);
    await click('#overviewNav');
    await waitForSelector('#overviewView .page-head');
    const classicLayout = await pageEval(cdp, `(() => {
      const list = document.querySelector('#overviewView .device-list');
      const card = document.querySelector('#overviewView .device-card');
      const style = list ? getComputedStyle(list) : null;
      const cardStyle = card ? getComputedStyle(card) : null;
      const cards = [...document.querySelectorAll('#overviewView .device-card')];
      return {
        display: style?.display,
        borderRadius: cardStyle?.borderRadius,
        columns: new Set(cards.map((card) => card.getBoundingClientRect().left)).size,
        cardWidth: cards[0]?.getBoundingClientRect().width || 0,
        heroHidden: getComputedStyle(document.querySelector('#overviewView .hero')).display === 'none',
        singleGrid: document.querySelectorAll('#overviewView .device-list').length === 1,
        roomHeads: document.querySelectorAll('#overviewView .room-head').length,
        roomLabels: cards.every((card) => {
          const label = card.querySelector('.device-room');
          return Boolean(label?.textContent.trim()) && label.offsetParent !== null;
        }),
        controlsFit: cards.every((card) => {
          const control = card.querySelector('.card-top-actions');
          if (!control) return true;
          const cardRect = card.getBoundingClientRect();
          const controlRect = control.getBoundingClientRect();
          return controlRect.left >= cardRect.left - 1 && controlRect.right <= cardRect.right + 1;
        }),
        topActions: document.querySelectorAll('#overviewView .device-card .card-top-actions > button').length,
        lightPower: Boolean(document.querySelector(
          '#overviewView .device-card[data-did="light1"] .card-top-actions .card-power:not(:disabled)',
        )),
        routerReboot: Boolean(document.querySelector(
          '#overviewView .device-card[data-did="router1"] .card-top-actions .card-reboot',
        )),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    })()`);
    expect(classicLayout.display === 'grid', `round ${round}: classic device list is not a grid`);
    expect(classicLayout.borderRadius !== '0px', `round ${round}: classic device cards are not rounded`);
    expect(classicLayout.columns === 4, `round ${round}: classic overview should use 4 columns at 1440px`);
    expect(classicLayout.cardWidth <= 211, `round ${round}: classic cards are too wide (${classicLayout.cardWidth}px)`);
    expect(classicLayout.heroHidden, `round ${round}: classic style did not prioritize device cards`);
    expect(classicLayout.singleGrid, `round ${round}: classic devices are split into multiple grids`);
    expect(classicLayout.roomHeads === 0, `round ${round}: classic style still shows room section headings`);
    expect(classicLayout.roomLabels, `round ${round}: classic cards do not show their room label`);
    expect(classicLayout.controlsFit, `round ${round}: classic card controls overflow their cards`);
    expect(classicLayout.topActions >= 8, `round ${round}: classic card quick actions are missing`);
    expect(classicLayout.lightPower, `round ${round}: classic light card lost its top-right power button`);
    expect(classicLayout.routerReboot, `round ${round}: classic router card lost its reboot button`);
    expect(classicLayout.overflow === false, `round ${round}: horizontal overflow in classic style`);
    await pageEval(cdp, `document.querySelector('#overviewView .device-card[data-did="light1"] .card-top-actions .card-power').click(); true`);
    await waitFor(() => pageEval(cdp, `window.__MOCK_CALLS__.some((call) => call.command === 'set_property' && call.args.did === 'light1')`));
    await screenshot(`r${round}-15b-settings-classic`);
    await click('#settingsNav');
    await click('[data-style-set="modern"]');

    await pageEval(cdp, `document.querySelector('#btnPalette').click(); true`);
    expect(await pageEval(cdp, `document.querySelector('#palette').classList.contains('open')`), `round ${round}: command palette did not open`);
    await pageEval(cdp, `document.querySelector('#paletteInput').value = '客厅'; document.querySelector('#paletteInput').dispatchEvent(new Event('input')); true`);
    expect(await pageEval(cdp, `document.querySelectorAll('#paletteResults .palette-item').length > 0`), `round ${round}: palette search returned no results`);
    await screenshot(`r${round}-16-command-palette`);
    await pageEval(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

    const pageSelectors = [
      ['overview', '#overviewView'],
      ['camera', '#cameraView'],
      ['scenes', '#sceneView'],
      ['automations', '#automationView'],
      ['devices', '#devicesView'],
      ['access', '#accessView'],
      ['settings', '#settingsView'],
    ];
    for (const [width, height] of [[1440, 900], [1180, 800], [980, 680], [720, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = width;
      viewportHeight = height;
      for (const [name, selector] of pageSelectors) {
        await pageEval(cdp, `(() => {
          const nav = ${JSON.stringify(selector)} === '#overviewView' ? '#overviewNav'
            : ${JSON.stringify(selector)} === '#cameraView' ? '#cameraNav'
            : ${JSON.stringify(selector)} === '#sceneView' ? '#sceneNav'
            : ${JSON.stringify(selector)} === '#automationView' ? '#automationNav'
            : ${JSON.stringify(selector)} === '#devicesView' ? '#devicesNav'
            : ${JSON.stringify(selector)} === '#accessView' ? '#accessNav' : '#settingsNav';
          document.querySelector(nav).click();
          return true;
        })()`);
        await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const metrics = await pageEval(cdp, `(() => {
          const page = document.querySelector(${JSON.stringify(selector)});
          const visibleNodes = [...page.querySelectorAll('button, input, select, article, .device-row, .table-row, .scene-card, .auto-row')]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            });
          const clipped = [...page.querySelectorAll('button, input, select')]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0
                && (rect.left < -1 || rect.right > innerWidth + 1);
            })
            .map((node) => node.id || node.className || node.tagName);
          const shellClipped = [...document.querySelectorAll(
            '.titlebar button, .topnav button, .topnav select, .sidebar button, .statusbar button',
          )]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0
                && (rect.left < -1 || rect.right > innerWidth + 1);
            })
            .map((node) => node.id || node.className || node.tagName);
          const describe = (node) => {
            const rect = node.getBoundingClientRect();
            return {
              node: node.id ? '#' + node.id : node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).replace(/\\s+/g, '.') : ''),
              left: Math.round(rect.left * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              clientWidth: node.clientWidth,
              scrollWidth: node.scrollWidth,
              minWidth: getComputedStyle(node).minWidth,
            };
          };
          const pageRect = page.getBoundingClientRect();
          const overflowNodes = [...page.querySelectorAll('*')]
            .filter((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              const beyondPage = rect.right > pageRect.right + 1 || rect.left < pageRect.left - 1;
              const scrollsWithin = node.scrollWidth > node.clientWidth + 1;
              return style.display !== 'none' && style.visibility !== 'hidden'
                && rect.width > 0 && rect.height > 0 && (beyondPage || scrollsWithin);
            })
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
            .slice(0, 8)
            .map(describe);
          return {
            title: page.querySelector('.page-title')?.textContent || '',
            visibleNodes: visibleNodes.length,
            pageWidth: page.clientWidth,
            pageScrollWidth: page.scrollWidth,
            rootWidth: document.documentElement.clientWidth,
            rootScrollWidth: document.documentElement.scrollWidth,
            overflow: page.scrollWidth > page.clientWidth + 1
              || document.documentElement.scrollWidth > innerWidth + 1,
            overflowNodes,
            clipped,
            shellClipped,
          };
        })()`);
        expect(Boolean(metrics.title), `round ${round}, ui ${width}px: ${name} has no title`);
        expect(metrics.visibleNodes > 0, `round ${round}, ui ${width}px: ${name} has no visible interactive content`);
        expect(
          metrics.overflow === false,
          `round ${round}, ui ${width}px: ${name} overflows horizontally `
            + `(page ${metrics.pageScrollWidth}/${metrics.pageWidth}, root ${metrics.rootScrollWidth}/${metrics.rootWidth}, `
            + `nodes ${JSON.stringify(metrics.overflowNodes)})`,
        );
        expect(metrics.clipped.length === 0, `round ${round}, ui ${width}px: ${name} clips ${metrics.clipped.join(', ')}`);
        expect(
          metrics.shellClipped.length === 0,
          `round ${round}, ui ${width}px: shell clips ${metrics.shellClipped.join(', ')}`,
        );
        await screenshot(`r${round}-${name}-${width}`);
      }
      await click('#accountButton');
      await waitForSelector('#accountPop.open');
      const accountPopMetrics = await pageEval(cdp, `(() => {
        const pop = document.querySelector('#accountPop');
        const rect = pop.getBoundingClientRect();
        return {
          inside: rect.left >= -1 && rect.right <= innerWidth + 1
            && rect.top >= -1 && rect.bottom <= innerHeight + 1,
          overflow: pop.scrollWidth > pop.clientWidth + 1,
          cards: pop.querySelectorAll('.account-card').length,
        };
      })()`);
      expect(accountPopMetrics.cards >= 2, `round ${round}, ui ${width}px: account pop is empty`);
      expect(accountPopMetrics.inside, `round ${round}, ui ${width}px: account pop is clipped`);
      expect(!accountPopMetrics.overflow, `round ${round}, ui ${width}px: account pop overflows`);
      await screenshot(`r${round}-account-pop-${width}`);
      await click('#accountPopClose');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    viewportWidth = 1440;
    viewportHeight = 900;

    await click('#cameraNav');
    const localBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_start').length`);
    await click('#camLocalButton');
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_start').length > ${localBefore}`,
    ));
    expect(
      await pageEval(cdp, `document.querySelector('#camLocalButton').classList.contains('active')`),
      `round ${round}: local camera mode did not activate`,
    );
    await screenshot(`r${round}-17-camera-local`);

    const remoteBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').length`);
    await click('#camRemoteButton');
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').length > ${remoteBefore}`,
    ));
    await waitFor(() => pageEval(cdp, `document.querySelector('#camPtzOverlay').hidden === false`));
    expect(
      await pageEval(cdp, `Boolean(document.querySelector('#camTimeline .timeline-session'))`),
      `round ${round}: active camera timeline is missing`,
    );
    await screenshot(`r${round}-18-camera-remote`);

    const ptzBefore = await pageEval(cdp, `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_ptz').length`);
    await pageEval(cdp, `document.querySelector('#camPtzOverlay [data-ptz-dir=\"left\"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_ptz').length > ${ptzBefore}`,
    ));

    await click('#camPause');
    expect(
      await pageEval(cdp, `document.querySelector('#camPause').textContent.includes('继续')`),
      `round ${round}: camera pause did not update its control`,
    );
    await screenshot(`r${round}-19-camera-paused`);
    await click('#camPause');
    expect(
      await pageEval(cdp, `document.querySelector('#camPause').textContent.includes('暂停')`),
      `round ${round}: camera resume did not update its control`,
    );
    await screenshot(`r${round}-20-camera-resumed`);

    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    const accountSwitcher = await pageEval(cdp, `({
      cards: document.querySelectorAll('#accountList .account-card').length,
      active: document.querySelector('#accountList .account-card.active strong')?.textContent,
      hasAdd: Boolean(document.querySelector('#addAccountButton')),
      hasRemove: Boolean(document.querySelector('#removeAccountButton')),
    })`);
    expect(accountSwitcher.cards === 2, `round ${round}: expected 2 saved accounts, got ${accountSwitcher.cards}`);
    expect(accountSwitcher.active === '云栖账号', `round ${round}: wrong active account ${accountSwitcher.active}`);
    expect(accountSwitcher.hasAdd && accountSwitcher.hasRemove, `round ${round}: account actions missing`);
    await screenshot(`r${round}-21-account-switcher`);

    // A delayed response from the old account must never repopulate the new account.
    await pageEval(cdp, `window.__MOCK_DELAY_NEXT__ = { command: 'list_devices', account: 'mock-user', ms: 650 }; window.dispatchEvent(new Event('focus')); true`);
    await pageEval(cdp, `document.querySelector('#accountList [data-account="mock-user-2"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '工作室账号'
        && Boolean(document.querySelector('.device-row[data-did="b-light"]'))`,
    ));
    await new Promise((resolve) => setTimeout(resolve, 750));
    const accountB = await pageEval(cdp, `({
      account: document.querySelector('#accountName')?.textContent,
      home: document.querySelector('#homeSelect')?.selectedOptions[0]?.textContent,
      devices: [...document.querySelectorAll('.device-row')].map((node) => node.dataset.did),
      leaked: Boolean(document.querySelector('.device-row[data-did="light1"]')),
    })`);
    expect(accountB.account === '工作室账号' && accountB.home === '湖畔住宅', `round ${round}: account B did not load its own home`);
    expect(accountB.devices.includes('b-light') && !accountB.leaked, `round ${round}: account A leaked into account B`);
    await screenshot(`r${round}-22-account-b`);

    await click('#accountButton');
    await pageEval(cdp, `document.querySelector('#accountList [data-account="mock-user"]').click(); true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`,
    ));
    expect(
      await pageEval(cdp, `document.querySelectorAll('.device-row').length === 10`),
      `round ${round}: account A did not recover all devices`,
    );
    await screenshot(`r${round}-23-account-a-restored`);

    await pageEval(cdp, `window.__MOCK_DELAY_NEXT__ = { command: 'auth_poll', ms: 900 }; true`);
    await click('#accountButton');
    await click('#addAccountButton');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginTitle')?.textContent === '添加米家账号'`));
    expect(
      await pageEval(cdp, `document.querySelector('#loginBack')?.hidden === false`),
      `round ${round}: add-account back action is hidden`,
    );
    await screenshot(`r${round}-24-add-account`);
    let addAccountClosed = false;
    for (let attempt = 0; attempt < 3 && !addAccountClosed; attempt += 1) {
      await click('#loginBack');
      try {
        await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`), 5000);
        addAccountClosed = true;
      } catch (error) {
        if (attempt === 2) {
          const state = await pageEval(cdp, `({
            layer: document.querySelector('#loginLayer')?.className,
            title: document.querySelector('#loginTitle')?.textContent,
            status: document.querySelector('#statusText')?.textContent,
          })`);
          throw new Error(`round ${round}: cancel add-account did not close login: ${JSON.stringify(state)}`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(
      await pageEval(cdp, `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`),
      `round ${round}: cancelled add-account changed the active account`,
    );
    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    expect(
      await pageEval(cdp, `document.querySelectorAll('#accountList .account-card').length === 2`),
      `round ${round}: cancelled add-account created an account record`,
    );
    await screenshot(`r${round}-25-add-account-cancelled`);
    await click('#accountPopClose');

    await pageEval(cdp, `window.__MOCK_NEXT_LOGIN__ = 'mock-user-3'; window.__MOCK_DELAY_NEXT__ = { command: 'auth_poll', ms: 1200 }; true`);
    await click('#accountButton');
    await click('#addAccountButton');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginTitle')?.textContent === '添加米家账号'`));
    await screenshot(`r${round}-26-add-account-pending`);
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`));
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '创意账号'
        && Boolean(document.querySelector('.device-row[data-did="c-light"]'))`,
    ));
    const accountC = await pageEval(cdp, `({
      device: document.querySelector('.device-row')?.dataset.did,
      leaked: Boolean(document.querySelector('.device-row[data-did="light1"]')),
    })`);
    expect(accountC.device === 'c-light' && !accountC.leaked, `round ${round}: added account reused old device data`);
    await click('#accountButton');
    await waitForSelector('#accountPop.open');
    expect(
      await pageEval(cdp, `document.querySelectorAll('#accountList .account-card').length === 3`),
      `round ${round}: added account is missing from the account switcher`,
    );
    expect(
      await pageEval(cdp, `document.querySelector('#accountState')?.textContent.includes('3 个账号')`),
      `round ${round}: account count did not refresh after adding`,
    );
    await screenshot(`r${round}-27-account-c-added`);
    await click('#accountPopClose');

    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '云栖账号'
        && Boolean(document.querySelector('.device-row[data-did="light1"]'))`,
    ));
    expect(
      await pageEval(cdp, `!document.querySelector('.device-row[data-did="c-light"]')`),
      `round ${round}: removed account data remained visible`,
    );
    await screenshot(`r${round}-28-account-fallback`);

    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#accountName')?.textContent === '工作室账号'
        && Boolean(document.querySelector('.device-row[data-did="b-light"]'))`,
    ));
    await click('#accountButton');
    await click('#removeAccountButton');
    await waitFor(() => pageEval(cdp, `!document.querySelector('#loginLayer').classList.contains('hide')`));
    await new Promise((resolve) => setTimeout(resolve, 520));
    await screenshot(`r${round}-29-login`);
    for (const [width, height] of [[1440, 900], [1180, 800], [980, 680], [720, 900]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = width;
      viewportHeight = height;
      await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const loginMetrics = await pageEval(cdp, `(() => {
        const layer = document.querySelector('#loginLayer');
        const card = layer.querySelector('.login-card');
        const overflow = document.documentElement.scrollWidth > innerWidth + 1
          || layer.scrollWidth > layer.clientWidth + 1;
        const cardRect = card.getBoundingClientRect();
        return {
          visible: getComputedStyle(layer).visibility !== 'hidden',
          overflow,
          cardInside: cardRect.left >= -1 && cardRect.right <= innerWidth + 1,
        };
      })()`);
      expect(loginMetrics.visible, `round ${round}, login ${width}px: layer is hidden`);
      expect(!loginMetrics.overflow, `round ${round}, login ${width}px: horizontal overflow`);
      expect(loginMetrics.cardInside, `round ${round}, login ${width}px: login card is clipped`);
      await screenshot(`r${round}-login-${width}`);
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    viewportWidth = 1440;
    viewportHeight = 900;
    await pageEval(cdp, `window.__MOCK_NEXT_LOGIN__ = 'mock-user'; true`);
    await click('#startAuth');
    await waitFor(() => pageEval(cdp, `document.querySelector('#loginLayer').classList.contains('hide')`));
    expect(
      await pageEval(cdp, `document.querySelector('#accountName').textContent === '云栖账号'`),
      `round ${round}: account did not reload after login`,
    );
    await pageEval(cdp, `(() => {
      window.__MOCK_CALLS__ = [];
      window.__MOCK_LIST_HOMES_ERROR__ = '小米云返回 HTTP 401 Unauthorized';
      window.__MOCK_DELAY_NEXT__ = { command: 'auth_poll', ms: 1800 };
      window.loadHomes();
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `!document.querySelector('#loginLayer').classList.contains('hide')
        && Boolean(document.querySelector('#qrBox svg'))`,
    ), 5000);
    expect(
      await pageEval(
        cdp,
        `window.__MOCK_CALLS__.some((call) => call.command === 'auth_start')`,
      ),
      `round ${round}: expired session did not request a fresh QR code`,
    );
    await pageEval(cdp, `window.__MOCK_LIST_HOMES_ERROR__ = null; true`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#loginLayer').classList.contains('hide')
        && document.querySelector('#accountName').textContent === '云栖账号'`,
    ), 5000);
    await pageEval(cdp, `(() => {
      const select = document.querySelector('#homeSelect');
      select.value = 'home2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#homeSelect').value === 'home2'
        && document.querySelector('#windowTitle').textContent.includes('工作室')`,
    ));
    await pageEval(cdp, `(() => {
      const select = document.querySelector('#homeSelect');
      select.value = 'home1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => pageEval(
      cdp,
      `document.querySelector('#homeSelect').value === 'home1'
        && document.querySelector('#windowTitle').textContent.includes('云栖公寓')`,
    ));
  }

  const i18nRounds = [];
  if (process.env.UI_I18N_ALL === '1') {
    const pageSelectors = [
      ['overview', '#overviewView', '#overviewNav'],
      ['camera', '#cameraView', '#cameraNav'],
      ['scenes', '#sceneView', '#sceneNav'],
      ['automations', '#automationView', '#automationNav'],
      ['devices', '#devicesView', '#devicesNav'],
      ['access', '#accessView', '#accessNav'],
      ['settings', '#settingsView', '#settingsNav'],
    ];
    const pageTitleSources = {
      camera: '监控',
      scenes: '场景',
      automations: '自动化',
      devices: '全部设备',
      access: '接入中心',
      settings: '设置',
    };
    for (const language of LANGUAGES) {
      const code = language.code;
      const rtl = code === 'ar' || code === 'he';
      await pageEval(cdp, `window.__MIHOME_RELOAD_PROBE__ = 1; localStorage.setItem('mihome.language', ${JSON.stringify(code)}); location.reload(); true`);
      await waitFor(() => pageEval(cdp, `document.readyState === 'complete' && window.__MIHOME_RELOAD_PROBE__ === undefined`));
      await waitForSelector('#overviewView .page-head');
      await waitFor(() => pageEval(
        cdp,
        `document.documentElement.lang === ${JSON.stringify(code)}
          && !document.documentElement.classList.contains('i18n-loading')
          && window.MihomeI18n?.locale === ${JSON.stringify(code)}`,
      ));
      const shell = await pageEval(cdp, `({
        lang: document.documentElement.lang,
        direction: document.documentElement.dir,
        rtlClass: document.body.classList.contains('rtl'),
        nav: document.querySelector('#overviewNav > span:last-child')?.textContent,
        expectedNav: window.MihomeI18n.t('总览'),
        monitorNav: document.querySelector('#cameraNav > span:not(.nav-icon):not(.nav-count)')?.textContent,
        expectedMonitor: window.MihomeI18n.t('监控'),
        accessNav: document.querySelector('#accessNav > span:not(.nav-icon):not(.nav-count)')?.textContent,
        expectedAccess: window.MihomeI18n.t('接入'),
        roomsHeading: document.querySelector('#btnAddRoom')?.previousElementSibling?.textContent,
        expectedRoomsHeading: window.MihomeI18n.t('空间'),
        allRooms: document.querySelector('.room-item.all-rooms > span:not(.room-glyph):not(.room-count)')?.textContent,
        expectedAllRooms: window.MihomeI18n.t('全部房间'),
        room: document.querySelector('[data-room="living"] > span:not(.room-glyph):not(.room-count)')?.textContent,
        device: document.querySelector('.device-row[data-did="light1"] .device-name')?.childNodes[0]?.nodeValue,
        bodyText: document.body.innerText,
      })`);
      expect(shell.lang === code, `i18n ${code}: html lang ${shell.lang}`);
      expect(shell.direction === (rtl ? 'rtl' : 'ltr'), `i18n ${code}: direction ${shell.direction}`);
      expect(shell.rtlClass === rtl, `i18n ${code}: rtl body class ${shell.rtlClass}`);
      expect(shell.nav === shell.expectedNav, `i18n ${code}: navigation not translated (${shell.nav} != ${shell.expectedNav})`);
      expect(shell.monitorNav === shell.expectedMonitor, `i18n ${code}: monitor navigation not translated (${shell.monitorNav} != ${shell.expectedMonitor})`);
      expect(shell.accessNav === shell.expectedAccess, `i18n ${code}: integration navigation not translated (${shell.accessNav} != ${shell.expectedAccess})`);
      expect(shell.roomsHeading === shell.expectedRoomsHeading, `i18n ${code}: rooms heading not translated (${shell.roomsHeading} != ${shell.expectedRoomsHeading})`);
      expect(shell.allRooms === shell.expectedAllRooms, `i18n ${code}: all-rooms label not translated (${shell.allRooms} != ${shell.expectedAllRooms})`);
      expect(shell.room === '客厅', `i18n ${code}: room data name was translated (${shell.room})`);
      expect(shell.device === '客厅主灯', `i18n ${code}: device data name was translated (${shell.device})`);
      expect(!/undefined|\[object Object\]|\{\d+\}/.test(shell.bodyText), `i18n ${code}: broken text in overview`);
      expect(!/good noon|الفضاء|uzay|angkasa lepas|أجهزة الانترنت/i.test(shell.bodyText), `i18n ${code}: known context mistranslation visible`);

      for (const [width, height] of [[1440, 900], [720, 900]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        viewportWidth = width;
        viewportHeight = height;
        for (const [name, selector, nav] of pageSelectors) {
          await pageEval(cdp, `document.querySelector(${JSON.stringify(nav)}).click(); true`);
          await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
          const metrics = await pageEval(cdp, `(() => {
            const page = document.querySelector(${JSON.stringify(selector)});
            const visible = (node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            };
            const dataNames = new Set([
              '云栖公寓', '工作室', '湖畔住宅', '创意工作室',
              '云栖账号', '工作室账号', '创意账号',
              '客厅', '书房', '卧室', '未分房间',
            ]);
            const collect = (node) => {
              const text = String(node?.textContent || '').trim();
              if (text.length >= 2 && text.length <= 80) dataNames.add(text);
            };
            document.querySelectorAll([
              '.device-name', '.table-device', '.room-title',
              '.room-item > span:not(.room-glyph):not(.room-count)',
              '.account-text > strong', '#accountName', '#settingsAccount',
              '.cam-card-info > strong', '.cam-tile-title', '.detail-heading h3',
              '.sc-text > strong', '.auto-name', '.pop-device-label',
              '.overview-cam-info > strong', '.scene-pill .sc-text strong',
              '#sceneList .scene-card strong', '.auto-target', '#camSubtitle',
            ].join(',')).forEach(collect);
            page.querySelectorAll('option').forEach(collect);
            const names = [...dataNames].filter((item) => item.length >= 2).sort((a, b) => b.length - a.length);
            const scrubNames = (value) => {
              let text = String(value || '');
              for (const item of names) text = text.split(item).join('');
              return text;
            };
            const sourceText = ${JSON.stringify(code)};
            const checkHan = !['zh-Hans', 'zh-Hant', 'zh-HK', 'ja'].includes(sourceText);
            const leftovers = [];
            if (checkHan) {
              const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
              let node = walker.nextNode();
              while (node) {
                const parent = node.parentElement;
                if (parent && visible(parent) && !parent.closest('[data-i18n-ignore], .device-name, .table-device, .room-title, .account-text > strong, #accountName, #settingsAccount, #camTitle, #camSubtitle, .cam-card-info > strong, .cam-tile-title, .detail-heading > h3, .sc-text > strong, .auto-name, .pop-device-label, #popScenes > button, #homeSelect option, #autoScene option, #pairHome option, .binding-row > strong, .palette-item > span:not(.sub), .overview-cam-info > strong, .scene-pill .sc-text strong')) {
                  const text = scrubNames(node.nodeValue).trim();
                  if (/[\\u3400-\\u9fff]/.test(text)) leftovers.push(text.slice(0, 100));
                }
                node = walker.nextNode();
              }
              for (const node of page.querySelectorAll('[title], [placeholder], [aria-label], [alt]')) {
                if (!visible(node)) continue;
                for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
                  if (!node.hasAttribute(attr)) continue;
                  const text = scrubNames(node.getAttribute(attr)).trim();
                  if (/[\\u3400-\\u9fff]/.test(text)) leftovers.push(attr + '=' + text.slice(0, 100));
                }
              }
            }
            const clipped = [...page.querySelectorAll('button, input, select')]
              .filter((node) => visible(node) && (node.getBoundingClientRect().left < -1 || node.getBoundingClientRect().right > innerWidth + 1))
              .map((node) => node.id || node.className || node.tagName);
            return {
              title: page.querySelector('.page-title')?.textContent || '',
              overflow: document.documentElement.scrollWidth > innerWidth + 1 || page.scrollWidth > page.clientWidth + 1,
              clipped,
              broken: /undefined|\\[object Object\\]|\\{\\d+\\}/.test(page.innerText),
              leftovers: leftovers.slice(0, 8),
            };
          })()`);
          const expectedTitle = pageTitleSources[name]
            ? await pageEval(cdp, `window.MihomeI18n.t(${JSON.stringify(pageTitleSources[name])})`)
            : null;
          expect(Boolean(metrics.title), `i18n ${code}, ${width}px: ${name} has no title`);
          expect(!expectedTitle || metrics.title === expectedTitle, `i18n ${code}, ${width}px: ${name} title "${metrics.title}" != "${expectedTitle}"`);
          expect(!metrics.overflow, `i18n ${code}, ${width}px: ${name} overflows horizontally`);
          expect(metrics.clipped.length === 0, `i18n ${code}, ${width}px: ${name} clips ${metrics.clipped.join(', ')}`);
          expect(!metrics.broken, `i18n ${code}, ${width}px: ${name} contains broken text`);
          expect(
            metrics.leftovers.length === 0,
            `i18n ${code}, ${width}px: ${name} has untranslated text: ${metrics.leftovers.join(' | ')}`,
          );
        }
        if (width === 1440) {
          await pageEval(cdp, `document.querySelector('#devicesNav').click(); true`);
          for (const did of ['plug1', 'speaker1']) {
            await waitForSelector(`#deviceList .table-row[data-did="${did}"]`);
            await click(`#deviceList .table-row[data-did="${did}"]`);
            await waitFor(() => pageEval(cdp, did === 'plug1'
              ? `document.querySelectorAll('#inspector .stats-bar').length > 0`
              : `Boolean(document.querySelector('#inspector .speaker-input'))`));
            // The panel slides open; measure once it has reached its final width.
            await waitFor(() => pageEval(cdp, `(() => {
              const box = document.querySelector('#inspector');
              const head = box.querySelector('.detail-head');
              return Boolean(head) && box.getBoundingClientRect().width >= head.getBoundingClientRect().width - 1;
            })()`));
            const detail = await pageEval(cdp, `(() => {
              const box = document.querySelector('#inspector');
              const checkHan = !['zh-Hans', 'zh-Hant', 'zh-HK', 'ja'].includes(${JSON.stringify(code)});
              const leftovers = [];
              if (checkHan) {
                const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
                for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                  if (node.parentElement.closest('.detail-heading > h3, .detail-sub')) continue;
                  if (/[\\u3400-\\u9fff]/.test(node.nodeValue)) leftovers.push(node.nodeValue.trim().slice(0, 60));
                }
                for (const node of box.querySelectorAll('[title], [placeholder], [aria-label]')) {
                  for (const attr of ['title', 'placeholder', 'aria-label']) {
                    const text = node.getAttribute(attr) || '';
                    if (/[\\u3400-\\u9fff]/.test(text)) leftovers.push(attr + '=' + text.slice(0, 60));
                  }
                }
              }
              const right = box.getBoundingClientRect().right;
              const clipped = [...box.querySelectorAll('button, input, .stats-figure')]
                .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().right > right + 1)
                .map((node) => node.className || node.tagName);
              return {
                leftovers: leftovers.slice(0, 8),
                clipped,
                broken: /undefined|NaN|\\[object Object\\]|\\{\\d+\\}/.test(box.innerText),
              };
            })()`);
            expect(detail.leftovers.length === 0, `i18n ${code}: ${did} detail has untranslated text: ${detail.leftovers.join(' | ')}`);
            expect(detail.clipped.length === 0, `i18n ${code}: ${did} detail clips ${detail.clipped.join(', ')}`);
            expect(!detail.broken, `i18n ${code}: ${did} detail contains broken text`);
            if (['en', 'ar', 'de', 'ja'].includes(code)) await screenshot(`i18n-${code}-${did}-detail`);
            await click('#inspector .insp-close');
          }
        }
      }
      for (const [width, height] of [[1440, 900], [720, 900]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        viewportWidth = width;
        viewportHeight = height;
        await click('#settingsNav');
        await click('[data-style-set="classic"]');
        await click('#overviewNav');
        await waitForSelector('#overviewView .page-head');
        const classic = await pageEval(cdp, `(() => {
          const list = document.querySelector('#overviewView .device-list');
          const card = document.querySelector('#overviewView .device-card');
          return {
            style: document.body.dataset.style,
            display: list ? getComputedStyle(list).display : null,
            rounded: card ? getComputedStyle(card).borderRadius !== '0px' : false,
            columns: new Set([...document.querySelectorAll('#overviewView .device-card')]
              .map((row) => row.getBoundingClientRect().left)).size,
            cardWidth: card?.getBoundingClientRect().width || 0,
            singleGrid: document.querySelectorAll('#overviewView .device-list').length === 1,
            roomLabels: [...document.querySelectorAll('#overviewView .device-card')].every((row) => (
              Boolean(row.querySelector('.device-room')?.textContent.trim())
            )),
            topActions: document.querySelectorAll('#overviewView .device-card .card-top-actions > button').length,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          };
        })()`);
        expect(classic.style === 'classic', `i18n ${code}, ${width}px: classic style did not stick`);
        expect(classic.display === 'grid', `i18n ${code}, ${width}px: classic cards are not in a grid`);
        expect(classic.rounded, `i18n ${code}, ${width}px: classic cards lost their radius`);
        expect(
          classic.columns === (width >= 1000 ? 4 : 2),
          `i18n ${code}, ${width}px: classic overview columns were ${classic.columns}`,
        );
        if (width >= 1000) {
          expect(
            classic.cardWidth <= 211,
            `i18n ${code}, ${width}px: classic cards are too wide (${classic.cardWidth}px)`,
          );
        }
        expect(classic.singleGrid, `i18n ${code}, ${width}px: classic cards are split into multiple grids`);
        expect(classic.roomLabels, `i18n ${code}, ${width}px: classic cards lost their room labels`);
        expect(classic.topActions >= 8, `i18n ${code}, ${width}px: classic card quick actions are missing`);
        expect(!classic.overflow, `i18n ${code}, ${width}px: classic style overflows horizontally`);
        await screenshot(`i18n-${code}-classic-${width}`);
        await click('#settingsNav');
        await click('[data-style-set="modern"]');
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      viewportWidth = 1440;
      viewportHeight = 900;
      await pageEval(cdp, `document.querySelector('#overviewNav').click(); true`);
      await pageEval(cdp, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      await screenshot(`i18n-${code}-overview-1440`);
      i18nRounds.push({ locale: code, direction: rtl ? 'rtl' : 'ltr' });
    }
  }

  const heap = await pageEval(cdp, `performance.memory ? performance.memory.usedJSHeapSize : 0`);
  const dom = await pageEval(cdp, `document.querySelectorAll('*').length`);
  const slowestInteraction = timings.reduce(
    (slowest, current) => current.ms > slowest.ms ? current : slowest,
    { label: 'none', ms: 0 },
  );
  const maxTiming = slowestInteraction.ms;
  const interactionBudget = screenshots ? 600 : 350;
  expect(
    maxTiming < interactionBudget,
    `performance: ${slowestInteraction.label} interaction wait ${maxTiming.toFixed(1)}ms (budget ${interactionBudget}ms)`,
  );
  expect(runtimeErrors.length === 0, `runtime errors: ${runtimeErrors.slice(0, 5).join(' | ')}`);
  if (screenshots) {
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      rounds,
      checks,
      screenshots: screenshotFiles,
      failures,
    }, null, 2));
  }
  console.log(JSON.stringify({
    ok: failures.length === 0,
    rounds,
    checks,
    screenshots: screenshotFiles.length,
    screenshotDir: screenshots ? outputDir : null,
    maxInteractionMs: Number(maxTiming.toFixed(2)),
    domNodes: dom,
    heapMB: Number((heap / 1048576).toFixed(2)),
    runtimeErrors,
    ignoredResourceErrors,
    i18nLocales: i18nRounds.length,
    i18nRounds,
    failures,
  }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  try { cdp?.ws?.close(); } catch {}
  try { browser?.kill('SIGTERM'); } catch {}
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
