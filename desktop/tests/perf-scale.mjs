#!/usr/bin/env node
// Large-account performance probe. Boots the UI in headless Chrome against the
// offline mock with many synthetic cameras and lights, then measures page
// switches, camera selection, grid startup and idle main-thread work.
//
//   PERF_CAMERAS=150 PERF_LIGHTS=120 node tests/perf-scale.mjs
//
// Exits non-zero when a budget is exceeded or the UI throws.

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
const cameras = Number(process.env.PERF_CAMERAS || 150);
const lights = Number(process.env.PERF_LIGHTS || 120);
const idleMs = Number(process.env.PERF_IDLE_MS || 20000);
// 4x CPU throttling approximates an older Intel Mac running WKWebView.
const cpuThrottle = Number(process.env.PERF_CPU_THROTTLE || 4);
const budgets = {
  pageSwitchMs: Number(process.env.PERF_BUDGET_PAGE_MS || 200),
  renderMs: Number(process.env.PERF_BUDGET_RENDER_MS || 50),
  cameraSelectMs: Number(process.env.PERF_BUDGET_SELECT_MS || 16),
  maxGridVideos: Number(process.env.PERF_BUDGET_GRID_VIDEOS || 9),
  idleLongTaskMs: Number(process.env.PERF_BUDGET_IDLE_LONGTASK_MS || 200),
};
const uiUrl = pathToFileURL(path.join(repo, 'desktop/ui/index.html')).href;

let cdp;
let browser;
let profileDir;

const evaluate = async (expression) => {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};

// Measures synchronous handler time plus the following layout/paint frame.
const timed = (body) => evaluate(`(async () => {
  const started = performance.now();
  ${body}
  const sync = performance.now() - started;
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  return { sync, frame: performance.now() - started };
})()`);

const round = (value) => Number(value.toFixed(1));

try {
  profileDir = await mkdtemp(path.join(tmpdir(), 'mihome-perf-'));
  const debugPort = 9222 + Math.floor(Math.random() * 800);
  browser = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--use-mock-keychain', '--allow-file-access-from-files',
    '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = targets.find((item) => item.type === 'page');
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
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.PERF_WIDTH || 1440), height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__MOCK_SCALE__ = ${JSON.stringify({ cameras, lights })};
      window.__PERF_LONG_TASKS__ = [];
      // Track live intervals so the paging soak can detect leaked watchers.
      const liveIntervals = new Set();
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      window.setInterval = (...args) => { const id = nativeSetInterval(...args); liveIntervals.add(id); return id; };
      window.clearInterval = (id) => { liveIntervals.delete(id); return nativeClearInterval(id); };
      window.__PERF_LIVE_INTERVALS__ = () => liveIntervals.size;
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__PERF_LONG_TASKS__.push({ at: entry.startTime, ms: entry.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
      const store = new Map([
        ['mihome.language', ${JSON.stringify(process.env.PERF_LANGUAGE || 'zh-Hans')}],
        ['mihome-theme', ${JSON.stringify(process.env.PERF_THEME || 'light')}],
        ['mihome-style', ${JSON.stringify(process.env.PERF_STYLE || 'modern')}],
      ]);
      Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: (key) => store.has(String(key)) ? store.get(String(key)) : null,
        setItem: (key, value) => store.set(String(key), String(value)),
        removeItem: (key) => store.delete(String(key)),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() { return store.size; },
      } });`,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: mockSource });
  if (cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });

  const bootStarted = Date.now();
  await cdp.send('Page.navigate', { url: uiUrl });
  await waitFor(() => evaluate(`document.querySelectorAll('#camList .cam-card').length === ${cameras + 2}`), 30000);
  const bootMs = Date.now() - bootStarted;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // Cloud traffic during startup: every get_properties item becomes part of a
  // 20-key /miotspec/prop/get request in the backend.
  const bootCalls = await evaluate(`(() => {
    const counts = {};
    let propertyItems = 0;
    for (const call of window.__MOCK_CALLS__) {
      counts[call.command] = (counts[call.command] || 0) + 1;
      if (call.command === 'get_properties') { propertyItems += call.args.requests.length; (counts.sizes = counts.sizes || []).push(call.args.requests.length); }
    }
    return { counts, propertyItems };
  })()`);

  const metrics = { cameras: cameras + 2, devices: cameras + lights + 9, cpuThrottle, bootMs, bootCalls };
  await waitFor(() => evaluate(`!state.specLoading && state.specs.size > 0`), 30000);
  // Median cost of the render functions that run on refresh, presence sync
  // and spec load. They are global functions in app.js.
  metrics.renderMs = await evaluate(`(() => {
    const measure = (fn) => {
      const samples = [];
      for (let index = 0; index < 7; index += 1) {
        const started = performance.now();
        fn();
        samples.push(performance.now() - started);
      }
      samples.sort((a, b) => a - b);
      return Number(samples[3].toFixed(1));
    };
    return {
      updateChrome: measure(() => updateChrome()),
      renderDevices: measure(() => renderDevices()),
      renderCameras: measure(() => renderCameras()),
      renderOverview: measure(() => renderOverview(true)),
      renderSidebarRooms: measure(() => renderSidebarRooms()),
    };
  })()`);
  const pages = {};
  for (const [name, nav] of [['devices', '#devicesNav'], ['camera', '#cameraNav'], ['overview', '#overviewNav'], ['camera2', '#cameraNav']]) {
    const result = await timed(`document.querySelector('${nav}').click();`);
    pages[name] = round(result.frame);
  }
  metrics.pageSwitchMs = pages;
  // PERF_EVAL='<expression>' prints one value from the loaded large account,
  // handy when a screenshot looks wrong.
  if (process.env.PERF_EVAL) metrics.eval = await evaluate(process.env.PERF_EVAL);
  if (process.env.PERF_SCREENSHOT_DIR) {
    await evaluate(`document.querySelector('#overviewNav').click(); document.querySelector('#main').scrollTop = 900; true`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(process.env.PERF_SCREENSHOT_DIR, 'overview.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(`document.querySelector('#cameraNav').click(); true`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (process.env.PERF_PROFILE) {
    // PERF_PROFILE=renderDevices prints the hottest functions (self time) of
    // one global render function, for finding the next bottleneck.
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    await evaluate(`for (let index = 0; index < 10; index += 1) ${process.env.PERF_PROFILE}(); true`);
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length);
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    for (const id of profile.samples) {
      const frame = byId.get(id).callFrame;
      const key = `${frame.functionName || '(anonymous)'} ${path.basename(frame.url)}:${frame.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + interval / 1000);
    }
    metrics.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([name, ms]) => `${ms.toFixed(1)}ms ${name}`);
  }
  metrics.domNodesOnCameraPage = await evaluate(`document.querySelectorAll('*').length`);
  metrics.cameraPageHeight = await evaluate(`document.querySelector('#main').scrollHeight`);
  if (process.env.PERF_SCREENSHOT_DIR) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(process.env.PERF_SCREENSHOT_DIR, 'camera-page.png'), Buffer.from(shot.data, 'base64'));
  }

  const selects = [];
  for (let index = 0; index < 12; index += 1) {
    const result = await timed(`document.querySelectorAll('#camList .cam-card')[${(index * 13) % (cameras + 2)}].click();`);
    selects.push(result.sync);
  }
  selects.sort((a, b) => a - b);
  metrics.cameraSelectSyncMs = { median: round(selects[6]), max: round(selects.at(-1)) };

  await evaluate(`window.__MOCK_CALLS__.length = 0; true`);
  const localGrid = await timed(`document.querySelector('#camGridToggle').click();`);
  await waitFor(() => evaluate(`window.__MOCK_CALLS__.some((call) => call.command === 'camera_start')`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  metrics.localGrid = await evaluate(`(() => {
    const call = window.__MOCK_CALLS__.find((item) => item.command === 'camera_start');
    return {
      requestedStreams: call ? call.args.dids.length : 0,
      videos: document.querySelectorAll('#camGrid video').length,
      tiles: document.querySelectorAll('#camGrid .cam-tile').length,
    };
  })()`);
  metrics.localGrid.clickMs = round(localGrid.frame);

  // Paging: the next page must open the following cameras, not repeat page 1.
  // The grid opens on the page that holds the selected camera, so step back to
  // page 1 first and then check that "next" moves to page 2.
  await evaluate(`window.__MOCK_CALLS__.length = 0; startCameraGrid(false, 0); true`);
  await waitFor(() => evaluate(`window.__MOCK_CALLS__.some((call) => call.command === 'camera_start')`));
  const firstPage = await evaluate(`window.__MOCK_CALLS__.find((item) => item.command === 'camera_start').args.dids`);
  await evaluate(`window.__MOCK_CALLS__.length = 0; document.querySelector('#camGridNext').click(); true`);
  await waitFor(() => evaluate(`window.__MOCK_CALLS__.some((call) => call.command === 'camera_start')`));
  await new Promise((resolve) => setTimeout(resolve, 300));
  metrics.localGrid.paging = await evaluate(`(() => {
    const call = window.__MOCK_CALLS__.find((item) => item.command === 'camera_start');
    const first = ${JSON.stringify(firstPage)};
    return {
      label: document.querySelector('#camGridPageLabel').textContent,
      pagerVisible: !document.querySelector('#camGridPager').hidden,
      secondPageStreams: call.args.dids.length,
      overlap: call.args.dids.filter((did) => first.includes(did)).length,
    };
  })()`);
  if (process.env.PERF_SCREENSHOT_DIR) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(process.env.PERF_SCREENSHOT_DIR, 'camera-grid-page2.png'), Buffer.from(shot.data, 'base64'));
  }

  // Search narrows the side list without rebuilding it, and the grid pages
  // through the matches only.
  metrics.search = await evaluate(`(async () => {
    const input = document.querySelector('#camSearch');
    const started = performance.now();
    input.value = '仓库摄像头 01';
    input.dispatchEvent(new Event('input'));
    const ms = Number((performance.now() - started).toFixed(1));
    const visible = [...document.querySelectorAll('#camList .cam-card')].filter((card) => !card.hidden).length;
    window.__MOCK_CALLS__.length = 0;
    await startCameraGrid(false, 0);
    const call = window.__MOCK_CALLS__.find((item) => item.command === 'camera_start');
    const result = {
      inputVisible: !input.hidden,
      ms,
      visible,
      count: document.querySelector('#camSideCount').textContent,
      gridDids: call ? call.args.dids : [],
    };
    input.value = '';
    input.dispatchEvent(new Event('input'));
    return result;
  })()`);

  // Presence sync: a camera that goes offline in the device list must update
  // the camera list without reopening the page.
  metrics.presence = await evaluate(`(async () => {
    window.__SET_DEVICE_ONLINE__('cam-scale-0', false);
    await refreshDevicePresence();
    const camera = state.cameras.find((item) => item.did === 'cam-scale-0');
    const card = document.querySelector('#camList .cam-card[data-did="cam-scale-0"]');
    const result = { stateOnline: camera.online, cardOffline: card.classList.contains('offline') };
    window.__SET_DEVICE_ONLINE__('cam-scale-0', true);
    await refreshDevicePresence();
    return result;
  })()`);

  // PERF_STALL=1: one silent camera in a local grid must only mark its own
  // tile; the other eight keep playing and the grid is not rebuilt. Takes
  // about 35 s because the local first-frame timeout is 30 s.
  if (process.env.PERF_STALL) {
    metrics.localStall = await evaluate(`(async () => {
      await startCameraGrid(false, 0);
      const videos = [...document.querySelectorAll('#camGrid video')];
      let frames = 0;
      for (const video of videos.slice(1)) {
        Object.defineProperty(video, 'videoWidth', { get: () => 640 });
        Object.defineProperty(video, 'paused', { get: () => false });
        video.getVideoPlaybackQuality = () => ({ totalVideoFrames: ++frames });
      }
      window.__MOCK_CALLS__.length = 0;
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 34000));
    metrics.localStall = await evaluate(`(() => {
      const statuses = [...document.querySelectorAll('#camGrid .cam-tile')]
        .map((tile) => Boolean(tile.querySelector('.cam-tile-status:not([hidden])')));
      const first = document.querySelector('#camGrid video');
      first.dispatchEvent(new Event('playing'));
      const recovered = !document.querySelector('#camGrid .cam-tile .cam-tile-status:not([hidden])');
      return {
        restarts: window.__MOCK_CALLS__.filter((call) => call.command === 'camera_start').length,
        stalledTiles: statuses.filter(Boolean).length,
        firstTileStalled: statuses[0],
        recovered,
      };
    })()`);
  }

  // A slow remote grid must not block paging: with 4 s relay handshakes the
  // next page should start its own handshakes right away.
  metrics.remotePaging = await evaluate(`(async () => {
    window.__MOCK_REMOTE_DELAY_MS__ = 4000;
    startCameraGrid(true, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.__MOCK_CALLS__.length = 0;
    const started = performance.now();
    document.querySelector('#camGridNext').click();
    while (!window.__MOCK_CALLS__.some((call) => call.command === 'camera_remote_start')
      && performance.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const waitedMs = Math.round(performance.now() - started);
    // Let the in-flight first-page starts finish, then count how many of the
    // first page's cameras were started at all after the flip.
    await new Promise((resolve) => setTimeout(resolve, 4500));
    const firstPage = new Set(gridPageInfo(true, 0).cameras.map((camera) => camera.did));
    const staleStarts = window.__MOCK_CALLS__
      .filter((call) => call.command === 'camera_remote_start' && firstPage.has(call.args.did)).length;
    window.__MOCK_REMOTE_DELAY_MS__ = 0;
    await stopCamera();
    return { waitedMs, staleStarts, label: document.querySelector('#camGridPageLabel').textContent };
  })()`);

  await evaluate(`window.__MOCK_CALLS__.length = 0; true`);
  await evaluate(`document.querySelector('#camRemoteGrid').click(); true`);
  await waitFor(() => evaluate(`document.querySelectorAll('#camGrid video').length > 0`));
  await new Promise((resolve) => setTimeout(resolve, 600));
  metrics.remoteGrid = await evaluate(`({
    remoteStarts: window.__MOCK_CALLS__.filter((item) => item.command === 'camera_remote_start').length,
    videos: document.querySelectorAll('#camGrid video').length,
    tiles: document.querySelectorAll('#camGrid .cam-tile').length,
  })`);
  if (process.env.PERF_SCREENSHOT_DIR) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(process.env.PERF_SCREENSHOT_DIR, 'camera-remote-grid.png'), Buffer.from(shot.data, 'base64'));
  }

  // Clicking a grid tile opens that camera alone over the same transport.
  metrics.tileOpen = await evaluate(`(async () => {
    const tile = document.querySelectorAll('#camGrid .cam-tile')[1];
    const title = tile.querySelector('.cam-tile-title').textContent;
    window.__MOCK_CALLS__.length = 0;
    tile.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const call = window.__MOCK_CALLS__.find((item) => item.command === 'camera_remote_start');
    const camera = state.cameras.find((item) => item.did === call?.args.did);
    return {
      openedSame: camera?.name === title,
      single: document.querySelector('#camGrid').hidden && !document.querySelector('#camLayout').hidden,
      selected: state.selectedCameraDid === call?.args.did,
    };
  })()`);

  // Paging soak: flip local and remote grid pages many times, then stop. Live
  // intervals, stream cleanups and camera watchers must return to baseline.
  metrics.soak = await evaluate(`(async () => {
    await stopCamera();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const baseline = window.__PERF_LIVE_INTERVALS__();
    const heapBefore = performance.memory?.usedJSHeapSize || 0;
    for (let round = 0; round < 20; round += 1) {
      await startCameraGrid(round % 2 === 0, round % 5);
      await settle();
    }
    const during = window.__PERF_LIVE_INTERVALS__();
    await stopCamera();
    await settle();
    return {
      baseline,
      during,
      after: window.__PERF_LIVE_INTERVALS__(),
      streamCleanups: state.streamCleanups.size,
      cameraWatches: state.cameraWatches.size,
      remoteWatches: state.remoteWatches.length,
      restartTimers: state.restartTimers.size,
      gridVideos: document.querySelectorAll('#camGrid video').length,
      heapDeltaMB: Number((((performance.memory?.usedJSHeapSize || 0) - heapBefore) / 1048576).toFixed(2)),
    };
  })()`);

  // Command palette with every device listed: open, arrow past the visible
  // rows, IME Enter must not run an item, and quick controls skip cameras.
  metrics.palette = await evaluate(`(async () => {
    let started = performance.now();
    openPalette();
    const openMs = performance.now() - started;
    const press = (key, extra = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
    started = performance.now();
    for (let index = 0; index < 30; index += 1) press('ArrowDown');
    const arrowMs = (performance.now() - started) / 30;
    const box = document.querySelector('#paletteResults');
    const active = box.querySelector('.palette-item.active');
    const boxRect = box.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    press('Enter', { isComposing: true });
    const stillOpen = document.querySelector('#palette').classList.contains('open');
    closePalette();
    toggleQuickPanel(true);
    const quick = [...document.querySelectorAll('#popGrid .pop-device-label')].map((node) => node.textContent);
    toggleQuickPanel(false);
    return {
      items: box.querySelectorAll('.palette-item').length,
      openMs: Number(openMs.toFixed(1)),
      arrowMs: Number(arrowMs.toFixed(2)),
      activeIndex: Number(active.dataset.paletteIndex),
      activeVisible: rect.top >= boxRect.top - 1 && rect.bottom <= boxRect.bottom + 1,
      imeEnterIgnored: stillOpen,
      quickHasCamera: quick.some((name) => /摄像/.test(name)),
    };
  })()`);

  // Top navigation must not overlap the brand or context area at any width
  // above the 980px icon-only breakpoint.
  metrics.topnavOverlap = [];
  for (const width of [1000, 1080, 1180, 1280, 1440]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))))`);
    const overlap = await evaluate(`(() => {
      const nav = document.querySelector('#mainNav');
      const tabs = nav.querySelector('.topnav-tabs').getBoundingClientRect();
      const hit = ['.topnav-brand .brand-text', '.topnav-context'].find((selector) => {
        const node = nav.querySelector(selector);
        if (!node || !node.offsetWidth) return false;
        const rect = node.getBoundingClientRect();
        return tabs.left < rect.right && rect.left < tabs.right;
      });
      return hit ? { selector: hit, compact: nav.className, tabs: [tabs.left, tabs.right].map(Math.round) } : null;
    })()`);
    if (overlap) metrics.topnavOverlap.push({ width, ...overlap });
    metrics.topnavLevel = metrics.topnavLevel || {};
    metrics.topnavLevel[width] = await evaluate(`[...document.querySelector('#mainNav').classList].filter((name) => name.startsWith('compact-')).pop() || 'full'`);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Number(process.env.PERF_WIDTH || 1440), height: 900, deviceScaleFactor: 1, mobile: false,
  });

  await evaluate(`document.querySelector('#overviewNav').click(); window.__PERF_LONG_TASKS__.length = 0; window.__MOCK_CALLS__.length = 0; true`);
  await new Promise((resolve) => setTimeout(resolve, idleMs));
  metrics.idle = await evaluate(`(() => {
    const tasks = window.__PERF_LONG_TASKS__;
    const counts = {};
    for (const call of window.__MOCK_CALLS__) counts[call.command] = (counts[call.command] || 0) + 1;
    return {
      seconds: ${idleMs / 1000},
      longTasks: tasks.length,
      longTaskTotalMs: Math.round(tasks.reduce((sum, item) => sum + item.ms, 0)),
      calls: counts,
    };
  })()`);
  metrics.heapMB = round(await evaluate(`performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0`));

  const failures = [];
  const slowestPage = Math.max(...Object.values(pages));
  if (slowestPage > budgets.pageSwitchMs) failures.push(`page switch ${slowestPage}ms > ${budgets.pageSwitchMs}ms`);
  for (const [name, ms] of Object.entries(metrics.renderMs)) {
    if (ms > budgets.renderMs) failures.push(`${name} ${ms}ms > ${budgets.renderMs}ms`);
  }
  if (metrics.cameraSelectSyncMs.median > budgets.cameraSelectMs) failures.push(`camera select ${metrics.cameraSelectSyncMs.median}ms > ${budgets.cameraSelectMs}ms`);
  if (metrics.localGrid.requestedStreams > budgets.maxGridVideos) failures.push(`local grid requested ${metrics.localGrid.requestedStreams} streams > ${budgets.maxGridVideos}`);
  if (metrics.localStall && (metrics.localStall.restarts || metrics.localStall.stalledTiles !== 1 || !metrics.localStall.firstTileStalled || !metrics.localStall.recovered)) {
    failures.push(`one stalled local tile affected the grid: ${JSON.stringify(metrics.localStall)}`);
  }
  if (!metrics.tileOpen.openedSame || !metrics.tileOpen.single || !metrics.tileOpen.selected) {
    failures.push(`grid tile click did not open the camera: ${JSON.stringify(metrics.tileOpen)}`);
  }
  if (metrics.remotePaging.staleStarts) failures.push(`previous remote page kept starting cameras: ${JSON.stringify(metrics.remotePaging)}`);
  if (metrics.remotePaging.waitedMs > 1000) failures.push(`remote grid paging waited ${metrics.remotePaging.waitedMs}ms for the previous page`);
  const soak = metrics.soak;
  if (soak.after > soak.baseline || soak.streamCleanups || soak.cameraWatches || soak.remoteWatches
    || soak.restartTimers || soak.gridVideos) {
    failures.push(`resources left after grid paging: ${JSON.stringify(soak)}`);
  }
  const palette = metrics.palette;
  if (palette.activeIndex !== 30 || !palette.activeVisible || !palette.imeEnterIgnored || palette.quickHasCamera
    || palette.arrowMs > 5) {
    failures.push(`command palette / quick panel: ${JSON.stringify(palette)}`);
  }
  if (metrics.topnavOverlap.length) failures.push(`top navigation overlaps: ${JSON.stringify(metrics.topnavOverlap)}`);
  if (metrics.cameraPageHeight > 3000) failures.push(`camera page is ${metrics.cameraPageHeight}px tall; the side list should scroll`);
  const search = metrics.search;
  // 仓库摄像头 010–019 match; offline and IP-less ones are excluded from the local grid.
  const searchOk = search.inputVisible && search.visible === 10 && search.count === `10 / ${cameras + 2}`
    && search.gridDids.length > 0 && search.gridDids.every((did) => /^cam-scale-(9|1[0-8])$/.test(did));
  if (cameras >= 20 && !searchOk) failures.push(`camera search broken: ${JSON.stringify(search)}`);
  if (metrics.presence.stateOnline !== false || !metrics.presence.cardOffline) {
    failures.push(`camera presence not synced: ${JSON.stringify(metrics.presence)}`);
  }
  const paging = metrics.localGrid.paging;
  if (!paging.pagerVisible || !paging.label.startsWith('2 /') || paging.overlap || !paging.secondPageStreams) {
    failures.push(`grid paging broken: ${JSON.stringify(paging)}`);
  }
  if (metrics.localGrid.videos > budgets.maxGridVideos) failures.push(`local grid rendered ${metrics.localGrid.videos} videos > ${budgets.maxGridVideos}`);
  if (metrics.remoteGrid.videos > budgets.maxGridVideos) failures.push(`remote grid rendered ${metrics.remoteGrid.videos} videos > ${budgets.maxGridVideos}`);
  if (metrics.idle.longTaskTotalMs > budgets.idleLongTaskMs) failures.push(`idle long tasks ${metrics.idle.longTaskTotalMs}ms > ${budgets.idleLongTaskMs}ms`);
  if (runtimeErrors.length) failures.push(`runtime errors: ${runtimeErrors.slice(0, 3).join(' | ')}`);
  console.log(JSON.stringify({ ok: failures.length === 0, budgets, metrics, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  try { cdp?.ws?.close(); } catch {}
  try { browser?.kill('SIGTERM'); } catch {}
  if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}
