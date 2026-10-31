const invoke = window.__MIHOME_TAURI__?.invoke;
const $ = (selector) => document.querySelector(selector);
const SPEC_BATCH_SIZE = 128;
const MAX_REMOTE_STREAMS = 6;
const MAX_REMOTE_START_CONCURRENCY = 3;
const REMOTE_FIRST_FRAME_TIMEOUT = 15000;
const CAMERA_STALL_INTERVALS = 6;
const log = window.MiLog || Object.freeze({
  debug() {}, info() {}, warn() {}, error() {},
});

for (const eventName of ['copy', 'cut', 'dragstart', 'selectstart', 'contextmenu']) {
  document.addEventListener(eventName, (event) => event.preventDefault(), true);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2800);
}

const state = {
  homes: [], devices: [], scenes: [], automations: [], homeId: null, selected: null,
  polling: false, loggedIn: false, cameras: [], cameraStreams: [], cameraGrid: false,
  selectedCameraDid: null, roomFilter: 'all', activeCamera: null, remoteActive: false,
  remoteWatch: null, remoteWatches: [], cameraGeneration: 0, cameraControlsRequest: 0,
  cameraStopSequence: 0,
  cameraQueue: Promise.resolve(),
  restartingCameras: new Set(), restartTimers: new Map(), cardProps: new Map(),
  remoteAudio: new Map(),
  videoPlayers: new WeakMap(), streamCleanups: new Set(),
  hydratedCards: new Set(), cardObserver: null, cardHydrationQueue: new Map(),
  cardHydrationTimer: null, specs: new Map(), specErrors: new Map(), specLoading: false, specPending: new Set(),
  devicesRequest: 0, inspectorRequest: 0, scenesRequest: 0, camerasRequest: 0,
};

function setStatus(text, kind = '') {
  $('#loginStatus').textContent = text;
  $('#loginStatus').className = `status ${kind}`;
  const dot = $('#connDot');
  dot.className = `dot ${kind === 'error' ? 'err' : state.loggedIn ? 'on' : ''}`;
  $('#connText').textContent = state.loggedIn ? '已连接' : kind === 'error' ? '连接失败' : '未登录';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function runLimited(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function queueCameraOperation(operation) {
  const result = state.cameraQueue.then(operation, operation);
  state.cameraQueue = result.catch(() => {});
  return result;
}

function attachCameraStream(video, stream, camera, generation) {
  const previous = state.videoPlayers.get(video);
  if (previous) {
    previous();
    state.streamCleanups.delete(previous);
  }
  const name = camera?.name || stream.id;
  if (!window.MiCameraPlayer) {
    video.src = stream.url;
    video.load();
    video.play().catch(() => {});
    return;
  }
  const transportCleanup = window.MiCameraPlayer.play(video, stream, {
    onMode: (mode, detail) => {
      log.info('Camera', `${name} 播放模式：${mode}${detail ? `（${detail}）` : ''}`);
    },
    onError: (mode, error) => {
      log.warn('Camera', `${name} ${mode} 播放失败：${error}`);
    },
    onDiagnostics: (mode, detail) => {
      log.debug('Camera', `${name} ${mode} 媒体诊断：${JSON.stringify(detail)}`);
    },
  });
  const cleanup = () => {
    transportCleanup();
    state.streamCleanups.delete(cleanup);
  };
  state.videoPlayers.set(video, cleanup);
  state.streamCleanups.add(cleanup);
}

async function startAuth() {
  if (!invoke) {
    setStatus('请从 MiHome Mac 桌面应用打开这个页面', 'error');
    return;
  }
  $('#startAuth').disabled = true;
  setStatus('正在向小米申请二维码…');
  log.info('Auth', '开始申请登录二维码');
  try {
    const result = await invoke('auth_start');
    $('#qrBox').innerHTML = result.qr_svg;
    setStatus('等待扫码，二维码 5 分钟内有效');
    state.polling = true;
    pollAuth();
  } catch (error) {
    log.error('Auth', `申请二维码失败：${error}`);
    setStatus(`申请二维码失败：${error}`, 'error');
    $('#startAuth').disabled = false;
  }
}

async function pollAuth() {
  while (state.polling) {
    try {
      const result = await invoke('auth_poll');
      if (result.status === 'success') {
        state.polling = false;
        state.loggedIn = true;
        setStatus(`登录成功，用户 ${result.user_id}`);
        if (result.message) toast(result.message, true);
        await loadHomes();
        log.info('Auth', '扫码登录成功');
        return;
      }
      if (result.status === 'error') {
        log.error('Auth', `扫码登录失败：${result.message || '未知错误'}`);
        state.polling = false;
        setStatus(result.message || '登录失败', 'error');
        $('#startAuth').disabled = false;
        return;
      }
      setStatus('等待扫码中…');
    } catch (error) {
      const text = String(error);
      if (text.includes('没有进行中的登录') || text.includes('二维码已过期')) {
        log.warn('Auth', text);
        state.polling = false;
        setStatus(text.includes('过期') ? '二维码已过期，请重新生成' : '登录会话已结束，请重新生成二维码', 'error');
        $('#startAuth').disabled = false;
        return;
      }
      // A dropped long poll is not a failed login. Keep waiting until the QR expires.
      setStatus('连接中断，正在重试…');
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

async function loadHomes() {
  try {
    const homes = await invoke('list_homes');
    state.homes = homes;
    if (!homes.length) throw new Error('账号下没有家庭');
    state.homeId = homes[0].id;
    renderHomeTabs();
    await loadDevices();
    log.info('Home', `已加载家庭 ${homes.length} 个`);
    $('#loginView').hidden = true;
    $('#devicesView').hidden = false;
    document.querySelector('.main').classList.add('devices-mode');
    $('#reload').hidden = false;
    $('#logout').hidden = false;
    for (const id of ['cameraNav', 'sceneNav', 'automationNav']) {
      $('#' + id).disabled = false;
    }
    $('#pageTitle').textContent = homes[0].name;
  } catch (error) {
    log.error('Home', `读取家庭失败：${error}`);
    state.loggedIn = false;
    $('#logout').hidden = true;
    setStatus(`读取家庭失败：${error}`, 'error');
    $('#startAuth').disabled = false;
  }
}

function renderHomeTabs() {
  const box = $('#homeTabs');
  box.replaceChildren();
  for (const home of state.homes) {
    const button = el('button', `tab ${home.id === state.homeId ? 'active' : ''}`, home.name);
    button.onclick = async () => {
      state.homeId = home.id;
      state.roomFilter = 'all';
      renderHomeTabs();
      await loadDevices();
      if (state.homeId === home.id) $('#pageTitle').textContent = home.name;
    };
    box.append(button);
  }
}

function currentHome() {
  return state.homes.find((home) => home.id === state.homeId);
}

function roomName(device) {
  if (device.room_name) return device.room_name;
  const room = currentHome()?.rooms?.find((item) => item.id === device.room_id);
  return room?.name || '未分房间';
}

function roomGroups() {
  const home = currentHome();
  const rooms = home?.rooms || [];
  const known = new Set(rooms.map((room) => room.id));
  const groups = [];
  for (const room of rooms) {
    const devices = state.devices.filter((device) => device.room_id === room.id);
    if (devices.length) groups.push({ id: room.id, name: room.name, devices });
  }
  const unassigned = state.devices.filter((device) => !device.room_id || !known.has(device.room_id));
  if (unassigned.length) groups.push({ id: 'unassigned', name: '未分房间', devices: unassigned });
  return groups;
}

function setNavCount(id, count) {
  const node = $('#' + id);
  if (node) node.textContent = count ? String(count) : '';
}

function renderRoomBar() {
  const bar = $('#roomBar');
  bar.replaceChildren();
  if (!state.devices.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const groups = roomGroups();
  const chips = [{ id: 'all', name: '全部', count: state.devices.length }, ...groups.map((group) => ({ id: group.id, name: group.name, count: group.devices.length }))];
  if (!chips.some((chip) => chip.id === state.roomFilter)) state.roomFilter = 'all';
  for (const chip of chips) {
    const button = el('button', `room-chip ${state.roomFilter === chip.id ? 'active' : ''}`);
    button.append(el('span', '', chip.name), el('small', '', String(chip.count)));
    button.onclick = () => {
      state.roomFilter = chip.id;
      renderDevices();
    };
    bar.append(button);
  }
}

async function loadDevices() {
  const request = ++state.devicesRequest;
  const homeId = state.homeId;
  $('#deviceList').replaceChildren(el('div', 'empty', '正在读取设备…'));
  try {
    const devices = await invoke('list_devices', { homeId });
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    state.devices = devices;
    state.cardProps = new Map();
    state.hydratedCards = new Set();
    setNavCount('devicesCount', devices.length);
    renderDevices();
    $('#inspector').replaceChildren(el('p', 'muted', '选一台设备，查看状态和控制。'));
    loadDeviceSpecs(devices);
  } catch (error) {
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    $('#deviceList').replaceChildren(el('div', 'empty error', `读取设备失败：${error}`));
  }
}

const DEVICE_ICONS = window.MiIcons.icons;
const deviceKind = window.MiIcons.kindFor;
const { profileFromSpec, summarizeCardMetrics, formatArrayValue } = window.MiCapabilities;

function deviceGlyph(device) {
  const kind = deviceKind(device);
  const body = DEVICE_ICONS[kind] || DEVICE_ICONS.generic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function propKey(did, siid, piid) {
  return `${did}:${siid}:${piid}`;
}

function cardValue(device, siid, piid) {
  return state.cardProps.get(propKey(device.did, siid, piid));
}

function specFor(device) {
  return device.spec_type ? state.specs.get(device.spec_type) : null;
}

function hasSpecAction(device, siid, aiid) {
  return Boolean(specFor(device)?.services?.some((service) =>
    service.iid === siid && service.actions?.some((action) => action.iid === aiid)));
}

function cardProfile(device) {
  const kind = deviceKind(device);
  const spec = specFor(device);
  const specError = device.spec_type ? state.specErrors.get(device.spec_type) : null;
  const fallbackNote = device.spec_type && state.specPending.has(device.spec_type)
    ? '正在读取设备规格…'
    : specError
      ? `设备规格读取失败：${specError}`
      : '没有找到公开 MIoT-Spec，当前不提供写入控制。';
  const base = spec
    ? profileFromSpec(spec)
    : { metrics: [], controls: [], actions: [], note: fallbackNote };
  let action = null;
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    action = { label: '查看监控', kind: 'camera' };
  } else if (kind === 'router' && hasSpecAction(device, 2, 1)) {
    action = { label: '重启', kind: 'reboot', top: true };
  } else if (kind === 'tv' && hasSpecAction(device, 2, 1)) {
    action = { label: '电源', kind: 'tv-power', top: true };
  }
  return { ...base, action };
}

async function loadDeviceSpecs(devices) {
  const types = [...new Set(devices.map((device) => device.spec_type).filter(Boolean))];
  const missing = types.filter((type) => !state.specs.has(type) && !state.specPending.has(type));
  if (!missing.length) return;
  state.specLoading = true;
  for (const type of missing) state.specPending.add(type);
  let failedBatches = 0;
  try {
    for (let offset = 0; offset < missing.length; offset += SPEC_BATCH_SIZE) {
      const chunk = missing.slice(offset, offset + SPEC_BATCH_SIZE);
      try {
        const batch = await invoke('get_device_specs', { specTypes: chunk });
        for (const [type, spec] of Object.entries(batch.specs || {})) {
          state.specs.set(type, spec);
          state.specErrors.delete(type);
        }
        for (const error of batch.errors || []) {
          const type = chunk.find((candidate) => String(error).startsWith(candidate)) || String(error);
          state.specErrors.set(type, error);
          console.warn(error);
        }
      } catch (error) {
        failedBatches += 1;
        for (const type of chunk) state.specErrors.set(type, String(error));
      }
    }
    if (failedBatches) toast(`有 ${failedBatches} 批设备规格读取失败`, true);
  } finally {
    for (const type of missing) state.specPending.delete(type);
    state.specLoading = false;
    state.hydratedCards.clear();
    renderDevices();
    if (!$('#cameraView').hidden) {
      renderCameras();
      if (state.activeCamera && state.cameraStreams.length) {
        renderCameraControls(state.activeCamera, state.remoteActive);
      }
    } else if (!$('#devicesView').hidden && state.selected) {
      const selected = state.devices.find((device) => device.did === state.selected.did);
      if (selected) selectDevice(selected);
    }
  }
}

function ensureCardObserver() {
  if (state.cardObserver || !('IntersectionObserver' in window)) return state.cardObserver;
  state.cardObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const device = state.devices.find((item) => item.did === entry.target.dataset.did);
      if (device) queueCardHydration(device);
    }
  }, { rootMargin: '360px 0px' });
  return state.cardObserver;
}

function observeDeviceCard(card, device) {
  if (state.hydratedCards.has(device.did)) return;
  const observer = ensureCardObserver();
  if (observer) observer.observe(card);
  else queueCardHydration(device);
}

function queueCardHydration(device) {
  if (state.hydratedCards.has(device.did)) return;
  state.cardHydrationQueue.set(device.did, device);
  if (state.cardHydrationTimer) return;
  state.cardHydrationTimer = setTimeout(flushCardHydration, 90);
}

function propertyRequestsForDevice(device) {
  const profile = cardProfile(device);
  return [...profile.metrics, ...profile.controls]
    .filter((item) => item.readable !== false)
    .map((item) => ({ did: device.did, siid: item.siid, piid: item.piid }));
}

async function flushCardHydration() {
  state.cardHydrationTimer = null;
  const devices = [...state.cardHydrationQueue.values()];
  state.cardHydrationQueue.clear();
  if (!devices.length) return;
  const requests = devices.flatMap(propertyRequestsForDevice);
  const currentHome = state.homeId;
  const request = state.devicesRequest;
  if (requests.length) {
    try {
      const result = await invoke('get_properties', { requests });
      if (currentHome !== state.homeId || request !== state.devicesRequest) return;
      for (const item of Array.isArray(result) ? result : []) {
        if (!item || !item.did || (item.code && item.code !== 0)) continue;
        state.cardProps.set(propKey(item.did, item.siid, item.piid), item.value);
      }
    } catch (_) {
      // Cards remain usable as shortcuts when a model exposes no readable properties.
    }
  }
  for (const device of devices) {
    state.hydratedCards.add(device.did);
    refreshDeviceCard(device);
  }
}

function formatCardValue(value, def) {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'boolean') return value ? '开' : '关';
  if (Array.isArray(value)) {
    return formatArrayValue(value);
  }
  if (typeof value === 'object') return '—';
  if (def.options) {
    const option = def.options.find(([key]) => String(key) === String(value));
    if (option) {
      const label = String(option[1] ?? '').trim();
      return /^-?\d+(?:\.\d+)?$/.test(label) ? '未知' : label;
    }
  }
  const numeric = typeof value === 'number'
    || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()));
  if (!numeric) return formatArrayValue([value]) || '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (def.suffix?.startsWith('storage-')) {
    const bytes = Math.max(0, number) * 1024;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unit = units[0];
    for (let index = 1; index < units.length && amount >= 1024; index += 1) {
      amount /= 1024;
      unit = units[index];
    }
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${unit}`;
  }
  if (!def.unit && Math.abs(number) >= 1000) {
    return new Intl.NumberFormat('zh-CN').format(number);
  }
  return `${number.toFixed(def.digits ?? 0)}${def.unit || ''}`;
}

async function setCardProp(device, siid, piid, value) {
  const result = await invoke('set_property', { did: device.did, siid, piid, value });
  const item = Array.isArray(result) ? result[0] : result;
  if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
  state.cardProps.set(propKey(device.did, siid, piid), value);
  refreshDeviceCard(device);
}

function cardReboot(device) {
  const button = el('button', 'card-power card-reboot');
  button.type = 'button';
  button.disabled = !device.online;
  button.title = '重启路由器';
  button.setAttribute('aria-label', '重启路由器');
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.1M20 5v6h-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!confirm(`重启「${device.name}」？网络会中断约 1 分钟。`)) return;
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('重启指令已发送');
    } catch (error) {
      toast(`重启失败：${error}`, true);
    } finally {
      button.disabled = !device.online;
    }
  };
  return button;
}

async function refreshAfterTvPower(device) {
  const request = ++state.devicesRequest;
  const homeId = state.homeId;
  try {
    const devices = await invoke('list_devices', { homeId });
    if (request !== state.devicesRequest || homeId !== state.homeId) return;
    state.devices = devices;
    state.cardProps = new Map();
    state.hydratedCards = new Set();
    setNavCount('devicesCount', devices.length);
    renderDevices();
    const updated = devices.find((item) => item.did === device.did);
    if (updated) selectDevice(updated);
  } catch (error) {
    toast(`刷新电视状态失败：${error}`, true);
  }
}

function cardTvPower(device) {
  const button = el('button', 'card-power off');
  button.type = 'button';
  button.title = device.online ? '关机' : '开机';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!device.online) {
      toast('电视当前离线，暂不支持远程开机；先用电视遥控开机。');
      return;
    }
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('已发送关机指令，几秒后电视会下线。');
      setTimeout(() => refreshAfterTvPower(device), 5000);
    } catch (error) {
      toast(`关机指令失败：${error}`, true);
    } finally {
      button.disabled = false;
    }
  };
  return button;
}

function cardPower(device, def) {
  const on = Boolean(cardValue(device, def.siid, def.piid));
  const button = el('button', `card-power ${on ? 'on' : 'off'}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.title = `${def.label} ${on ? '已开启' : '已关闭'}`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(on));
  const bulb = def.label.includes('灯') || def.label.includes('照明');
  button.innerHTML = bulb
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.3 2.2h4.6c.2-1 .7-1.7 1.3-2.2A6 6 0 0 0 12 3Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  button.onclick = async (event) => {
    event.stopPropagation();
    const next = !on;
    button.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
    } catch (error) {
      button.disabled = false;
      toast(`设置失败：${error}`, true);
    }
  };
  return button;
}

function cardToggle(device, def) {
  const row = el('label', 'card-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(cardValue(device, def.siid, def.piid));
  input.disabled = !device.online;
  input.onclick = (event) => event.stopPropagation();
  input.onchange = async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
    } catch (error) {
      input.checked = !next;
      toast(`设置失败：${error}`, true);
    } finally {
      input.disabled = false;
    }
  };
  const copy = el('span', 'card-toggle-copy');
  copy.append(el('span', '', def.label));
  copy.append(el('small', '', input.checked ? '已开启' : '已关闭'));
  const track = el('span', 'card-switch-track');
  track.append(el('span', 'card-switch-knob'));
  row.append(copy, input, track);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardRange(device, def) {
  const row = el('label', 'card-range');
  const head = el('span', 'card-range-head');
  head.append(el('span', '', def.label));
  const current = cardValue(device, def.siid, def.piid);
  const step = Number(def.step) > 0 ? Number(def.step) : 1;
  const digits = Number.isFinite(Number(def.digits))
    ? Number(def.digits)
    : step < 1 ? 1 : 0;
  const displayValue = (value) => `${Number(value).toFixed(digits)}${def.suffix || ''}`;
  const output = el('small', '', current === undefined ? '—' : displayValue(current));
  head.append(output);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(def.min);
  range.max = String(def.max);
  range.step = String(step);
  range.value = String(current ?? def.min);
  range.disabled = !device.online;
  range.oninput = () => {
    output.textContent = displayValue(range.value);
  };
  range.onchange = async () => {
    const next = Number(range.value);
    range.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, next);
      output.textContent = displayValue(next);
    } catch (error) {
      toast(`设置失败：${error}`, true);
    } finally {
      range.disabled = false;
    }
  };
  row.append(head, range);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardSegments(device, def) {
  const row = el('div', 'card-segments');
  row.append(el('span', 'card-segments-label', def.label));
  const group = el('div', 'card-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', 'card-segment', label);
    button.type = 'button';
    button.classList.toggle('active', String(current) === String(value));
    button.disabled = !device.online;
    button.onclick = async (event) => {
      event.stopPropagation();
      try {
        await setCardProp(device, def.siid, def.piid, value);
      } catch (error) {
        toast(`设置失败：${error}`, true);
      }
    };
    group.append(button);
  }
  row.append(group);
  row.onclick = (event) => event.stopPropagation();
  return row;
}

function cardAction(device, action) {
  const button = el('button', 'card-action', action.label);
  button.type = 'button';
  button.onclick = async (event) => {
    event.stopPropagation();
    if (action.kind === 'camera') {
      await showCameras();
      await startRemoteCamera(device);
    } else {
      await selectDevice(device);
    }
  };
  return button;
}

function cardSummary(device, profile) {
  if (!device.online) return '设备离线';
  const summary = summarizeCardMetrics(
    profile,
    (def) => cardValue(device, def.siid, def.piid),
  );
  if (summary) return summary;
  if (profile.controls.length) {
    const range = profile.controls.find((item) => item.type === 'range');
    if (range && (range.suffix || range.unit)) {
      const value = cardValue(device, range.siid, range.piid);
      const number = Number(value);
      if (value !== undefined && value !== null && Number.isFinite(number)) {
        return `${range.label} ${number.toFixed(0)}${range.suffix || range.unit || ''}`;
      }
    }
  }
  const primary = profile.controls.find((item) => item.primary);
  if (primary) {
    const value = cardValue(device, primary.siid, primary.piid);
    if (value !== undefined && value !== null) return value ? '已开启' : '已关闭';
  }
  return '在线';
}

function renderDeviceCard(device) {
  const profile = cardProfile(device);
  const kind = deviceKind(device);
  const family = window.MiIcons.familyFor(kind);
  const card = el('article', `device-card ${state.selected?.did === device.did ? 'active' : ''} ${device.online ? '' : 'offline'}`);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${device.name}，${roomName(device)}`);
  card.dataset.family = family;
  card.dataset.did = device.did;

  const top = el('div', 'device-card-top');
  const glyph = el('span', 'device-glyph');
  glyph.dataset.kind = kind;
  glyph.dataset.family = family;
  glyph.innerHTML = deviceGlyph(device);
  top.append(glyph);

  const topActions = el('div', 'card-top-actions');
  const primary = profile.controls.find((item) => item.primary);
  if (primary) topActions.append(cardPower(device, primary));
  else if (profile.action?.top && profile.action.kind === 'tv-power') topActions.append(cardTvPower(device));
  else if (profile.action?.top) topActions.append(cardReboot(device));
  top.append(topActions);
  card.append(top);

  const title = el('div', 'device-card-title');
  title.append(el('strong', 'device-card-name', device.name));
  const subline = el('div', 'card-subline');
  subline.append(el('span', 'device-room', roomName(device)));
  subline.append(el('span', 'card-subline-sep', '·'));
  subline.append(el('span', 'card-summary', cardSummary(device, profile)));
  title.append(subline);
  card.append(title);

  card.onclick = () => selectDevice(device);
  card.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectDevice(device);
    }
  };
  return card;
}

function refreshDeviceCard(device) {
  const old = [...document.querySelectorAll('.device-card')]
    .find((node) => node.dataset.did === device.did);
  if (!old) return;
  const replacement = renderDeviceCard(device);
  old.replaceWith(replacement);
  observeDeviceCard(replacement, device);
}

function renderDevices() {
  const list = $('#deviceList');
  for (const card of list.querySelectorAll('.device-card')) {
    state.cardObserver?.unobserve(card);
  }
  list.replaceChildren();
  if (!state.devices.length) {
    list.append(el('div', 'empty', '这个家庭没有设备'));
    $('#roomBar').hidden = true;
    return;
  }
  const groups = roomGroups();
  renderRoomBar();
  const target = state.roomFilter === 'all'
    ? state.devices
    : groups.find((group) => group.id === state.roomFilter)?.devices || [];
  if (!target.length) {
    list.append(el('div', 'empty', '这个房间还没有设备'));
    return;
  }
  for (const device of target) {
    const card = renderDeviceCard(device);
    list.append(card);
    observeDeviceCard(card, device);
  }
  // Keep the first screen responsive even when IntersectionObserver callbacks are
  // delayed (for example while the WebView window is in the background).
  for (const device of target.slice(0, 8)) queueCardHydration(device);
}

function inspectorProfile(device) {
  const base = cardProfile(device);
  const metrics = [...base.metrics];
  const controls = base.controls.map((item) => ({ ...item, group: item.group || '控制' }));
  const note = base.note || (deviceKind(device) === 'tv' && !device.online
    ? '电视离线。云端不能远程开机；手机米家走的是本地通道。'
    : '');
  return { ...base, metrics, controls, note };
}

function inspectorRequests(device, profile) {
  const seen = new Set();
  const requests = [];
  for (const item of [...profile.metrics, ...profile.controls]) {
    if (item.readable === false) continue;
    const key = `${item.siid}:${item.piid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push({ did: device.did, siid: item.siid, piid: item.piid });
  }
  return requests;
}

async function selectDevice(device) {
  const request = ++state.inspectorRequest;
  state.selected = device;
  renderDevices();
  renderInspector(device, null, true);
  const profile = inspectorProfile(device);
  try {
    const result = await invoke('get_properties', { requests: inspectorRequests(device, profile) });
    if (request !== state.inspectorRequest || state.selected?.did !== device.did) return;
    for (const item of Array.isArray(result) ? result : []) {
      if (!item || !item.did || (item.code && item.code !== 0)) continue;
      state.cardProps.set(propKey(item.did, item.siid, item.piid), item.value);
    }
    renderInspector(device);
  } catch (error) {
    if (request !== state.inspectorRequest || state.selected?.did !== device.did) return;
    renderInspector(device, String(error));
  }
}

function detailMetric(value, def) {
  const card = el('div', 'detail-metric');
  card.append(el('span', 'detail-metric-label', def.label));
  card.append(el('strong', '', formatCardValue(value, def)));
  return card;
}

function detailToggle(device, def) {
  const value = Boolean(cardValue(device, def.siid, def.piid));
  const row = el('div', `detail-control-row${def.primary ? ' primary' : ''}`);
  const copy = el('div', 'detail-control-copy');
  copy.append(el('span', 'detail-control-label', def.label));
  copy.append(el('small', 'detail-control-state', value ? '已开启' : '已关闭'));
  const button = el('button', `detail-switch ${value ? 'on' : ''}`);
  button.type = 'button';
  button.disabled = !device.online;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(value));
  button.setAttribute('aria-label', `${def.label}${value ? '已开启' : '已关闭'}`);
  button.innerHTML = '<span></span>';
  button.onclick = async () => {
    button.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, !value);
      renderInspector(device);
    } catch (error) {
      toast(`设置失败：${error}`, true);
      button.disabled = false;
    }
  };
  row.append(copy, button);
  return row;
}

function detailRange(device, def) {
  const raw = cardValue(device, def.siid, def.piid);
  const row = el('label', 'detail-range');
  const head = el('div', 'detail-range-head');
  head.append(el('span', 'detail-control-label', def.label));
  const step = Number(def.step) > 0 ? Number(def.step) : 1;
  const digits = Number.isFinite(Number(def.digits))
    ? Number(def.digits)
    : step < 1 ? 1 : 0;
  const displayValue = (value) => `${Number(value).toFixed(digits)}${def.suffix || ''}`;
  const output = el('strong', '', raw === undefined ? '—' : displayValue(raw));
  head.append(output);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(step);
  input.value = String(Number.isFinite(Number(raw)) ? raw : def.min);
  input.disabled = !device.online;
  input.oninput = () => { output.textContent = displayValue(input.value); };
  input.onchange = async () => {
    input.disabled = true;
    try {
      await setCardProp(device, def.siid, def.piid, Number(input.value));
      output.textContent = displayValue(input.value);
    } catch (error) {
      toast(`设置失败：${error}`, true);
    } finally {
      input.disabled = false;
    }
  };
  row.append(head, input);
  return row;
}

function detailSegments(device, def) {
  const row = el('div', 'detail-segments');
  row.append(el('span', 'detail-control-label', def.label));
  const group = el('div', 'detail-segment-group');
  const current = cardValue(device, def.siid, def.piid);
  for (const [value, label] of def.options) {
    const button = el('button', `detail-segment${String(current) === String(value) ? ' active' : ''}`, label);
    button.type = 'button';
    button.disabled = !device.online;
    button.onclick = async () => {
      try {
        await setCardProp(device, def.siid, def.piid, value);
        renderInspector(device);
      } catch (error) {
        toast(`设置失败：${error}`, true);
      }
    };
    group.append(button);
  }
  row.append(group);
  return row;
}

function detailControl(device, def) {
  if (def.type === 'toggle') return detailToggle(device, def);
  if (def.type === 'range') return detailRange(device, def);
  if (def.type === 'segments') return detailSegments(device, def);
  return null;
}

function detailAction(device) {
  const kind = deviceKind(device);
  if (kind === 'camera-ptz' || kind === 'camera-fixed') {
    const button = el('button', 'detail-action', '查看实时画面');
    button.type = 'button';
    button.onclick = async () => { await showCameras(); await startRemoteCamera(device); };
    return button;
  }
  if (kind === 'router') {
    if (!hasSpecAction(device, 2, 1)) return null;
    const button = el('button', 'detail-action danger', '重启路由器');
    button.type = 'button';
    button.onclick = async () => {
      if (!confirm(`重启「${device.name}」？网络会中断约 1 分钟。`)) return;
      button.disabled = true;
      button.textContent = '正在发送…';
      try {
        await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
        toast('重启指令已发送');
      } catch (error) {
        toast(`重启失败：${error}`, true);
      } finally {
        button.disabled = false;
        button.textContent = '重启路由器';
      }
    };
    return button;
  }
  return null;
}

function detailSpecActions(device, profile) {
  const kind = deviceKind(device);
  const actions = (profile.actions || []).filter((action) =>
    !((kind === 'router' || kind === 'tv') && action.siid === 2 && action.aiid === 1));
  if (!actions.length) return null;
  const section = el('section', 'detail-section');
  section.append(el('h4', '', '设备动作'));
  const list = el('div', 'detail-actions');
  for (const action of actions) {
    const button = el('button', 'detail-action secondary', action.label);
    button.type = 'button';
    button.disabled = !device.online;
    button.onclick = async () => {
      if (!confirm(`执行「${action.label}」？`)) return;
      button.disabled = true;
      try {
        await invoke('call_action', {
          did: device.did, siid: action.siid, aiid: action.aiid, params: [],
        });
        toast(`已执行：${action.label}`);
      } catch (error) {
        toast(`动作失败：${error}`, true);
      } finally {
        button.disabled = !device.online;
      }
    };
    list.append(button);
  }
  section.append(list);
  return section;
}

function tvActionButton(device, label, siid, aiid, className = '') {
  const button = el('button', `tv-key ${className}`.trim());
  button.type = 'button';
  button.textContent = label;
  const available = hasSpecAction(device, siid, aiid);
  button.disabled = !device.online || !available;
  button.hidden = !available;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.onclick = async () => {
    button.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid, aiid, params: [] });
      toast(`已发送：${label}`);
    } catch (error) {
      toast(`操作失败：${error}`, true);
    } finally {
      button.disabled = !device.online;
    }
  };
  return button;
}

function detailTvRemote(device) {
  const section = el('section', 'detail-section tv-section');
  section.append(el('h4', '', '遥控'));
  const remote = el('div', 'tv-remote');
  const top = el('div', 'tv-remote-top');
  const power = el('button', `tv-power ${device.online ? 'on' : 'off'}`);
  power.type = 'button';
  power.hidden = !hasSpecAction(device, 2, 1);
  power.title = device.online ? '关机' : '电视离线，暂不支持远程开机';
  power.setAttribute('aria-label', power.title);
  power.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  power.onclick = async () => {
    if (!device.online) {
      toast('电视当前离线，暂不支持远程开机；先用电视遥控开机。');
      return;
    }
    power.disabled = true;
    try {
      await invoke('call_action', { did: device.did, siid: 2, aiid: 1, params: [] });
      toast('已发送关机指令，几秒后电视会下线。');
      setTimeout(() => refreshAfterTvPower(device), 5000);
    } catch (error) {
      toast(`关机指令失败：${error}`, true);
    } finally {
      power.disabled = false;
    }
  };
  const volume = el('div', 'tv-volume');
  volume.append(tvActionButton(device, '−', 7, 11, 'tv-small'), el('span', 'tv-volume-label', '音量'), tvActionButton(device, '+', 7, 12, 'tv-small'));
  top.append(power, volume);
  remote.append(top);

  const dpad = el('div', 'tv-dpad');
  dpad.append(tvActionButton(device, '↑', 7, 8, 'tv-dir tv-up'));
  dpad.append(tvActionButton(device, '←', 7, 6, 'tv-dir tv-left'));
  dpad.append(tvActionButton(device, 'OK', 7, 10, 'tv-ok'));
  dpad.append(tvActionButton(device, '→', 7, 7, 'tv-dir tv-right'));
  dpad.append(tvActionButton(device, '↓', 7, 9, 'tv-dir tv-down'));
  remote.append(dpad);

  const bottom = el('div', 'tv-remote-bottom');
  bottom.append(
    tvActionButton(device, '⌂', 7, 2, 'tv-small'),
    tvActionButton(device, '↩', 7, 5, 'tv-small'),
    tvActionButton(device, '☰', 7, 3, 'tv-small'),
    tvActionButton(device, '⚙', 7, 4, 'tv-small')
  );
  remote.append(bottom);

  const extra = el('div', 'tv-extra');
  extra.append(
    tvActionButton(device, '播放', 3, 1),
    tvActionButton(device, '暂停', 3, 2),
    tvActionButton(device, '播放/暂停', 7, 13),
    tvActionButton(device, '截图', 7, 17)
  );
  remote.append(extra);
  section.append(remote);
  return section;
}

function renderInspector(device, error, loading = false) {
  const box = $('#inspector');
  const profile = inspectorProfile(device);
  const kind = deviceKind(device);
  const family = window.MiIcons.familyFor(kind);
  box.replaceChildren();
  box.scrollTop = 0;

  const head = el('div', 'detail-head');
  const icon = el('span', 'detail-icon');
  icon.dataset.family = family;
  icon.innerHTML = deviceGlyph(device);
  head.append(icon);
  const heading = el('div', 'detail-heading');
  heading.append(el('h3', '', device.name));
  const sub = el('p', 'detail-sub');
  sub.append(el('span', '', roomName(device)));
  sub.append(el('span', 'detail-dot', '·'));
  sub.append(el('span', `detail-online ${device.online ? 'on' : ''}`, device.online ? '在线' : '离线'));
  heading.append(sub);
  head.append(heading);
  box.append(head);

  if (error) box.append(el('p', 'detail-error', `读取设备状态失败：${error}`));
  else if (loading) box.append(el('p', 'detail-loading', '正在读取设备状态…'));

  const metrics = profile.metrics.filter((item) => !item.secondary || item.label === '电量' || kind === 'door-lock');
  if (metrics.length) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', '状态'));
    const grid = el('div', 'detail-metrics');
    for (const def of metrics) grid.append(detailMetric(cardValue(device, def.siid, def.piid), def));
    section.append(grid);
    box.append(section);
  }

  if (profile.note) box.append(el('p', 'detail-note', profile.note));

  if (kind === 'tv' && specFor(device)) box.append(detailTvRemote(device));

  const groups = new Map();
  for (const def of profile.controls) {
    const group = def.group || '控制';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(def);
  }
  for (const [name, items] of groups) {
    const section = el('section', 'detail-section');
    section.append(el('h4', '', name));
    for (const def of items) {
      const control = detailControl(device, def);
      if (control) section.append(control);
    }
    box.append(section);
  }

  const action = detailAction(device);
  if (action) {
    const section = el('section', 'detail-section');
    section.append(action);
    box.append(section);
  }
  const specActions = detailSpecActions(device, profile);
  if (specActions) box.append(specActions);

  if (!metrics.length && !profile.controls.length && !action && !specActions) {
    box.append(el('p', 'detail-empty', device.online ? '这台设备当前没有可读写的属性。' : '设备离线，暂时读不到状态。'));
  }

}

async function setPower(device, value) {
  try {
    await setCardProp(device, 2, 1, value);
    renderInspector(device);
  } catch (error) {
    renderInspector(device, String(error));
  }
}

async function showDevices() {
  await stopCamera();
  $('#cameraView').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = true;
  $('#devicesView').hidden = false;
  document.querySelector('.main').classList.add('devices-mode');
  document.querySelector('.main').scrollTop = 0;
  $('#reload').hidden = false;
  $('#pageTitle').textContent = state.homes.find((home) => home.id === state.homeId)?.name || '设备';
  for (const id of ['devicesNav', 'cameraNav', 'sceneNav', 'automationNav']) {
    $('#' + id).classList.toggle('active', id === 'devicesNav');
  }
}

function sceneTone(index) {
  return ['amber', 'ink', 'blue', 'dusk'][index % 4];
}

function sceneIcon(name) {
  const text = String(name);
  const kind = /夜|晚安|睡眠/.test(text) ? 'night-light' : /影|电视|观影|影音/.test(text) ? 'tv' : /帘|窗/.test(text) ? 'curtain' : /离家|外出|离开/.test(text) ? 'smart-button' : 'light';
  const body = DEVICE_ICONS[kind] || DEVICE_ICONS.generic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function sceneListHTML() {
  if (!state.scenes.length) {
    return `<div class="empty">还没有手动场景。先在米家 App 的“智能 → 手动控制”里创建一个。</div>`;
  }
  return state.scenes
    .map((scene, index) => {
      const tone = sceneTone(index);
      const icon = sceneIcon(scene.name);
      return `<article class="scene-card" data-tone="${tone}">
        <div class="scene-art"><span class="orb a"></span><span class="orb b"></span><span class="orb c"></span><span class="sc-ic">${icon}</span></div>
        <div class="scene-info">
          <div class="scene-text"><h3>${esc(scene.name)}</h3><p>${scene.id ? `ID ${esc(String(scene.id).slice(0, 12))}` : '手动场景'}</p></div>
          <button class="ghost" data-run-scene="${esc(scene.id)}">执行</button>
        </div>
      </article>`;
    })
    .join('');
}

async function loadScenes() {
  if (!state.homeId) return;
  const request = ++state.scenesRequest;
  const homeId = state.homeId;
  const box = $('#sceneList');
  state.scenes = [];
  setNavCount('sceneCount', 0);
  box.innerHTML = '<div class="empty">读取场景…</div>';
  try {
    const scenes = await invoke('list_scenes', { homeId });
    if (request !== state.scenesRequest || homeId !== state.homeId) return;
    state.scenes = scenes;
    setNavCount('sceneCount', state.scenes.length);
    box.innerHTML = sceneListHTML();
  } catch (error) {
    if (request !== state.scenesRequest || homeId !== state.homeId) return;
    box.innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showScenes() {
  if (!state.loggedIn) return;
  await stopCamera();
  $('#loginView').hidden = true;
  $('#devicesView').hidden = true;
  document.querySelector('.main').classList.remove('devices-mode');
  $('#reload').hidden = true;
  $('#cameraView').hidden = true;
  $('#automationView').hidden = true;
  $('#sceneView').hidden = false;
  document.querySelector('.main').scrollTop = 0;
  $('#pageTitle').textContent = '场景';
  $('#devicesNav').classList.remove('active');
  $('#cameraNav').classList.remove('active');
  $('#sceneNav').classList.add('active');
  await loadScenes();
}

function fillSceneSelect() {
  const select = $('#autoScene');
  if (!select) return;
  select.innerHTML = state.scenes.length
    ? state.scenes.map((scene) => `<option value="${esc(scene.id)}">${esc(scene.name)}</option>`).join('')
    : '<option value="">没有手动场景</option>';
  select.disabled = !state.scenes.length;
}

function renderAutomations() {
  const box = $('#autoList');
  if (!state.automations.length) {
    box.innerHTML = '<div class="empty">还没有定时任务。选一个时间，绑一个手动场景。</div>';
    return;
  }
  const dayNames = ['一', '二', '三', '四', '五', '六', '日'];
  box.innerHTML = state.automations.map((item) => {
    const days = item.days.map((day) => dayNames[day - 1] || '').join('、');
    const sceneName = state.scenes.find((scene) => scene.id === item.scene_id)?.name || item.scene_id;
    return `<article class="auto-row">
      <time>${esc(item.time)}</time>
      <div><strong>${esc(item.name)}</strong><small>${days} · ${esc(sceneName)}</small></div>
      <label class="switch"><input type="checkbox" data-toggle-auto="${esc(item.id)}" ${item.enabled ? 'checked' : ''}><span></span></label>
      <button class="ghost" data-delete-auto="${esc(item.id)}">删除</button>
    </article>`;
  }).join('');
}

async function loadAutomations() {
  try {
    state.automations = await invoke('list_automations');
    setNavCount('automationCount', state.automations.length);
    renderAutomations();
  } catch (error) {
    $('#autoList').innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showAutomations() {
  if (!state.loggedIn) return;
  await stopCamera();
  $('#loginView').hidden = true;
  $('#devicesView').hidden = true;
  document.querySelector('.main').classList.remove('devices-mode');
  $('#reload').hidden = true;
  $('#cameraView').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = false;
  document.querySelector('.main').scrollTop = 0;
  $('#pageTitle').textContent = '自动化';
  ['devicesNav', 'cameraNav', 'sceneNav'].forEach((id) => $('#' + id).classList.remove('active'));
  $('#automationNav').classList.add('active');
  await loadScenes();
  fillSceneSelect();
  await loadAutomations();
}

async function showCameras() {
  if (!state.loggedIn) return;
  $('#loginView').hidden = true;
  $('#devicesView').hidden = true;
  document.querySelector('.main').classList.remove('devices-mode');
  $('#reload').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = true;
  $('#cameraView').hidden = false;
  document.querySelector('.main').scrollTop = 0;
  $('#pageTitle').textContent = '摄像头';
  for (const id of ['devicesNav', 'cameraNav', 'sceneNav', 'automationNav']) {
    $('#' + id).classList.toggle('active', id === 'cameraNav');
  }
  await loadCameras();
}

async function loadCameras() {
  const request = ++state.camerasRequest;
  const list = $('#camList');
  list.replaceChildren(el('div', 'empty', '正在读取摄像头…'));
  try {
    const cameras = await invoke('list_cameras');
    if (request !== state.camerasRequest) return;
    state.cameras = cameras;
    log.info('Camera', `摄像头列表已加载：${cameras.length} 台`);
    setNavCount('cameraCount', state.cameras.length);
    renderCameras();
    loadDeviceSpecs(cameras);
  } catch (error) {
    log.error('Camera', `读取摄像头列表失败：${error}`);
    if (request !== state.camerasRequest) return;
    state.cameras = [];
    setNavCount('cameraCount', 0);
    list.replaceChildren(el('div', 'empty error', `读取摄像头失败：${error}`));
  }
}

function renderCameras() {
  const list = $('#camList');
  list.replaceChildren();
  if (!state.cameras.length) {
    list.append(el('div', 'empty', '账号下没有识别到摄像头'));
    $('#camEmpty').textContent = '没有可用摄像头';
    return;
  }
  for (const camera of state.cameras) {
    const row = el('div', 'cam-row');
    if (state.selectedCameraDid === camera.did) row.classList.add('active');
    row.onclick = () => {
      state.selectedCameraDid = camera.did;
      renderCameras();
      if (state.selectedCameraDid === camera.did) {
        $('#camEmpty').textContent = `已选择 ${camera.name}，点击“本地”或“远程”打开。`;
      }
    };
    row.append(el('span', 'cam-dot', camera.online ? '●' : '○'));
    const copy = el('div');
    copy.append(el('strong', '', camera.name));
    copy.append(el('small', '', camera.ip ? `局域网 · ${camera.ip}` : '通过远程连接'));
    copy.title = camera.model;
    row.append(copy);
    const actions = el('div', 'cam-actions');
    const local = el('button', 'pill', '本地');
    local.disabled = !camera.online || !camera.ip;
    local.onclick = () => startCameraSet([camera], false);
    const remote = el('button', 'pill remote', '远程');
    remote.disabled = !camera.online;
    remote.onclick = () => startRemoteCamera(camera);
    actions.append(local, remote);
    row.append(actions);
    list.append(row);
  }
  $('#camEmpty').textContent = '选择一个摄像头';
}

async function startRemoteCamera(camera) {
  return startRemoteCameraSet([camera], false);
}

function startRemoteCameraSet(cameras, grid) {
  return queueCameraOperation(() => startRemoteCameraSetNow(cameras, grid));
}

async function startRemoteCameraSetNow(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线摄像头';
    return;
  }
  await stopCameraNow('切换到远程画面');
  log.info('Camera', `开始远程画面：count=${usable.length} grid=${grid}`);
  const generation = state.cameraGeneration;
  state.cameraStreams = [];
  state.cameraGrid = grid;
  state.remoteAudio.clear();
  state.activeCamera = usable[0];
  state.selectedCameraDid = usable[0].did;
  state.remoteActive = true;
  $('#camLayout').hidden = grid;
  $('#camGrid').hidden = !grid;
  $('#camEmpty').hidden = false;
  $('#camEmpty').textContent = '正在连接远程画面…首次约 10–20 秒';
  const selected = grid ? usable.slice(0, MAX_REMOTE_STREAMS) : usable;
  $('#camHint').textContent = grid ? `正在建立 ${selected.length} 路远程画面` : `正在建立远程通道：${usable[0].name}`;
  $('#camGridToggle').textContent = grid ? '单画面' : '宫格';

  let tiles = null;
  let singleVideo = null;
  if (grid) {
    $('#camGrid').replaceChildren();
    $('#camControls').hidden = true;
    tiles = new Map();
    const selectedDids = new Set(selected.map((camera) => camera.did));
    for (const camera of usable) {
      const tile = el('div', 'cam-tile');
      tile.append(el('span', 'cam-tile-title', camera.name));
      const status = el(
        'span',
        'cam-tile-status',
        selectedDids.has(camera.did) ? '正在连接…' : '未启动 · 已达同时显示上限',
      );
      tile.append(status);
      $('#camGrid').append(tile);
      tiles.set(camera.did, { tile, status, video: null });
    }
  } else {
    singleVideo = $('#camVideo');
    singleVideo.hidden = false;
    $('#camEmpty').hidden = true;
  }

  let readyCount = 0;
  const failures = [];
  const starts = runLimited(selected, MAX_REMOTE_START_CONCURRENCY, async (camera) => {
    try {
      // Keep a silent audio track in single-view mode so the sound toggle is
      // immediate and does not rebuild the whole camera transport.
      const stream = await invoke('camera_remote_start', {
        did: camera.did, quality: 1, audio: !grid,
      });
      if (generation !== state.cameraGeneration) return null;
      state.cameraStreams = [
        ...state.cameraStreams.filter((item) => item.id !== stream.id),
        stream,
      ];
      readyCount += 1;
      if (grid) {
        const target = tiles.get(camera.did);
        if (!target) return stream;
        const video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.onerror = () => {
          log.error('Camera', `远程宫格播放失败：${camera.name}`);
          target.status.textContent = '播放失败';
          target.status.hidden = false;
        };
        target.status.hidden = true;
        target.video = video;
        target.tile.append(video);
        attachCameraStream(video, stream, camera, generation);
        watchRemote(video, camera, () => restartRemoteCamera(camera, video, generation), generation);
      } else {
        renderCameraControls(camera, true).catch((error) => {
          log.error('Camera', `渲染远程控制项失败：${error}`);
        });
        singleVideo.muted = true;
        singleVideo.volume = 1;
        attachCameraStream(singleVideo, stream, camera, generation);
        $('#camHint').textContent = `${camera.name} · 远程连接`;
        if (state.remoteWatch) clearInterval(state.remoteWatch);
        watchRemote(singleVideo, camera, () => restartRemoteCamera(camera, singleVideo, generation), generation);
        setTimeout(() => {
          if (generation === state.cameraGeneration && !singleVideo.videoWidth) {
            log.warn('Camera', `远程播放器 12 秒无首帧：${camera.name}`);
            $('#camHint').textContent = `远程流已建立，但播放器还没有首帧：${camera.name}。检查 ffmpeg/WebView 的 HEVC 支持。`;
          }
        }, 12000);
      }
      return stream;
    } catch (error) {
      failures.push(error);
      if (grid) {
        const target = tiles.get(camera.did);
        if (target) {
          target.status.textContent = '连接失败';
          target.status.hidden = false;
        }
      }
      log.error('Camera', `远程画面失败：${camera.name} ${String(error)}`);
      return null;
    }
  });

  try {
    await starts;
    if (generation !== state.cameraGeneration) {
      return;
    }
    if (!readyCount) throw failures[0] || new Error('远程通道没有启动');
    if (failures.length) toast(`${failures.length} 路摄像头取流失败`, true);
    log.info('Camera', `远程画面通道已建立：count=${readyCount} failed=${failures.length}`);
    if (grid) {
      const skipped = usable.length - selected.length;
      $('#camHint').textContent = `${readyCount}/${selected.length} 路远程画面已启动${failures.length ? ` · ${failures.length} 路失败` : ''}${skipped ? ` · 最多同时显示 ${MAX_REMOTE_STREAMS} 路` : ''}`;
      for (const camera of usable.slice(selected.length)) {
        const target = tiles?.get(camera.did);
        if (target) {
          target.status.textContent = '未启动 · 已限制同时显示数量';
          target.status.hidden = false;
        }
      }
    }
  } catch (error) {
    log.error('Camera', `远程画面失败：${String(error)}`);
    if (generation === state.cameraGeneration) await stopCameraNow('远程启动失败');
    const text = String(error);
    const busy = /没有返回画面|no authentication|no frames|End of file|提前退出|peer closed/.test(text);
    $('#camEmpty').hidden = false;
    $('#camEmpty').textContent = busy
      ? '摄像头没有返回画面。若米家 App 正在看同一台摄像头，先在手机上退出直播，再点“远程”重试。'
      : `远程取流失败：${text}`;
    $('#camHint').textContent = busy
      ? '同一台摄像头通常只允许一台设备查看实时画面。'
      : '远程通道初始化失败。确认本机已安装 ffmpeg。';
  }
}

async function setCameraProp(camera, def, value) {
  try {
    await invoke('set_property', { did: camera.did, siid: def.siid, piid: def.piid, value });
    state.cardProps.set(propKey(camera.did, def.siid, def.piid), value);
    refreshDeviceCard(camera);
    log.info('Camera', `设置已提交：${camera.name} ${def.label}=${value}`);
    return true;
  } catch (error) {
    log.error('Camera', `设置失败：${camera.name} ${def.label} ${error}`);
    toast(`${def.label}设置失败：${error}`, true);
    await renderCameraControls(camera, state.remoteActive);
    return false;
  }
}

async function renderCameraControls(camera, remote) {
  const request = ++state.cameraControlsRequest;
  const generation = state.cameraGeneration;
  const box = $('#camControls');
  if (!camera) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const ptz = el('div', 'cam-ptz');
  ptz.append(el('p', 'eyebrow', '云台控制'));
  const supportsPtz = !String(camera.model || '').includes('039a01');
  if (!supportsPtz) {
    ptz.append(el('p', 'muted', '该机型不支持云台'));
  } else if (!remote) {
    ptz.append(el('p', 'muted', '打开远程画面后可控制'));
  } else {
    const pad = el('div', 'ptz-pad');
    const add = (direction, text, className) => {
      const button = el('button', className, text);
      button.type = 'button';
      button.setAttribute('aria-label', `云台${text}`);
      button.onclick = async () => {
        try {
          await invoke('camera_remote_ptz', { did: camera.did, direction });
        } catch (error) {
          log.error('Camera', `云台命令失败：${camera.name} ${direction} ${error}`);
          toast(`云台命令失败：${error}`, true);
        }
      };
      pad.append(button);
    };
    add('up', '↑', 'ptz-up');
    add('left', '←', 'ptz-left');
    add('right', '→', 'ptz-right');
    add('down', '↓', 'ptz-down');
    ptz.append(pad);
  }
  box.append(ptz);

  const video = $('#camVideo');
  if (remote) {
    const sound = el('div', 'cam-settings');
    const soundRow = el('div', 'cam-control');
    soundRow.append(el('span', '', '声音'));
    const soundToggle = el('label', 'switch');
    const soundInput = document.createElement('input');
    soundInput.type = 'checkbox';
    soundInput.checked = state.remoteAudio.get(camera.did) === true;
    soundInput.disabled = !camera;
    soundInput.onchange = async () => {
      if (!video || !camera) return;
      if (!soundInput.checked) {
        state.remoteAudio.set(camera.did, false);
        video.muted = true;
        log.info('Camera', `声音已关闭：${camera.name}`);
        $('#camHint').textContent = `${camera.name} · 声音已关闭`;
        return;
      }
      state.remoteAudio.set(camera.did, true);
      const audioTracks = video.srcObject?.getAudioTracks?.() || [];
      if (audioTracks.length) {
        video.muted = false;
        video.volume = 1;
        video.play().catch((error) => {
          log.error('Camera', `恢复声音播放失败：${camera.name} ${error}`);
          $('#camHint').textContent = `声音已开启，但播放器没有开始播放：${error}`;
        });
        log.info('Camera', `声音已打开：${camera.name} tracks=${audioTracks.length}`);
        $('#camHint').textContent = `${camera.name} · 声音已打开`;
        return;
      }
      soundInput.disabled = true;
      $('#camHint').textContent = `${camera.name} 正在打开声音…`;
      try {
        await invoke('camera_remote_stop', { did: camera.did }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (generation !== state.cameraGeneration) return;
        const stream = await invoke('camera_remote_start', { did: camera.did, quality: 1, audio: true });
        if (generation !== state.cameraGeneration) return;
        state.cameraStreams = state.cameraStreams.map((item) => item.id === camera.did ? stream : item);
        video.muted = false;
        video.volume = 1;
        attachCameraStream(video, stream, camera, generation);
        log.info('Camera', `声音通道已建立：${camera.name}`);
        $('#camHint').textContent = `${camera.name} · 声音已打开`;
      } catch (error) {
        log.error('Camera', `打开声音失败：${camera.name} ${error}`);
        state.remoteAudio.set(camera.did, false);
        soundInput.checked = false;
        video.muted = true;
        $('#camHint').textContent = `打开声音失败：${error}`;
      } finally {
        soundInput.disabled = false;
      }
    };
    soundToggle.append(soundInput, el('span'));
    soundRow.append(soundToggle);
    sound.append(soundRow);
    box.append(sound);
  }

  const settingsSection = el('section', 'cam-settings-section');
  settingsSection.append(el('p', 'eyebrow', '摄像头设置'));
  const settings = el('div', 'cam-settings');
  settingsSection.append(settings);
  box.append(settingsSection);
  const profile = inspectorProfile(camera);
  const controls = profile.controls.filter((def) =>
    def.type === 'toggle' || def.type === 'segments' || def.type === 'range');
  const requests = controls
    .filter((def) => def.readable !== false)
    .map((def) => ({ did: camera.did, siid: def.siid, piid: def.piid }));
  let values = new Map();
  log.info('Camera', `渲染控制项：${camera.name} controls=${controls.length} remote=${remote}`);
  if (requests.length) {
    try {
      const result = await invoke('get_properties', { requests });
      if (request !== state.cameraControlsRequest
        || generation !== state.cameraGeneration
        || state.activeCamera?.did !== camera.did) return;
      for (const item of Array.isArray(result) ? result : []) {
        if (!item || item.did !== camera.did || (item.code && item.code !== 0)) continue;
        values.set(`${item.siid}:${item.piid}`, item.value);
        state.cardProps.set(propKey(camera.did, item.siid, item.piid), item.value);
      }
    } catch (error) {
      log.error('Camera', `读取摄像头设置失败：${camera.name} ${error}`);
      if (request !== state.cameraControlsRequest) return;
      toast(`读取摄像头设置失败：${error}`, true);
    }
  }
  for (const def of controls) {
    const value = values.get(`${def.siid}:${def.piid}`);
    const row = el('div', 'cam-control');
    row.title = def.group || '摄像头设置';
    const label = el('span', '', def.label);
    row.append(label);
    if (def.type === 'toggle') {
      const toggle = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.onchange = () => setCameraProp(camera, def, input.checked);
      toggle.append(input, el('span'));
      row.append(toggle);
    } else if (def.type === 'segments') {
      const select = document.createElement('select');
      for (const [optionValue, optionLabel] of def.options || []) {
        const option = document.createElement('option');
        option.value = String(optionValue);
        option.textContent = optionLabel;
        option.selected = Number(value) === Number(optionValue);
        select.append(option);
      }
      select.onchange = () => setCameraProp(camera, def, Number(select.value));
      row.append(select);
    } else {
      const wrap = el('div', 'cam-range-wrap');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(def.min);
      range.max = String(def.max);
      const step = Number(def.step) > 0 ? Number(def.step) : 1;
      const digits = Number.isFinite(Number(def.digits))
        ? Number(def.digits)
        : step < 1 ? 1 : 0;
      range.step = String(step);
      range.value = String(value ?? def.min);
      const displayValue = (next) => `${Number(next).toFixed(digits)}${def.suffix || ''}`;
      const readout = el('small', 'muted cam-range-value', displayValue(range.value));
      range.oninput = () => { readout.textContent = displayValue(range.value); };
      range.onchange = () => setCameraProp(camera, def, Number(range.value));
      wrap.append(range, readout);
      row.append(wrap);
    }
    settings.append(row);
  }
  if (!settings.children.length) {
    settings.append(el('p', 'cam-control-note', profile.note || '这台摄像头没有返回可用的控制项。'));
  } else {
    settings.append(el('p', 'cam-control-note', !supportsPtz ? '该机型不支持云台，其他设置在云端生效。' : remote ? '云台为单步控制，每次点击转动一步。' : '云台需要先打开远程画面。'));
  }
}

async function diagnoseLocalTimeout(camera, video, generation) {
  if (generation !== state.cameraGeneration || state.remoteActive || video.videoWidth) return;
  let detail = '本地通道长时间没有收到视频。请确认摄像头未被其他设备占用后重试，或切换到远程画面。';
  try {
    const diagnostics = await invoke('camera_diagnostics');
    if (generation !== state.cameraGeneration || state.remoteActive || video.videoWidth) return;
    if (diagnostics?.detail) detail = diagnostics.detail;
    log.warn('Camera', `本地取流诊断：${JSON.stringify(diagnostics)}`);
    if (diagnostics && !diagnostics.alive) {
      detail = '本地取流服务已退出。请重新打开摄像头页，或重启应用后重试。';
    } else if (diagnostics && !diagnostics.api_ready) {
      detail = '本地取流服务没有正常响应。请重启应用后重试。';
    }
  } catch (error) {
    log.error('Camera', `读取本地诊断失败：${error}`);
    detail = `无法读取本地取流状态：${error}`;
  }
  if (generation === state.cameraGeneration && !state.remoteActive && !video.videoWidth) {
    $('#camHint').textContent = `没有首帧：${camera.name}（${camera.ip}）。${detail}`;
  }
}

function startCameraSet(cameras, grid) {
  return queueCameraOperation(() => startCameraSetNow(cameras, grid));
}

async function startCameraSetNow(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online && camera.ip);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线且带局域网地址的摄像头';
    return;
  }
  let generation;
  try {
    await stopCameraNow('切换到本地画面');
    generation = state.cameraGeneration;
    log.info('Camera', `开始本地画面：count=${usable.length} grid=${grid}`);
    const streams = await invoke('camera_start', { dids: usable.map((camera) => camera.did) });
    if (generation !== state.cameraGeneration) {
      return;
    }
    state.cameraStreams = streams;
    state.cameraGrid = grid;
    state.activeCamera = usable[0];
    state.selectedCameraDid = usable[0].did;
    state.remoteActive = false;
    log.info('Camera', `本地画面地址已返回：count=${streams.length}`);
    renderCameraControls(usable[0], false).catch((error) => {
      log.error('Camera', `渲染本地控制项失败：${error}`);
    });
    if (grid) {
      $('#camLayout').hidden = true;
      $('#camGrid').hidden = false;
      $('#camGrid').replaceChildren();
      for (const stream of streams) {
        const camera = usable.find((item) => item.did === stream.id);
        const tile = el('div', 'cam-tile');
        tile.append(el('span', 'cam-tile-title', camera?.name || stream.id));
        const video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.onerror = () => {
          log.error('Camera', `本地宫格播放失败：${camera?.name || stream.id}`);
          tile.append(el('span', 'error', '播放失败'));
        };
        tile.append(video);
        $('#camGrid').append(tile);
        attachCameraStream(video, stream, camera || usable[0], generation);
        watchRemote(video, camera || usable[0], () => restartLocalCamera(camera || usable[0], generation), generation);
      }
      $('#camHint').textContent = `${streams.length} 路画面正在建立本地连接`;
    } else {
      const stream = streams[0];
      $('#camLayout').hidden = false;
      $('#camGrid').hidden = true;
      const video = $('#camVideo');
      video.hidden = false;
      $('#camEmpty').hidden = true;
      video.onloadeddata = () => {
        if (generation === state.cameraGeneration && !state.remoteActive) {
          log.info('Camera', `本地首帧已加载：${usable[0].name}`);
          $('#camHint').textContent = `${usable[0].name} · ${usable[0].ip} · 本地实时画面`;
        }
      };
      attachCameraStream(video, stream, usable[0], generation);
      $('#camHint').textContent = `${usable[0].name} · ${usable[0].ip} · 正在建立本地连接`;
      watchRemote(video, usable[0], () => restartLocalCamera(usable[0], generation), generation);
      setTimeout(() => {
        if (generation === state.cameraGeneration && !state.remoteActive && !video.videoWidth) {
          log.warn('Camera', `本地画面 8 秒无首帧：${usable[0].name}`);
          $('#camHint').textContent = `${usable[0].name} · 本地画面仍在连接，正在等待摄像头响应…`;
        }
      }, 8000);
      setTimeout(async () => {
        if (
          generation !== state.cameraGeneration
          || state.remoteActive
          || video.videoWidth
          || state.activeCamera?.did !== usable[0].did
        ) return;
        log.warn('Camera', `本地画面 15 秒无首帧，自动切换远程：${usable[0].name}`);
        toast('本地画面未出画，已自动切换远程');
        $('#camHint').textContent = `${usable[0].name} · 本地未出画，正在切换远程连接…`;
        await startRemoteCamera(usable[0]);
      }, 15000);
      setTimeout(() => diagnoseLocalTimeout(usable[0], video, generation), 25000);
    }
    $('#camGridToggle').textContent = grid ? '单画面' : '宫格';
  } catch (error) {
    log.error('Camera', `本地画面启动失败：${error}`);
    if (generation !== undefined && generation !== state.cameraGeneration) return;
    await stopCameraNow('本地启动失败');
    $('#camHint').textContent = `启动摄像头失败：${error}`;
  }
}

function watchRemote(video, camera, onStall, generation) {
  let lastTime = -1;
  let lastFrames = -1;
  let stalled = 0;
  let hadFrames = false;
  const startedAt = Date.now();
  const firstFrameTimeout = state.remoteActive ? REMOTE_FIRST_FRAME_TIMEOUT : 30000;
  const removeWatch = () => {
    clearInterval(timer);
    state.remoteWatches = state.remoteWatches.filter((item) => item !== timer);
    if (state.remoteWatch === timer) state.remoteWatch = null;
  };
  const triggerRestart = (reason) => {
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality?.totalVideoFrames ?? video.webkitDecodedFrameCount ?? 'unknown';
    log.warn(
      'Camera',
      `${reason}，准备重连：${camera.name} `
      + `(ready=${video.readyState}, paused=${video.paused}, width=${video.videoWidth}, `
      + `time=${video.currentTime}, frames=${frames})`,
    );
    removeWatch();
    onStall();
  };
  const timer = setInterval(() => {
    if (generation !== state.cameraGeneration || !state.cameraStreams.some((stream) => stream.id === camera.did)) {
      removeWatch();
      return;
    }
    if (video.videoWidth) hadFrames = true;
    if (!hadFrames && Date.now() - startedAt >= firstFrameTimeout) {
      triggerRestart('画面长时间没有首帧');
      return;
    }
    // MSE may briefly drop out of HAVE_CURRENT_DATA while it trims its live
    // buffer. Judge stalls by decoded progress instead of readyState alone.
    if (video.paused) {
      stalled = 0;
      return;
    }
    const quality = video.getVideoPlaybackQuality?.();
    const frames = quality ? quality.totalVideoFrames : video.webkitDecodedFrameCount;
    const useFrames = typeof frames === 'number' && frames > 0;
    const frozen = useFrames
      ? lastFrames >= 0 && frames <= lastFrames
      : Math.abs(video.currentTime - lastTime) < 0.05;
    if (frozen) {
      stalled += 1;
      if (stalled >= CAMERA_STALL_INTERVALS) {
        triggerRestart('画面停滞');
      }
    } else {
      stalled = 0;
      lastTime = video.currentTime;
      if (useFrames) lastFrames = frames;
    }
  }, 1800);
  state.remoteWatches.push(timer);
  state.remoteWatch = timer;
  return timer;
}

async function restartRemoteCamera(camera, video, generation) {
  if (!camera || generation !== state.cameraGeneration || state.restartingCameras.has(camera.did)) return;
  const existingTimer = state.restartTimers.get(camera.did);
  if (existingTimer) clearTimeout(existingTimer);
  state.restartTimers.delete(camera.did);
  state.restartingCameras.add(camera.did);
  log.warn('Camera', `远程画面重连：${camera.name}`);
  $('#camHint').textContent = `${camera.name} 画面停住，正在重连…`;
  try {
    await invoke('camera_remote_stop', { did: camera.did }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    if (generation !== state.cameraGeneration) return;
    const audio = state.remoteAudio.get(camera.did) === true;
    const stream = await invoke('camera_remote_start', {
      did: camera.did, quality: 1, audio,
    });
    if (generation !== state.cameraGeneration) return;
    state.cameraStreams = state.cameraStreams.map((item) => item.id === camera.did ? stream : item);
    video.muted = !audio;
    attachCameraStream(video, stream, camera, generation);
    $('#camHint').textContent = `${camera.name} · 已自动重连`;
    watchRemote(video, camera, () => restartRemoteCamera(camera, video, generation), generation);
  } catch (error) {
    log.error('Camera', `远程画面重连失败：${camera.name} ${error}`);
    $('#camHint').textContent = `自动重连失败：${error}`;
    const timer = setTimeout(() => {
      state.restartTimers.delete(camera.did);
      if (generation === state.cameraGeneration && state.remoteActive) {
        restartRemoteCamera(camera, video, generation);
      }
    }, 5000);
    state.restartTimers.set(camera.did, timer);
  } finally {
    state.restartingCameras.delete(camera.did);
  }
}

async function restartLocalCamera(camera, generation) {
  const key = `local:${camera.did}`;
  if (generation !== state.cameraGeneration || state.restartingCameras.has(key)) return;
  state.restartingCameras.add(key);
  log.warn('Camera', `本地画面重连：${camera.name}`);
  $('#camHint').textContent = `${camera.name} 画面停住，正在重建本地通道…`;
  try {
    const activeDids = new Set(state.cameraStreams.map((stream) => stream.id));
    const cameras = state.cameras.filter((item) => activeDids.has(item.did));
    await startCameraSet(cameras.length ? cameras : [camera], state.cameraGrid);
  } finally {
    state.restartingCameras.delete(key);
  }
}

function stopCamera() {
  return queueCameraOperation(() => stopCameraNow('页面或账号切换'));
}

async function stopCameraNow(reason = '未知') {
  const requestId = ++state.cameraStopSequence;
  log.debug('Camera', `停止摄像头页面：${reason} request=${requestId}`);
  state.cameraGeneration += 1;
  if (state.remoteWatch) { clearInterval(state.remoteWatch); state.remoteWatch = null; }
  for (const timer of state.remoteWatches) clearInterval(timer);
  state.remoteWatches = [];
  state.cameraStreams = [];
  state.activeCamera = null;
  state.remoteActive = false;
  state.remoteAudio.clear();
  state.cameraControlsRequest += 1;
  for (const cleanup of state.streamCleanups) cleanup();
  state.streamCleanups = new Set();
  state.videoPlayers = new WeakMap();
  for (const timer of state.restartTimers.values()) clearTimeout(timer);
  state.restartTimers.clear();
  state.restartingCameras.clear();
  $('#camControls').hidden = true;
  const video = $('#camVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  $('#camEmpty').hidden = false;
  $('#camGrid').hidden = true;
  $('#camGrid').replaceChildren();
  $('#camLayout').hidden = false;
  if (invoke) {
    try { await invoke('camera_stop', { requestId }); } catch (_) {}
  }
}

$('#devicesNav').onclick = showDevices;
$('#cameraNav').onclick = showCameras;
$('#sceneNav').onclick = showScenes;
$('#automationNav').onclick = showAutomations;
$('#refreshScenes').onclick = loadScenes;
$('#autoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const days = [...document.querySelectorAll('#autoDays input:checked')].map((input) => Number(input.value));
  if (!days.length) return toast('至少选择一个星期', true);
  const automation = {
    id: '',
    name: $('#autoName').value.trim(),
    time: $('#autoTime').value,
    days,
    scene_id: $('#autoScene').value,
    home_id: state.homeId,
    enabled: true,
    last_run: null,
  };
  try {
    state.automations = await invoke('save_automation', { automation });
    renderAutomations();
    $('#autoName').value = '';
    toast('定时任务已保存');
  } catch (error) {
    toast(String(error), true);
  }
});
document.addEventListener('click', async (event) => {
  const toggle = event.target.closest('[data-toggle-auto]');
  if (toggle) {
    try { state.automations = await invoke('toggle_automation', { id: toggle.dataset.toggleAuto, enabled: toggle.checked }); renderAutomations(); }
    catch (error) { toast(String(error), true); }
    return;
  }
  const remove = event.target.closest('[data-delete-auto]');
  if (remove) {
    try { state.automations = await invoke('delete_automation', { id: remove.dataset.deleteAuto }); renderAutomations(); }
    catch (error) { toast(String(error), true); }
  }
});
document.addEventListener('click', async (event) => {
  const run = event.target.closest('[data-run-scene]');
  if (!run) return;
  run.disabled = true;
  run.textContent = '执行中';
  try {
    await invoke('run_scene', { sceneId: run.dataset.runScene, homeId: state.homeId });
    toast('场景已执行');
  } catch (error) {
    toast(String(error), true);
  } finally {
    run.disabled = false;
    run.textContent = '执行';
  }
});
$('#camReload').onclick = loadCameras;
$('#camRemoteGrid').onclick = () => startRemoteCameraSet(state.cameras, true);

$('#camGridToggle').onclick = () => {
  if (state.cameraGrid) {
    if (state.remoteActive) {
      const first = state.cameras.find((camera) => camera.online);
      if (first) startRemoteCameraSet([first], false);
    } else {
      const first = state.cameras.find((camera) => camera.online && camera.ip);
      if (first) startCameraSet([first], false);
    }
  } else {
    if (state.remoteActive) startRemoteCameraSet(state.cameras, true);
    else startCameraSet(state.cameras, true);
  }
};

$('#startAuth').onclick = startAuth;
$('#reload').onclick = loadDevices;
$('#exportLog').onclick = async () => {
  if (!invoke) return;
  const button = $('#exportLog');
  button.disabled = true;
  log.info('Log', '用户请求导出诊断日志');
  try {
    await invoke('log_export');
    toast('诊断日志已导出，并已在访达中显示');
  } catch (error) {
    log.error('Log', `导出诊断日志失败：${error}`);
    toast(`导出诊断日志失败：${error}`, true);
  } finally {
    button.disabled = false;
  }
};
$('#logout').onclick = async () => {
  let logoutError = null;
  try {
    await invoke('auth_logout');
  } catch (error) {
    logoutError = error;
  }
  state.loggedIn = false;
  state.polling = false;
  state.devices = [];
  state.selected = null;
  await stopCamera();
  state.cameras = [];
  state.roomFilter = 'all';
  $('#loginView').hidden = false;
  $('#devicesView').hidden = true;
  document.querySelector('.main').classList.remove('devices-mode');
  $('#reload').hidden = true;
  $('#cameraView').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = true;
  $('#sceneNav').disabled = true;
  $('#automationNav').disabled = true;
  state.scenes = [];
  state.automations = [];
  $('#cameraNav').disabled = true;
  $('#cameraNav').classList.remove('active');
  $('#camControls').hidden = true;
  $('#devicesNav').classList.add('active');
  $('#logout').hidden = true;
  $('#pageTitle').textContent = '连接你的米家';
  $('#qrBox').innerHTML = '<div class="qr-placeholder">二维码准备中</div>';
  setStatus('未登录');
  $('#startAuth').disabled = false;
  if (logoutError) toast(`本地界面已退出，但清理凭据失败：${logoutError}`, true);
};

async function boot() {
  if (!invoke) return;
  try {
    const userId = await invoke('auth_resume');
    if (!userId) {
      setStatus('未登录');
      startAuth();
      return;
    }
    state.loggedIn = true;
    log.info('App', '登录状态恢复成功');
    setStatus(`已恢复登录，用户 ${userId}`);
    await loadHomes();
  } catch (error) {
    log.error('App', `恢复登录失败：${error}`);
    setStatus(`恢复登录失败：${error}`, 'error');
    $('#startAuth').disabled = false;
    startAuth();
  }
}

if (invoke) {
  boot();
}

invoke?.('ui_ready').catch(() => {});
