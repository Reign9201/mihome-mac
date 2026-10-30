const invoke = window.__TAURI__?.core?.invoke;
const $ = (selector) => document.querySelector(selector);
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

const state = { homes: [], devices: [], scenes: [], automations: [], homeId: null, selected: null, polling: false, loggedIn: false, cameras: [], cameraStreams: [], cameraGrid: false, roomFilter: 'all', activeCamera: null, remoteActive: false, remoteWatch: null };

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

async function startAuth() {
  if (!invoke) {
    setStatus('请从 MiHome Mac 桌面应用打开这个页面', 'error');
    return;
  }
  $('#startAuth').disabled = true;
  setStatus('正在向小米申请二维码…');
  try {
    const result = await invoke('auth_start');
    $('#qrBox').innerHTML = result.qr_svg;
    setStatus('等待扫码，二维码 5 分钟内有效');
    state.polling = true;
    pollAuth();
  } catch (error) {
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
        await loadHomes();
        return;
      }
      if (result.status === 'error') {
        state.polling = false;
        setStatus(result.message || '登录失败', 'error');
        $('#startAuth').disabled = false;
        return;
      }
      setStatus('等待扫码中…');
    } catch (error) {
      const text = String(error);
      if (text.includes('没有进行中的登录') || text.includes('二维码已过期')) {
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
    renderHomeTabs();
    state.homeId = homes[0].id;
    await loadDevices();
    $('#loginView').hidden = true;
    $('#devicesView').hidden = false;
    $('#logout').hidden = false;
    for (const id of ['cameraNav', 'sceneNav', 'automationNav']) {
      $('#' + id).disabled = false;
    }
    $('#pageTitle').textContent = homes[0].name;
  } catch (error) {
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
      $('#pageTitle').textContent = home.name;
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
  $('#deviceList').replaceChildren(el('div', 'empty', '正在读取设备…'));
  try {
    const devices = await invoke('list_devices', { homeId: state.homeId });
    state.devices = devices;
    renderDevices();
    $('#inspector').replaceChildren(el('p', 'muted', '选一台设备，读取它的 2.1 开关属性。'));
  } catch (error) {
    $('#deviceList').replaceChildren(el('div', 'empty error', `读取设备失败：${error}`));
  }
}

const DEVICE_ICONS = window.MiIcons.icons;
const deviceKind = window.MiIcons.kindFor;

function deviceGlyph(device) {
  const kind = deviceKind(device);
  const body = DEVICE_ICONS[kind] || DEVICE_ICONS.generic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function renderDevices() {
  const list = $('#deviceList');
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
    const card = el('button', `device-card ${state.selected?.did === device.did ? 'active' : ''} ${device.online ? '' : 'offline'}`);
    card.type = 'button';
    card.title = `${device.name} · ${device.model || '未知型号'}`;
    const top = el('div', 'device-card-top');
    const glyph = el('span', 'device-glyph');
    const kind = deviceKind(device);
    glyph.dataset.kind = kind;
    glyph.dataset.family = window.MiIcons.familyFor(kind);
    glyph.innerHTML = deviceGlyph(device);
    top.append(glyph);
    const status = el('span', `state-dot ${device.online ? 'on' : ''}`);
    status.title = device.online ? '在线' : '离线';
    status.setAttribute('aria-label', device.online ? '在线' : '离线');
    top.append(status);
    card.append(top);
    card.append(el('strong', '', device.name));
    card.append(el('span', 'device-room', roomName(device)));
    card.onclick = () => selectDevice(device);
    list.append(card);
  }
}

async function selectDevice(device) {
  state.selected = device;
  renderDevices();
  renderInspector(device);
  try {
    const result = await invoke('get_property', { did: device.did, siid: 2, piid: 1 });
    const item = Array.isArray(result) ? result[0] : result;
    if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
    renderInspector(device, item?.value);
  } catch (error) {
    renderInspector(device, undefined, String(error));
  }
}

function renderInspector(device, value, error) {
  const box = $('#inspector');
  box.replaceChildren();
  box.append(el('h3', '', device.name));
  box.append(el('p', 'inspector-room', roomName(device)));
  box.append(el('p', 'muted', `${device.model} · did ${device.did}`));
  if (error) {
    box.append(el('p', 'error', `读取 2.1 失败：${error}`));
  } else if (value !== undefined) {
    box.append(el('p', 'value', String(value)));
    box.append(el('p', 'muted', 'siid=2 · piid=1'));
    const actions = el('div', 'actions');
    const on = el('button', '', '开');
    on.onclick = () => setPower(device, true);
    const off = el('button', '', '关');
    off.onclick = () => setPower(device, false);
    const again = el('button', '', '刷新');
    again.onclick = () => selectDevice(device);
    actions.append(on, off, again);
    box.append(actions);
  } else {
    box.append(el('p', 'muted', '正在读取 siid=2 · piid=1…'));
  }
}

async function setPower(device, value) {
  try {
    const result = await invoke('set_property', { did: device.did, siid: 2, piid: 1, value });
    const item = Array.isArray(result) ? result[0] : result;
    if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
    await selectDevice(device);
  } catch (error) {
    renderInspector(device, undefined, String(error));
  }
}

async function showDevices() {
  await stopCamera();
  $('#cameraView').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = true;
  $('#devicesView').hidden = false;
  $('#pageTitle').textContent = state.homes.find((home) => home.id === state.homeId)?.name || '设备';
  $('#devicesNav').classList.add('active');
  $('#cameraNav').classList.remove('active');
}

function sceneListHTML() {
  if (!state.scenes.length) {
    return `<div class="empty">还没有手动场景。先在米家 App 的“智能 → 手动控制”里创建一个。</div>`;
  }
  return state.scenes
    .map(
      (scene) => `<article class="scene-card">
        <div><h3>${esc(scene.name)}</h3><p>${scene.id ? `ID ${esc(String(scene.id).slice(0, 12))}` : ''}</p></div>
        <button class="ghost" data-run-scene="${esc(scene.id)}">执行</button>
      </article>`
    )
    .join('');
}

async function loadScenes() {
  if (!state.homeId) return;
  const box = $('#sceneList');
  box.innerHTML = '<div class="empty">读取场景…</div>';
  try {
    state.scenes = await invoke('list_scenes', { homeId: state.homeId });
    box.innerHTML = sceneListHTML();
  } catch (error) {
    box.innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showScenes() {
  if (!state.loggedIn) return;
  $('#loginView').hidden = true;
  $('#devicesView').hidden = true;
  $('#cameraView').hidden = true;
  $('#automationView').hidden = true;
  $('#sceneView').hidden = false;
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
    renderAutomations();
  } catch (error) {
    $('#autoList').innerHTML = `<div class="empty error">${esc(String(error))}</div>`;
  }
}

async function showAutomations() {
  if (!state.loggedIn) return;
  $('#loginView').hidden = true;
  $('#devicesView').hidden = true;
  $('#cameraView').hidden = true;
  $('#sceneView').hidden = true;
  $('#automationView').hidden = false;
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
  $('#sceneView').hidden = true;
  $('#automationView').hidden = true;
  $('#cameraView').hidden = false;
  $('#pageTitle').textContent = '摄像头';
  $('#devicesNav').classList.remove('active');
  $('#cameraNav').classList.add('active');
  await loadCameras();
}

async function loadCameras() {
  const list = $('#camList');
  list.replaceChildren(el('div', 'empty', '正在读取摄像头…'));
  try {
    state.cameras = await invoke('list_cameras');
    renderCameras();
  } catch (error) {
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
    row.append(el('span', 'cam-dot', camera.online ? '●' : '○'));
    const copy = el('div');
    copy.append(el('strong', '', camera.name));
    copy.append(el('small', '', `${camera.model} · ${camera.ip || '远程可用'}`));
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
  $('#camEmpty').textContent = '选择右侧摄像头';
}

async function startRemoteCamera(camera) {
  return startRemoteCameraSet([camera], false);
}

async function startRemoteCameraSet(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线摄像头';
    return;
  }
  await stopCamera();
  $('#camLayout').hidden = grid;
  $('#camGrid').hidden = !grid;
  $('#camEmpty').hidden = false;
  $('#camEmpty').textContent = `正在建立 CS2 relay…首次约 10–20 秒`;
  $('#camHint').textContent = grid ? `正在建立 ${usable.length} 路远程画面` : `正在建立远程通道：${usable[0].name}`;
  try {
    const streams = await Promise.all(usable.map((camera) => invoke('camera_remote_start', { did: camera.did, quality: 2 })));
    state.cameraStreams = streams;
    state.cameraGrid = grid;
    state.activeCamera = usable[0];
    state.remoteActive = true;
    $('#camGridToggle').textContent = grid ? '单画面' : '宫格';
    if (grid) {
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
        video.src = stream.url;
        video.onerror = () => tile.append(el('span', 'error', '播放失败'));
        tile.append(video);
        $('#camGrid').append(tile);
      }
      $('#camControls').hidden = true;
      $('#camHint').textContent = `${streams.length} 路远程 HLS 已启动 · CS2 relay`;
    } else {
      const stream = streams[0];
      await renderCameraControls(usable[0], true);
      const video = $('#camVideo');
      video.hidden = false;
      $('#camEmpty').hidden = true;
      video.src = stream.url;
      video.load();
      video.play().catch(() => {});
      $('#camHint').textContent = `${usable[0].name} · 远程 CS2`;
      if (state.remoteWatch) clearInterval(state.remoteWatch);
      let lastTime = -1;
      let stalled = 0;
      state.remoteWatch = setInterval(() => {
        if (!state.remoteActive || video.hidden) return;
        if (video.readyState < 2 || video.paused) { stalled = 0; return; }
        if (Math.abs(video.currentTime - lastTime) < 0.05) {
          stalled += 1;
          if (stalled >= 3) {
            $('#camHint').textContent = '远程画面已停止更新，点“远程”重新连接。';
            clearInterval(state.remoteWatch);
            state.remoteWatch = null;
          }
        } else {
          stalled = 0;
          lastTime = video.currentTime;
        }
      }, 2500);
      setTimeout(() => {
        if (!video.videoWidth) {
          $('#camHint').textContent = `远程流已建立，但播放器还没有首帧：${usable[0].name}。检查 ffmpeg/WebView 的 HEVC 支持。`;
        }
      }, 12000);
    }
  } catch (error) {
    const text = String(error);
    const busy = /没有返回画面|no authentication|no frames|End of file|提前退出|peer closed/.test(text);
    $('#camEmpty').hidden = false;
    $('#camEmpty').textContent = busy
      ? '摄像头没有返回画面。若米家 App 正在看同一台摄像头，先在手机上退出直播，再点“远程”重试。'
      : `远程取流失败：${text}`;
    $('#camHint').textContent = busy
      ? '同一台摄像头通常只允许一路 P2P 取流。'
      : '远程通道初始化失败。确认本机已安装 ffmpeg。';
  }
}

const CAMERA_CONTROLS = [
  { key: 'power', label: '摄像头', siid: 2, piid: 1, type: 'switch' },
  { key: 'night', label: '夜视', siid: 2, piid: 3, type: 'select', options: [[0, '开'], [1, '关'], [2, '自动']] },
  { key: 'record', label: '录像', siid: 2, piid: 7, type: 'select', options: [[0, '持续'], [1, '仅动态'], [2, '关闭']] },
  { key: 'tracking', label: '移动追踪', siid: 2, piid: 8, type: 'switch' },
  { key: 'wdr', label: '宽动态', siid: 2, piid: 5, type: 'switch' },
  { key: 'color', label: '全彩夜视', siid: 2, piid: 6, type: 'switch' },
  { key: 'watermark', label: '时间水印', siid: 2, piid: 9, type: 'switch' },
  { key: 'indicator', label: '状态灯', siid: 3, piid: 1, type: 'switch' },
  { key: 'motion', label: '移动侦测', siid: 5, piid: 1, type: 'switch' },
  { key: 'sensitivity', label: '侦测灵敏度', siid: 5, piid: 3, type: 'select', options: [[0, '低'], [1, '高']] },
  { key: 'alarm', label: '报警间隔', siid: 5, piid: 2, type: 'range', min: 1, max: 30, step: 1, suffix: '秒' },
  { key: 'mute', label: '扬声器静音', siid: 6, piid: 1, type: 'switch' },
  { key: 'volume', label: '扬声器音量', siid: 6, piid: 2, type: 'range', min: 0, max: 100, step: 1, suffix: '' },
  { key: 'cruise', label: '巡航', siid: 9, piid: 1, type: 'switch' },
];

async function readCameraProp(camera, siid, piid) {
  const result = await invoke('get_property', { did: camera.did, siid, piid });
  const item = Array.isArray(result) ? result[0] : result;
  if (item?.code && item.code !== 0) throw new Error(`code ${item.code}`);
  return item?.value;
}

async function setCameraProp(camera, def, value) {
  try {
    await invoke('set_property', { did: camera.did, siid: def.siid, piid: def.piid, value });
  } catch (error) {
    toast(`${def.label}设置失败：${error}`, true);
    await renderCameraControls(camera, state.remoteActive);
  }
}

async function renderCameraControls(camera, remote) {
  const box = $('#camControls');
  if (!camera) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  const ptz = el('div', 'cam-ptz');
  ptz.append(el('p', 'eyebrow', '云台'));
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
      let timer = null;
      const stop = async () => {
        if (timer) { clearInterval(timer); timer = null; }
        try { await invoke('camera_remote_ptz', { did: camera.did, direction: 'stop', speed: 0 }); } catch (_) {}
      };
      const start = async (event) => {
        event.preventDefault();
        if (timer) return;
        try {
          await invoke('camera_remote_ptz', { did: camera.did, direction, speed: 40 });
          timer = setInterval(() => invoke('camera_remote_ptz', { did: camera.did, direction, speed: 40 }).catch(() => {}), 220);
        } catch (error) {
          toast(`云台命令失败：${error}`, true);
        }
      };
      button.addEventListener('pointerdown', start);
      button.addEventListener('pointerup', stop);
      button.addEventListener('pointercancel', stop);
      button.addEventListener('pointerleave', stop);
      pad.append(button);
    };
    add('up', '↑', 'ptz-up');
    add('left', '←', 'ptz-left');
    add('right', '→', 'ptz-right');
    add('down', '↓', 'ptz-down');
    ptz.append(pad);
  }
  box.append(ptz);

  const settings = el('div', 'cam-settings');
  box.append(settings);
  const loaded = await Promise.all(CAMERA_CONTROLS.map(async (def) => {
    try {
      return { def, value: await readCameraProp(camera, def.siid, def.piid) };
    } catch (_) {
      return null;
    }
  }));
  for (const item of loaded.filter(Boolean)) {
    const { def, value } = item;
    const row = el('div', 'cam-control');
    const label = el('span', '', def.label);
    row.append(label);
    if (def.type === 'switch') {
      const toggle = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(value);
      input.onchange = () => setCameraProp(camera, def, input.checked);
      toggle.append(input, el('span'));
      row.append(toggle);
    } else if (def.type === 'select') {
      const select = document.createElement('select');
      for (const [optionValue, optionLabel] of def.options) {
        const option = document.createElement('option');
        option.value = String(optionValue);
        option.textContent = optionLabel;
        option.selected = Number(value) === optionValue;
        select.append(option);
      }
      select.onchange = () => setCameraProp(camera, def, Number(select.value));
      row.append(select);
    } else {
      const wrap = el('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '5px';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(def.min);
      range.max = String(def.max);
      range.step = String(def.step);
      range.value = String(value ?? def.min);
      const readout = el('small', 'muted', `${range.value}${def.suffix || ''}`);
      readout.style.fontVariantNumeric = 'tabular-nums';
      range.oninput = () => { readout.textContent = `${range.value}${def.suffix || ''}`; };
      range.onchange = () => setCameraProp(camera, def, Number(range.value));
      wrap.append(range, readout);
      row.append(wrap);
    }
    settings.append(row);
  }
  if (!settings.children.length) {
    settings.append(el('p', 'cam-control-note', '这台摄像头没有返回可用的控制项。'));
  } else {
    settings.append(el('p', 'cam-control-note', !supportsPtz ? '该机型不支持云台，其他设置在云端生效。' : remote ? '云台每次按一下转一步，按住连续转。' : '云台需要先打开远程画面。'));
  }
}

async function startCameraSet(cameras, grid) {
  const usable = cameras.filter((camera) => camera.online && camera.ip);
  if (!usable.length) {
    $('#camHint').textContent = '没有在线且带局域网地址的摄像头';
    return;
  }
  try {
    await stopCamera();
    const streams = await invoke('camera_start', { dids: usable.map((camera) => camera.did) });
    state.cameraStreams = streams;
    state.cameraGrid = grid;
    state.activeCamera = usable[0];
    state.remoteActive = false;
    await renderCameraControls(usable[0], false);
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
        video.src = stream.url;
        video.onerror = () => tile.append(el('span', 'error', '播放失败'));
        tile.append(video);
        $('#camGrid').append(tile);
      }
      $('#camHint').textContent = `${streams.length} 路 HLS 已启动 · 本地端口`;
    } else {
      const stream = streams[0];
      $('#camLayout').hidden = false;
      $('#camGrid').hidden = true;
      const video = $('#camVideo');
      video.hidden = false;
      $('#camEmpty').hidden = true;
      video.src = stream.url;
      video.load();
      video.play().catch(() => {});
      $('#camHint').textContent = `${usable[0].name} · ${usable[0].ip} · ${stream.url}`;
      setTimeout(() => {
        if (!video.videoWidth) {
          $('#camHint').textContent = `没有首帧：${usable[0].name}（${usable[0].ip}）。检查 Mac 与摄像头是否在同一局域网，或是否需要家庭 VPN。`;
        }
      }, 8000);
    }
    $('#camGridToggle').textContent = grid ? '单画面' : '宫格';
  } catch (error) {
    $('#camHint').textContent = `启动摄像头失败：${error}`;
  }
}

async function stopCamera() {
  if (state.remoteWatch) { clearInterval(state.remoteWatch); state.remoteWatch = null; }
  state.cameraStreams = [];
  state.activeCamera = null;
  state.remoteActive = false;
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
    try { await invoke('camera_stop'); } catch (_) {}
    try { await invoke('camera_remote_stop'); } catch (_) {}
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
    startCameraSet(state.cameras, true);
  }
};

$('#startAuth').onclick = startAuth;
$('#reload').onclick = loadDevices;
$('#logout').onclick = async () => {
  await invoke('auth_logout');
  state.loggedIn = false;
  state.polling = false;
  state.devices = [];
  state.selected = null;
  await stopCamera();
  state.cameras = [];
  state.roomFilter = 'all';
  $('#loginView').hidden = false;
  $('#devicesView').hidden = true;
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
    setStatus(`已恢复登录，用户 ${userId}`);
    await loadHomes();
  } catch (error) {
    setStatus(`恢复登录失败：${error}`, 'error');
    $('#startAuth').disabled = false;
  }
}

if (invoke) {
  boot();
}

window.__TAURI__?.core.invoke('ui_ready').catch(() => {});
