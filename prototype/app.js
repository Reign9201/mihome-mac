/* ============================================================
   MiHome Mac — 交互原型逻辑
   所有设备状态、场景、自动化均为本地演示数据；不发起真实网络请求。
   ============================================================ */

const state = {
  page: 'overview',
  room: 'all',
  deviceFilter: 'all',
  deviceQuery: '',
  selected: null,
  theme: localStorage.getItem('mihome-theme') || 'light',
  density: localStorage.getItem('mihome-density') || 'comfortable',
  polling: 5000,
  camera: 'cam-living',
  cameraMode: 'live',
  cameraGrid: false,
  cameraPaused: false,
  cameraEvent: null,
  localFirst: true,
  mdns: true,
  menuBar: true,
  inflight: 0,
  lastRender: 0,
  cacheHit: 96,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const deviceById = id => DEVICES.find(d => d.id === id);
const roomById = id => HOME.rooms.find(r => r.id === id);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

document.body.dataset.theme = state.theme;
document.body.dataset.density = state.density;

/* ---------------- 工具 ---------------- */
function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function todayLabel() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

function nowTime() {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function deviceSummary(d) {
  const s = d.state;
  switch (d.type) {
    case 'light':
      if (!s.on) return '已关闭';
      return `${MODE_LABEL[s.mode] || '照明'} · ${s.brightness}% · ${s.colorTemp}K`;
    case 'ac':
      if (!s.on) return '已关闭';
      return `${MODE_LABEL[s.mode]} ${s.temp}°C · ${FAN_LABEL[s.fan] || s.fan} · 室内 ${s.indoor}°C`;
    case 'curtain':
      return s.position === 0 ? '已关闭' : s.position === 100 ? '全开' : `开合 ${s.position}%`;
    case 'purifier':
      if (!s.on) return '已关闭';
      return `${MODE_LABEL[s.mode]} · PM2.5 ${s.pm25} · 滤芯 ${s.filter}%`;
    case 'sensor':
      return `温度 ${s.temperature}°C · 湿度 ${s.humidity}%`;
    case 'humidifier':
      if (!s.on) return '已关闭';
      return `目标 ${s.targetHumidity}% · 水箱 ${s.waterLevel}%`;
    case 'plug':
      return s.on ? `功率 ${s.power}W · 今日 0.42 kWh` : '已关闭';
    case 'vacuum':
      return `${STATUS_LABEL[s.status] || s.status} · 电量 ${s.battery}%`;
    case 'camera':
      if (s.privacy) return '隐私遮蔽 · 画面未离开设备';
      if (!s.live) return '离线 · 最后在线 18:12';
      return `直播中 · ${d.camera.resolution} · ${d.path === 'lan' ? '局域网 P2P' : '云端转发'}`;
    default:
      return d.note || '';
  }
}

function isOn(d) {
  if (d.type === 'vacuum') return d.state.status === 'cleaning';
  if (d.type === 'sensor') return true;
  if (d.type === 'camera') return !!(d.state.live && !d.state.privacy);
  return !!d.state.on;
}

function pathTag(d) {
  return d.path === 'lan'
    ? '<span class="tag lan">本地</span>'
    : '<span class="tag cloud">云端</span>';
}

function switchHTML(d, extra = '') {
  const on = isOn(d);
  const disabled = d.type === 'sensor' ? 'disabled' : '';
  return `<button class="inline-switch ${on ? 'on' : ''} ${extra}" data-action="toggle-device" data-id="${d.id}" role="switch" aria-checked="${on}" aria-label="${esc(d.name)}开关" ${disabled}></button>`;
}

function toast(text, sub = '', iconName = 'check') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${icon(iconName)}<span>${esc(text)}</span>${sub ? `<span class="toast-sub">${esc(sub)}</span>` : ''}`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

function setSyncBusy() {
  state.inflight += 1;
  const el = $('#syncState');
  el.innerHTML = '<i style="background:var(--amber);box-shadow:0 0 0 3px rgba(180,119,42,.15)"></i> 同步中';
  $('#statusSync').textContent = '正在下发…';
  updateHud();
}

function setSyncDone() {
  state.inflight = Math.max(0, state.inflight - 1);
  const el = $('#syncState');
  el.innerHTML = '<i></i> 已同步';
  $('#statusSync').textContent = '刚刚同步';
  updateHud();
}

function commitDevice(id, patch, message, delay) {
  const d = deviceById(id);
  if (!d) return;
  setSyncBusy();
  const wait = delay ?? (d.path === 'lan' ? 140 : 620);
  setTimeout(() => {
    Object.assign(d.state, patch);
    d.note = message || d.note;
    setSyncDone();
    renderCurrent(true);
    if (message) toast(message, `${d.name} · ${d.path === 'lan' ? d.latency + ' ms 本地' : d.latency + ' ms 云端'}`);
  }, wait);
}

/* ---------------- 总览 ---------------- */
function heroSpark(series = []) {
  const w = 320, h = 42, pad = 3;
  const min = Math.min(...series), max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return `<svg class="hero-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".18"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#sparkFill)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts.at(-1)[0]}" cy="${pts.at(-1)[1]}" r="2.4" fill="var(--accent)"/>
  </svg>`;
}

function scenePill(s) {
  return `<button class="scene-pill" data-action="run-scene" data-id="${s.id}" data-tone="${s.tone}">
    <span class="sc-icon">${icon(s.icon)}</span>
    <span class="sc-text"><strong>${s.name}</strong><small>${s.caption}</small></span>
  </button>`;
}

function deviceRow(d) {
  let control = '';
  const s = d.state;
  if (d.type === 'light') {
    control = `<span class="inline-slider">
      <input type="range" min="1" max="100" value="${s.brightness}" style="--v:${s.brightness}%"
        data-action="brightness" data-id="${d.id}" aria-label="${esc(d.name)}亮度" ${s.on ? '' : 'disabled'}>
      <span class="inline-value">${s.on ? s.brightness + '%' : '—'}</span></span>${switchHTML(d)}`;
  } else if (d.type === 'ac') {
    control = `<div class="stepper">
      <button data-action="step-temp" data-id="${d.id}" data-delta="-1" aria-label="降低温度">${icon('minus')}</button>
      <b>${s.on ? s.temp + '°' : '—'}</b>
      <button data-action="step-temp" data-id="${d.id}" data-delta="1" aria-label="升高温度">${icon('plus')}</button>
    </div>${switchHTML(d)}`;
  } else if (d.type === 'curtain') {
    control = `<span class="mini-status"><i style="background:${s.position ? 'var(--green)' : 'var(--ink-3)'}"></i>${s.position ? '开合 ' + s.position + '%' : '已关闭'}</span>`;
  } else if (d.type === 'purifier') {
    control = `<span class="mini-status"><i style="background:${s.on ? 'var(--green)' : 'var(--ink-3)'}"></i>${s.on ? 'PM2.5 ' + s.pm25 : '已关闭'}</span>${switchHTML(d)}`;
  } else if (d.type === 'sensor') {
    control = `<span class="sensor-reading"><b>${s.temperature}°</b><span>${s.humidity}%</span></span>`;
  } else if (d.type === 'humidifier') {
    control = `<span class="mini-status"><i style="background:${s.on ? 'var(--green)' : 'var(--ink-3)'}"></i>水箱 ${s.waterLevel}%</span>${switchHTML(d)}`;
  } else if (d.type === 'plug') {
    control = `<span class="mini-status"><i style="background:${s.on ? 'var(--green)' : 'var(--ink-3)'}"></i>${s.on ? s.power + ' W' : '已关闭'}</span>${switchHTML(d)}`;
  } else if (d.type === 'vacuum') {
    control = `<span class="mini-status ${s.status === 'paused' ? 'paused' : ''}"><i></i>${STATUS_LABEL[s.status] || s.status}</span>
      <button class="mini-play" data-action="vacuum" data-id="${d.id}" aria-label="开始清扫">${icon(s.status === 'cleaning' ? 'pause' : 'play')}</button>`;
  } else if (d.type === 'camera') {
    control = `<span class="mini-status ${s.privacy ? 'paused' : ''}"><i style="background:${s.privacy ? 'var(--ink-3)' : s.live ? 'var(--accent)' : 'var(--ink-3)'}"></i>${s.privacy ? '隐私遮蔽' : s.live ? '直播中' : '离线'}</span>
      <button class="mini-view" data-action="open-camera" data-id="${d.id}">${icon('play')} 查看</button>`;
  }
  return `<div class="device-row ${isOn(d) ? '' : 'off'}" data-action="open-device" data-id="${d.id}">
    <div class="device-icon" data-tone="${d.tone}">${icon(d.icon)}</div>
    <div class="device-id">
      <div class="device-name">${esc(d.name)} ${pathTag(d)}</div>
      <div class="device-meta">${esc(deviceSummary(d))}</div>
    </div>
    <div class="device-control">${control}</div>
    <button class="row-more" data-action="open-device" data-id="${d.id}" aria-label="查看 ${esc(d.name)} 详情">${icon('more')}</button>
  </div>`;
}

function roomBlock(room) {
  const list = DEVICES.filter(d => d.room === room.id);
  if (!list.length) return '';
  return `<section class="room-block">
    <div class="room-head">
      <span class="room-title">${room.name}</span>
      <span class="room-count">${list.length} 台</span>
      <span class="line"></span>
      <div class="room-actions">
        <button class="text-btn" data-action="room-power" data-room="${room.id}" data-on="1">全开</button>
        <button class="text-btn" data-action="room-power" data-room="${room.id}" data-on="0">全关</button>
      </div>
    </div>
    <div class="device-list">${list.map(deviceRow).join('')}</div>
  </section>`;
}

function pageOverview() {
  const sensor = deviceById('sensor-living');
  const online = DEVICES.filter(d => d.online).length;
  const lan = DEVICES.filter(d => d.path === 'lan').length;
  const rooms = state.room === 'all' ? HOME.rooms : HOME.rooms.filter(r => r.id === state.room);
  const title = state.room === 'all' ? greeting() : roomById(state.room).name;
  return `<section class="page">
    <div class="page-head">
      <div>
        <div class="eyebrow">${todayLabel()} · 云栖公寓</div>
        <h1 class="page-title">${title}</h1>
        <p class="page-sub">${online} 台在线，${lan} 台本地直连。${CAMERAS.length} 路监控在线，客厅空气 12。</p>
      </div>
      <div class="head-actions">
        <button class="ghost-btn" data-action="all-off">全部关闭</button>
        <button class="primary-btn" data-action="run-scene" data-id="home">${icon('play')} 回家</button>
      </div>
    </div>

    <div class="hero">
      <div class="hero-main">
        <div class="metric-label">${icon('thermometer')} 客厅 · 温湿度计</div>
        <div class="hero-reading"><span class="big">${sensor.state.temperature}</span><span class="unit">°C</span></div>
        <div class="hero-sub"><b>湿度 ${sensor.state.humidity}%</b><span>·</span>体感舒适<span>·</span>12 分钟前上报</div>
        ${heroSpark(sensor.series)}
      </div>
      <div class="hero-metrics">
        <div class="metric">
          <div class="metric-label">${icon('drop')} 湿度</div>
          <div class="metric-value">58<small>%</small></div>
          <div class="metric-foot good">适宜</div>
        </div>
        <div class="metric">
          <div class="metric-label">${icon('wind')} PM2.5</div>
          <div class="metric-value">12<small>μg/m³</small></div>
          <div class="metric-foot good">优</div>
        </div>
        <div class="metric">
          <div class="metric-label">${icon('bolt')} 今日用电</div>
          <div class="metric-value">2.4<small>kWh</small></div>
          <div class="metric-foot">比昨日少 12%</div>
        </div>
      </div>
    </div>

    ${overviewCameras()}
    <div class="quick-scenes">${SCENES.map(scenePill).join('')}</div>
    ${rooms.map(roomBlock).join('')}
  </section>`;
}

function overviewCameras() {
  return `<section class="overview-cams">
    <div class="overview-cams-head">
      <div><div class="eyebrow">实时监控</div><h3>${CAMERAS.length} 路画面在线</h3></div>
      <button class="text-btn" data-action="camera-page">打开监控台 ${icon('chevron')}</button>
    </div>
    <div class="overview-cam-grid">
      ${CAMERAS.map(c => `<button class="overview-cam" data-action="open-camera" data-id="${c.id}">
        <div class="cam-thumb-art" data-scene="${c.room}">
          <span class="live-dot ${c.state.privacy ? 'muted' : ''}"></span>
          <span class="cam-thumb-badge">${c.state.privacy ? '遮蔽' : 'LIVE'}</span>
          <span class="cam-thumb-clock">${c.state.privacy ? '—' : '18:42'}</span>
        </div>
        <div class="overview-cam-info"><strong>${c.name}</strong><span>${c.camera.resolution} · ${c.path === 'lan' ? '本地 P2P' : '云端'}</span></div>
      </button>`).join('')}
    </div>
  </section>`;
}

/* ---------------- 场景 ---------------- */
function pageScenes() {
  return `<section class="page">
    <div class="page-head">
      <div><div class="eyebrow">一键执行</div><h1 class="page-title">场景</h1>
      <p class="page-sub">四组常用组合，执行时按设备逐台下发，本地直连优先。</p></div>
      <div class="head-actions"><button class="ghost-btn" data-action="new-scene">${icon('plus')} 新建场景</button></div>
    </div>
    <div class="scenes-grid">
      ${SCENES.map(s => `<article class="scene-card" data-tone="${s.tone}">
        <div class="scene-art">
          <span class="orb a"></span><span class="orb b"></span><span class="orb c"></span>
          <span class="sc-ic">${icon(s.icon)}</span>
          <span class="sc-time">${s.last}</span>
        </div>
        <div class="scene-info">
          <div class="txt"><strong>${s.name}</strong><small>${s.caption}</small></div>
          <button class="run-btn" data-action="run-scene" data-id="${s.id}">${icon('play')} 执行</button>
        </div>
      </article>`).join('')}
    </div>
    <div class="room-block">
      <div class="room-head"><span class="room-title">执行记录</span><span class="line"></span></div>
      <div class="event-list" style="padding:4px 2px">
        <div class="event-row"><time>18:42</time><span class="dot"></span><span>「回家」执行完成，4 台设备，1.2 秒</span></div>
        <div class="event-row"><time>09:08</time><span class="dot"></span><span>「离家」执行完成，8 台设备全部关闭</span></div>
        <div class="event-row"><time>昨天</time><span class="dot"></span><span>「观影」执行完成，5 台设备</span></div>
      </div>
    </div>
  </section>`;
}

/* ---------------- 自动化 ---------------- */
function pageAutomations() {
  return `<section class="page">
    <div class="page-head">
      <div><div class="eyebrow">5 条规则 · 4 条启用</div><h1 class="page-title">自动化</h1>
      <p class="page-sub">时间与日出日落触发，保存在本机，应用运行时执行。</p></div>
      <div class="head-actions"><button class="primary-btn" data-action="new-automation">${icon('plus')} 新建</button></div>
    </div>
    <div class="auto-list">
      ${SCHEDULES.map(a => `<div class="auto-row ${a.enabled ? '' : 'off'}">
        <div class="auto-time">${a.time}</div>
        <div class="auto-body">
          <div class="auto-name">${icon(a.icon)} ${a.name}</div>
          <div class="auto-target">${a.target}</div>
        </div>
        <span class="auto-days">${a.days}</span>
        <button class="switch ${a.enabled ? 'on' : ''}" data-action="toggle-auto" data-id="${a.id}" role="switch" aria-checked="${a.enabled}" aria-label="${esc(a.name)}"></button>
      </div>`).join('')}
    </div>
    <p class="page-sub" style="margin-top:16px">触发记录会写入本机日志，可在设置中导出。</p>
  </section>`;
}

/* ---------------- 全部设备 ---------------- */
function pageDevices() {
  const filters = [['all', '全部'], ['lan', '本地直连'], ['cloud', '云端'], ['off', '已关闭']];
  let list = DEVICES.slice();
  if (state.deviceFilter === 'lan') list = list.filter(d => d.path === 'lan');
  if (state.deviceFilter === 'cloud') list = list.filter(d => d.path === 'cloud');
  if (state.deviceFilter === 'off') list = list.filter(d => !isOn(d));
  const q = state.deviceQuery.trim().toLowerCase();
  if (q) list = list.filter(d => `${d.name} ${d.model} ${roomById(d.room).name}`.toLowerCase().includes(q));
  return `<section class="page">
    <div class="page-head">
      <div><div class="eyebrow">${DEVICES.length} 台设备 · ${DEVICES.filter(d => d.path === 'lan').length} 台本地</div><h1 class="page-title">全部设备</h1>
      <p class="page-sub">点任意一行查看属性、连接路径与最近事件。</p></div>
      <div class="head-actions"><button class="ghost-btn" data-action="refresh">${icon('history')} 刷新状态</button></div>
    </div>
    <div class="device-toolbar">
      ${filters.map(([k, label]) => `<button class="filter-chip ${state.deviceFilter === k ? 'active' : ''}" data-action="filter" data-filter="${k}">${label}</button>`).join('')}
      <input class="device-search" id="deviceSearch" data-action="device-search" placeholder="搜索名称或型号" value="${esc(state.deviceQuery)}" aria-label="搜索设备">
      <span class="mono">${list.length} / ${DEVICES.length}</span>
    </div>
    <div class="table-head"><span>设备</span><span>房间</span><span>连接</span><span>状态</span><span>延迟</span></div>
    <div class="device-list" style="border-radius:0 0 13px 13px;border-top:0">
      ${list.map(d => {
        const camera = d.type === 'camera';
        const stateLabel = camera ? camStateLabel(d) : isOn(d) ? '开启' : '关闭';
        const stateClass = camera ? (isOn(d) ? 'live' : 'off') : isOn(d) ? '' : 'off';
        return `<div class="table-row" data-action="${camera ? 'open-camera' : 'open-device'}" data-id="${d.id}" style="cursor:default">
        <div class="table-device"><div class="device-icon" data-tone="${d.tone}">${icon(d.icon)}</div><span>${esc(d.name)}</span></div>
        <span>${roomById(d.room).name}</span>
        <span>${d.path === 'lan' ? '<span class="tag lan">本地</span>' : '<span class="tag cloud">云端</span>'}</span>
        <span><span class="state-pill ${stateClass}">${stateLabel}</span></span>
        <span class="mono">${d.online ? d.latency + ' ms' : '—'}</span>
      </div>`;}).join('')}
    </div>
  </section>`;
}

/* ---------------- 设置 ---------------- */
function pageSettings() {
  return `<section class="page">
    <div class="page-head">
      <div><div class="eyebrow">本机偏好</div><h1 class="page-title">设置</h1>
      <p class="page-sub">外观、连接策略与数据管理。凭据只保存在钥匙串。</p></div>
    </div>
    <div class="settings-grid">
      <div class="settings-card">
        <h3>外观</h3>
        <div class="setting-row"><div class="setting-label"><strong>主题</strong><small>跟随系统或固定明暗</small></div>
          <div class="segmented" data-action="theme">
            <button data-theme-set="light" class="${state.theme === 'light' ? 'active' : ''}">浅色</button>
            <button data-theme-set="dark" class="${state.theme === 'dark' ? 'active' : ''}">深色</button>
          </div>
        </div>
        <div class="setting-row"><div class="setting-label"><strong>列表密度</strong><small>影响设备行与自动化行高</small></div>
          <div class="segmented" data-action="density">
            <button data-density-set="comfortable" class="${state.density === 'comfortable' ? 'active' : ''}">宽松</button>
            <button data-density-set="compact" class="${state.density === 'compact' ? 'active' : ''}">紧凑</button>
          </div>
        </div>
        <div class="setting-row"><div class="setting-label"><strong>强调色</strong><small>按钮、开关与图表强调</small></div>
          <div class="swatches">
            <button class="swatch active" data-accent="#c44f2b" style="background:#c44f2b" aria-label="柿红"></button>
            <button class="swatch" data-accent="#4c6b52" style="background:#4c6b52" aria-label="苔绿"></button>
            <button class="swatch" data-accent="#3e5f86" style="background:#3e5f86" aria-label="靛青"></button>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3>连接</h3>
        <div class="setting-row"><div class="setting-label"><strong>局域网直连优先</strong><small>同一网段时绕过云端，直接下发指令</small></div>
          <button class="switch ${state.localFirst ? 'on' : ''}" data-action="setting-toggle" data-key="localFirst" role="switch" aria-checked="${state.localFirst}"></button></div>
        <div class="setting-row"><div class="setting-label"><strong>自动发现设备</strong><small>通过 mDNS 监听局域网内的米家设备</small></div>
          <button class="switch ${state.mdns ? 'on' : ''}" data-action="setting-toggle" data-key="mdns" role="switch" aria-checked="${state.mdns}"></button></div>
        <div class="setting-row"><div class="setting-label"><strong>云端刷新间隔</strong><small>仅影响云端设备的状态轮询</small></div>
          <div class="segmented" data-action="polling">
            ${[3000, 5000, 10000].map(v => `<button data-poll="${v}" class="${state.polling === v ? 'active' : ''}">${v / 1000} 秒</button>`).join('')}
          </div>
        </div>
      </div>

      <div class="settings-card">
        <h3>菜单栏</h3>
        <div class="setting-row"><div class="setting-label"><strong>显示菜单栏图标</strong><small>常驻图标，点开即可控制常用设备</small></div>
          <button class="switch ${state.menuBar ? 'on' : ''}" data-action="setting-toggle" data-key="menuBar" role="switch" aria-checked="${state.menuBar}"></button></div>
        <div class="setting-row"><div class="setting-label"><strong>快捷键</strong><small>打开主窗口与命令面板</small></div>
          <span class="mono">⌘⇧M / ⌘K</span></div>
        <div class="setting-row"><div class="setting-label"><strong>登录状态</strong><small>演示账号 · 凭据有效</small></div>
          <button class="danger-btn" data-action="sign-out">退出登录</button></div>
      </div>

      <div class="settings-card">
        <h3>数据</h3>
        <div class="setting-row"><div class="setting-label"><strong>本机缓存</strong><small>设备列表、规格与图标，18.4 MB</small></div>
          <button class="ghost-btn" data-action="clear-cache">清除</button></div>
        <div class="setting-row"><div class="setting-label"><strong>诊断日志</strong><small>包含连接路径与请求耗时，不含凭据</small></div>
          <button class="ghost-btn" data-action="export-log">导出</button></div>
        <div class="setting-row"><div class="setting-label"><strong>版本</strong><small>0.1.0 · 原型</small></div>
          <span class="mono">arm64</span></div>
      </div>
    </div>
  </section>`;
}

/* ---------------- 监控 ---------------- */
function camBitrate(c) {
  if (c.state.quality === 'sd') return '0.7';
  if (c.state.quality === 'auto') return c.path === 'lan' ? '1.6' : '1.0';
  return c.path === 'lan' ? (c.camera.resolution === '2K' ? '3.0' : '2.2') : '1.2';
}

function camSpec(c) {
  const res = c.state.quality === 'sd'
    ? (c.camera.resolution === '2K' ? '1080p' : '720p')
    : c.camera.resolution;
  return `${res} · ${c.camera.codec} · ${camBitrate(c)} Mbps`;
}

function camStateLabel(c) {
  if (c.state.privacy) return '隐私遮蔽';
  return c.state.live ? '直播中' : '离线';
}

function camCard(c, active) {
  return `<button class="cam-card ${active ? 'active' : ''}" data-action="select-camera" data-id="${c.id}">
    <div class="cam-thumb-art" data-scene="${c.room}">
      <span class="live-dot ${c.state.privacy ? 'muted' : ''}"></span>
      <span class="cam-thumb-badge">${camStateLabel(c)}</span>
      <span class="cam-thumb-clock">${c.state.privacy ? '—' : '18:42'}</span>
    </div>
    <div class="cam-card-info">
      <strong>${c.name}</strong>
      <span>${c.camera.resolution} · ${c.path === 'lan' ? '本地 P2P' : '云端'} · ${c.latency} ms</span>
    </div>
  </button>`;
}

function ptzHTML() {
  return `<div class="cam-ptz" aria-label="云台控制">
    <button data-action="cam-ptz" data-dir="up" title="上抬">${icon('up')}</button>
    <button data-action="cam-ptz" data-dir="left" title="左转">${icon('left')}</button>
    <button class="ptz-center" data-action="cam-ptz" data-dir="center" title="回到中间">·</button>
    <button data-action="cam-ptz" data-dir="right" title="右转">${icon('right')}</button>
    <button data-action="cam-ptz" data-dir="down" title="下压">${icon('down')}</button>
  </div>`;
}

function cameraStage(a) {
  const replay = state.cameraMode === 'replay';
  const event = state.cameraEvent;
  return `<div class="camera-layout">
    <div class="camera-stage">
      <div class="camera-frame ${replay ? 'replay' : ''}" id="cameraFrame">
        <canvas id="cameraCanvas" data-camera="${a.id}" width="1280" height="720"></canvas>
        <div class="cam-grain"></div><div class="cam-scanlines"></div><div class="cam-vignette"></div>
        <div class="cam-top">
          <span class="live-pill ${replay ? 'replay' : ''}"><i></i>${replay ? 'REPLAY' : 'LIVE'}</span>
          <span class="cam-clock" id="camClock">${replay && event ? event.time + ':00' : '18:42:07'}</span>
          <span class="cam-spec">${camSpec(a)}</span>
          <span class="cam-latency">${a.path === 'lan' ? 'P2P' : '云端'} ${a.latency} ms</span>
        </div>
        <div class="cam-bottom">
          <div class="cam-title"><strong>${a.name}</strong><span>${roomById(a.room).name} · ${a.camera.lens} · ${a.camera.protocol}</span></div>
          <div class="cam-rec">${a.state.recording ? '<i class="rec-dot"></i>录制中' : '<i class="rec-dot off"></i>未录制'}</div>
        </div>
        ${a.state.ptz ? ptzHTML() : ''}
        ${a.state.privacy ? `<div class="cam-private">${icon('shield')}<strong>隐私遮蔽已开启</strong><span>镜头已转向底座，画面不会离开这台摄像头。</span><button class="ghost-btn" data-action="cam-privacy">解除遮蔽</button></div>` : ''}
        ${state.cameraPaused && !a.state.privacy ? '<div class="cam-paused">已暂停</div>' : ''}
        <div class="cam-flash" id="camFlash"></div>
      </div>
      <div class="camera-toolbar">
        <div class="quality-switch" data-action="cam-quality">
          ${[['auto', '自动'], ['hd', '高清'], ['sd', '流畅']].map(([q, label]) => `<button data-quality="${q}" class="${a.state.quality === q ? 'active' : ''}">${label}</button>`).join('')}
        </div>
        <div class="camera-tools">
          <button class="cam-tool ${state.cameraPaused ? 'active' : ''}" data-action="cam-play">${icon(state.cameraPaused ? 'play' : 'pause')} ${state.cameraPaused ? '继续' : '暂停'}</button>
          <button class="cam-tool ${a.state.sound ? 'active' : ''}" data-action="cam-sound">${icon('volume')} 对讲</button>
          <button class="cam-tool ${a.state.recording ? 'active' : ''}" data-action="cam-record">${icon('record')} ${a.state.recording ? '停止' : '录制'}</button>
          <button class="cam-tool ${replay ? 'active' : ''}" data-action="cam-mode">${icon('history')} ${replay ? '实时' : '回放'}</button>
          <button class="cam-tool" data-action="cam-full">${icon('expand')} 全屏</button>
          <button class="cam-tool" data-action="cam-privacy">${icon('shield')} ${a.state.privacy ? '解除' : '遮蔽'}</button>
        </div>
      </div>
      <div class="camera-events">
        <span class="events-label">最近事件</span>
        ${a.camera.events.slice(0, 3).map(e => `<button class="event-chip" data-action="cam-event" data-time="${e.time}"><b>${e.time}</b>${e.label}</button>`).join('')}
        <button class="text-btn" data-action="cam-events">全部事件 ${icon('chevron')}</button>
      </div>
    </div>
    <aside class="camera-side">
      <div class="cam-side-head"><span>摄像头</span><span>${CAMERAS.length}</span></div>
      <div class="cam-side-list">${CAMERAS.map(c => camCard(c, c.id === a.id)).join('')}</div>
      <div class="cam-side-note">${icon('lock')} 画面只在本机解码，默认不上传云端。局域网不可达时显示离线，不用云端转发冒充实时。</div>
    </aside>
  </div>`;
}

function cameraWall() {
  return `<div class="camera-wall">
    ${CAMERAS.map(c => `<button class="wall-card" data-action="select-camera" data-id="${c.id}">
      <canvas data-camera="${c.id}" width="960" height="540"></canvas>
      <div class="wall-hud"><span class="live-pill"><i></i>LIVE</span><span>${c.name}</span><span>${camSpec(c)}</span></div>
      <div class="wall-bottom"><span>${roomById(c.room).name} · ${c.path === 'lan' ? '本地 P2P' : '云端'}</span><strong>${c.latency} ms</strong></div>
    </button>`).join('')}
  </div>`;
}

function cameraTimeline(c) {
  const events = c.camera.events;
  const pct = time => {
    const [h, m] = time.split(':').map(Number);
    return ((h * 60 + m) / 1440) * 100;
  };
  return `<section class="camera-timeline">
    <div class="timeline-head">
      <div><div class="eyebrow">今天 · 10 月 29 日</div><h3>事件时间线</h3></div>
      <div class="timeline-head-actions">
        <span class="timeline-legend"><i class="legend-motion"></i>移动 <i class="legend-record"></i>录制</span>
        <button class="ghost-btn" data-action="cam-mode">${state.cameraMode === 'live' ? icon('history') + ' 回放' : icon('play') + ' 回到直播'}</button>
      </div>
    </div>
    <div class="timeline-ruler"><span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>24:00</span></div>
    <div class="timeline-track">
      <span class="timeline-recorded"></span><span class="timeline-live"></span>
      ${events.map(e => `<button class="timeline-mark" style="left:${pct(e.time)}%" data-action="cam-event" data-time="${e.time}" title="${e.time} ${e.label}"></button>`).join('')}
      <span class="timeline-playhead" style="left:${pct(state.cameraMode === 'replay' && state.cameraEvent ? state.cameraEvent.time : '18:42')}%"></span>
    </div>
    <div class="timeline-list">
      ${events.map(e => `<button class="timeline-event" data-action="cam-event" data-time="${e.time}">
        <time>${e.time}</time><span class="timeline-event-dot ${e.type}"></span>
        <span class="timeline-event-copy"><strong>${e.label}</strong><small>${e.detail}</small></span>
        <span class="timeline-event-play">${icon('play')}</span>
      </button>`).join('')}
    </div>
  </section>`;
}

function pageCamera() {
  const active = deviceById(state.camera) || CAMERAS[0];
  const online = CAMERAS.filter(c => c.state.live && !c.state.privacy).length;
  const local = CAMERAS.filter(c => c.path === 'lan').length;
  return `<section class="page camera-page">
    <div class="page-head">
      <div>
        <div class="eyebrow">${online} 路在线 · ${local} 路本地 P2P</div>
        <h1 class="page-title">监控</h1>
        <p class="page-sub">同一局域网内 P2P 直连；不在家时通过家庭 VPN 回连，未配置则显示离线。默认不留存，录制需手动开启。</p>
      </div>
      <div class="head-actions">
        <button class="ghost-btn ${state.cameraGrid ? 'active' : ''}" data-action="camera-grid">${icon('grid')} ${state.cameraGrid ? '单画面' : '宫格'}</button>
        <button class="primary-btn" data-action="cam-snapshot">${icon('camera')} 截图</button>
      </div>
    </div>
    ${state.cameraGrid ? cameraWall() : cameraStage(active)}
    ${cameraTimeline(active)}
  </section>`;
}

let cameraRAF = null;
let cameraLast = 0;

function drawCameraFrames(t) {
  $$('#main canvas[data-camera]').forEach(canvas => {
    const c = deviceById(canvas.dataset.camera);
    if (c) drawCameraScene(canvas, c, t);
  });
}

function startCameraLoop() {
  if (cameraRAF) return;
  const tick = ts => {
    cameraRAF = requestAnimationFrame(tick);
    if (ts - cameraLast < 42) return;
    cameraLast = ts;
    if (state.cameraPaused) return;
    drawCameraFrames(ts / 1000);
  };
  cameraRAF = requestAnimationFrame(tick);
}

function stopCameraLoop() {
  if (cameraRAF) cancelAnimationFrame(cameraRAF);
  cameraRAF = null;
}

function syncCameraLoop() {
  if (state.page !== 'camera') { stopCameraLoop(); return; }
  drawCameraFrames(performance.now() / 1000);
  startCameraLoop();
}

function drawCameraScene(canvas, cam, t) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  const rr = (x, y, w, h, r) => {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  };
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
  const scene = cam.room;
  let g;

  if (scene === 'living') {
    g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#343a40'); g.addColorStop(.7, '#1b1f23'); g.addColorStop(1, '#0d0f11');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(.45 * W, .04 * H, 0, .45 * W, .04 * H, .6 * W);
    g.addColorStop(0, 'rgba(255,235,205,.12)'); g.addColorStop(1, 'rgba(255,235,205,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, .7 * H);

    // window with dusk skyline
    const wx = .56 * W, wy = .10 * H, ww = .34 * W, wh = .54 * H;
    g = ctx.createLinearGradient(0, wy, 0, wy + wh);
    g.addColorStop(0, '#5d768b'); g.addColorStop(.55, '#30485a'); g.addColorStop(1, '#16242e');
    ctx.fillStyle = g; rr(wx, wy, ww, wh, 3); ctx.fill();
    ctx.fillStyle = 'rgba(9,13,18,.72)';
    for (let i = 0; i < 12; i++) {
      const bw = W * (0.018 + (i % 4) * 0.007), bh = H * (0.03 + (i % 5) * 0.018);
      ctx.fillRect(wx + ww * (0.04 + i * 0.075), wy + wh - bh, bw, bh);
    }
    ctx.fillStyle = 'rgba(255,214,143,.38)';
    for (let i = 0; i < 16; i++) ctx.fillRect(wx + ww * (0.08 + (i * 0.19) % 0.82), wy + wh * (0.42 + (i % 4) * 0.1), 2.2, 2.2);
    ctx.strokeStyle = '#101418'; ctx.lineWidth = 5;
    line(wx + ww / 2, wy, wx + ww / 2, wy + wh); line(wx, wy + wh * .42, wx + ww, wy + wh * .42);
    ctx.strokeStyle = 'rgba(220,235,245,.18)'; ctx.lineWidth = 3;
    rr(wx, wy, ww, wh, 3); ctx.stroke();

    // curtain, breathing with the window draft
    const sway = Math.sin(t * .42) * W * .006;
    ctx.fillStyle = 'rgba(24,23,22,.92)';
    ctx.beginPath();
    ctx.moveTo(wx - W * .035, wy - H * .01);
    ctx.bezierCurveTo(wx - W * .01 + sway, wy + wh * .25, wx - W * .05 + sway, wy + wh * .65, wx - W * .025, wy + wh + H * .01);
    ctx.lineTo(wx + W * .06, wy + wh + H * .01);
    ctx.bezierCurveTo(wx + W * .08 + sway, wy + wh * .6, wx + W * .03 + sway, wy + wh * .26, wx + W * .05, wy - H * .01);
    ctx.closePath(); ctx.fill();

    // warm floor lamp
    const lx = .085 * W, ly = .62 * H;
    g = ctx.createRadialGradient(lx, ly - H * .2, 2, lx, ly - H * .2, W * .18);
    g.addColorStop(0, 'rgba(255,196,112,.5)'); g.addColorStop(.45, 'rgba(255,172,84,.16)'); g.addColorStop(1, 'rgba(255,160,70,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W * .34, H * .8);
    ctx.strokeStyle = '#171513'; ctx.lineWidth = 3; line(lx, ly, lx, .34 * H);
    ctx.fillStyle = '#d8b27a';
    ctx.beginPath(); ctx.moveTo(lx - .035 * W, .34 * H); ctx.lineTo(lx + .035 * W, .34 * H); ctx.lineTo(lx + .025 * W, .28 * H); ctx.lineTo(lx - .025 * W, .28 * H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#171513'; rr(lx - .05 * W, ly, .1 * W, .018 * H, 3); ctx.fill();

    // rug and sofa
    ctx.fillStyle = 'rgba(57,44,33,.55)';
    ctx.beginPath(); ctx.ellipse(.43 * W, .79 * H, .39 * W, .105 * H, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a383c'; rr(.11 * W, .46 * H, .40 * W, .20 * H, 8); ctx.fill();
    ctx.fillStyle = '#464247'; rr(.13 * W, .40 * H, .36 * W, .14 * H, 8); ctx.fill();
    ctx.fillStyle = '#565054'; rr(.15 * W, .435 * H, .145 * W, .095 * H, 6); ctx.fill();
    ctx.fillStyle = '#5d554c'; rr(.31 * W, .435 * H, .145 * W, .095 * H, 6); ctx.fill();
    ctx.fillStyle = '#1a191b'; ctx.fillRect(.14 * W, .655 * H, .012 * W, .035 * H); ctx.fillRect(.46 * W, .655 * H, .012 * W, .035 * H);

    // coffee table
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(.37 * W, .73 * H, .16 * W, .025 * H, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#4a3527'; rr(.27 * W, .66 * H, .22 * W, .022 * H, 3); ctx.fill();
    ctx.strokeStyle = '#2a1e16'; ctx.lineWidth = 4; line(.29 * W, .68 * H, .29 * W, .72 * H); line(.47 * W, .68 * H, .47 * W, .72 * H);

    // plant
    ctx.fillStyle = '#7b5a3a'; rr(.51 * W, .62 * H, .05 * W, .07 * H, 3); ctx.fill();
    ctx.strokeStyle = '#2d4435'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(.535 * W, .63 * H); ctx.bezierCurveTo(.51 * W, .54 * H, .50 * W, .50 * H, .49 * W, .45 * H); ctx.stroke();
    ctx.fillStyle = '#29402f';
    ctx.beginPath(); ctx.ellipse(.49 * W, .45 * H, .045 * W, .018 * H, -.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(.55 * W, .51 * H, .05 * W, .018 * H, .5, 0, Math.PI * 2); ctx.fill();

    // wall frames
    ctx.strokeStyle = 'rgba(170,150,120,.35)'; ctx.lineWidth = 2;
    rr(.18 * W, .20 * H, .075 * W, .10 * H, 1); ctx.stroke();
    rr(.27 * W, .24 * H, .05 * W, .07 * H, 1); ctx.stroke();

    // a cat crossing the rug, slow enough to read as motion
    if (cam.state.motion) {
      const cx = .47 * W + Math.sin(t * .11) * .10 * W;
      const cy = .70 * H;
      ctx.fillStyle = 'rgba(8,8,9,.78)';
      ctx.beginPath(); ctx.ellipse(cx, cy, .035 * W, .018 * H, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + .035 * W, cy - .014 * H, .016 * W, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx + .026 * W, cy - .026 * H); ctx.lineTo(cx + .034 * W, cy - .041 * H); ctx.lineTo(cx + .042 * W, cy - .025 * H); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(8,8,9,.78)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(cx - .035 * W, cy); ctx.bezierCurveTo(cx - .07 * W, cy - .02 * H, cx - .06 * W, cy - .05 * H, cx - .08 * W, cy - .055 * H); ctx.stroke();
    }
  } else if (scene === 'entry') {
    g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#272523'); g.addColorStop(.7, '#171513'); g.addColorStop(1, '#0e0d0c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1d1b18'; ctx.fillRect(0, .72 * H, W, .28 * H);
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) line(0, .72 * H + i * .055 * H, W, .72 * H + i * .055 * H);
    for (let i = 1; i < 7; i++) line(i * .16 * W, .72 * H, i * .16 * W, H);

    // door
    ctx.fillStyle = '#3a3028'; rr(.10 * W, .17 * H, .29 * W, .59 * H, 2); ctx.fill();
    ctx.strokeStyle = '#241d18'; ctx.lineWidth = 6; rr(.10 * W, .17 * H, .29 * W, .59 * H, 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 2;
    rr(.14 * W, .22 * H, .21 * W, .20 * H, 2); ctx.stroke();
    rr(.14 * W, .48 * H, .21 * W, .22 * H, 2); ctx.stroke();
    ctx.fillStyle = '#b58a4e'; ctx.beginPath(); ctx.arc(.35 * W, .50 * H, .008 * W, 0, Math.PI * 2); ctx.fill();

    // warm sidelight + ceiling light
    g = ctx.createRadialGradient(.44 * W, .30 * H, 2, .44 * W, .30 * H, .36 * W);
    g.addColorStop(0, 'rgba(255,190,110,.22)'); g.addColorStop(1, 'rgba(255,180,100,0)');
    ctx.fillStyle = g; ctx.fillRect(.1 * W, 0, .65 * W, .75 * H);
    ctx.fillStyle = 'rgba(255,214,150,.55)'; rr(.09 * W, .16 * H, .012 * W, .60 * H, 4); ctx.fill();

    // console table + mirror
    ctx.fillStyle = '#2b2119'; rr(.55 * W, .47 * H, .30 * W, .025 * H, 2); ctx.fill();
    ctx.strokeStyle = '#21180f'; ctx.lineWidth = 5; line(.58 * W, .49 * H, .58 * W, .68 * H); line(.82 * W, .49 * H, .82 * W, .68 * H);
    ctx.fillStyle = 'rgba(190,210,218,.10)'; rr(.59 * W, .23 * H, .22 * W, .22 * H, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = 2; rr(.59 * W, .23 * H, .22 * W, .22 * H, 3); ctx.stroke();

    // package on the floor
    ctx.fillStyle = '#8a6a44'; rr(.61 * W, .70 * H, .14 * W, .12 * H, 1); ctx.fill();
    ctx.strokeStyle = '#cbb28b'; ctx.lineWidth = 3; line(.68 * W, .70 * H, .68 * W, .82 * H);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillRect(.70 * W, .735 * H, .035 * W, .018 * H);

    // coat hooks and a hanging coat
    ctx.fillStyle = '#26221e'; rr(.44 * W, .28 * H, .07 * W, .012 * H, 2); ctx.fill();
    ctx.fillStyle = '#1a1a1b';
    ctx.beginPath(); ctx.moveTo(.46 * W, .29 * H); ctx.lineTo(.45 * W, .42 * H); ctx.lineTo(.49 * W, .47 * H); ctx.lineTo(.51 * W, .38 * H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.beginPath(); ctx.ellipse(.72 * W, .80 * H, .18 * W, .035 * H, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    // balcony: night skyline, railing and plants
    g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#141b24'); g.addColorStop(.55, '#1e2a34'); g.addColorStop(1, '#0b0f12');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(9,13,17,.82)';
    for (let i = 0; i < 18; i++) {
      const bw = W * (.025 + (i % 5) * .008), bh = H * (.06 + (i % 7) * .025);
      ctx.fillRect(i * .057 * W, .58 * H - bh, bw, bh);
    }
    ctx.fillStyle = 'rgba(255,221,158,.5)';
    for (let i = 0; i < 24; i++) ctx.fillRect((i * .043 + .01) * W, (.50 + (i % 5) * .02) * H, 2, 2);

    // railing
    ctx.strokeStyle = '#1c1f21'; ctx.lineWidth = 8; line(0, .42 * H, W, .42 * H);
    ctx.lineWidth = 4; line(0, .56 * H, W, .56 * H);
    for (let i = 1; i < 8; i++) line(i * .13 * W, .40 * H, i * .13 * W, .78 * H);
    ctx.fillStyle = '#111416'; ctx.fillRect(0, .76 * H, W, .24 * H);
    ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) line(0, .76 * H + i * .04 * H, W, .76 * H + i * .04 * H);

    // planters
    ctx.fillStyle = '#40372e'; rr(.08 * W, .64 * H, .10 * W, .12 * H, 3); ctx.fill();
    ctx.fillStyle = '#28402f';
    for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse((.11 + i * .012) * W, (.58 - i * .012) * H, .022 * W, .055 * H, -.3 + i * .15, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#3c332a'; rr(.78 * W, .68 * H, .12 * W, .10 * H, 3); ctx.fill();
    ctx.fillStyle = '#2c4634';
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse((.82 + i * .018) * W, (.63 - i * .01) * H, .018 * W, .05 * H, .4 - i * .2, 0, Math.PI * 2); ctx.fill(); }

    // string lights
    ctx.strokeStyle = 'rgba(220,210,180,.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, .22 * H); ctx.quadraticCurveTo(.5 * W, .34 * H, W, .20 * H); ctx.stroke();
    for (let i = 0; i < 9; i++) {
      const x = (i + .5) / 9 * W, y = .22 * H + Math.sin((i + .5) / 9 * Math.PI) * .08 * H + .01 * H;
      const gl = ctx.createRadialGradient(x, y, 0, x, y, 14);
      gl.addColorStop(0, 'rgba(255,220,150,.85)'); gl.addColorStop(1, 'rgba(255,220,150,0)');
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffe2a4'; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    }

    // rain streaks
    ctx.strokeStyle = 'rgba(180,205,220,.13)'; ctx.lineWidth = 1.2;
    for (let i = 0; i < 24; i++) {
      const x = ((i * 53 + t * 30) % W), y = ((i * 97 + t * 260) % H);
      line(x, y, x - 4, y + 14);
    }
  }

  // shared grade: vignette, grain, subtle scanline
  g = ctx.createRadialGradient(W * .5, H * .45, H * .18, W * .5, H * .5, H * .78);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.75, 'rgba(0,0,0,.16)'); g.addColorStop(1, 'rgba(0,0,0,.62)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = .05;
  for (let i = 0; i < 48; i++) {
    const x = Math.random() * W, y = Math.random() * H;
    ctx.fillStyle = i % 2 ? '#fff' : '#000';
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ---------------- 检查器 ---------------- */
function eventsFor(d) {
  const base = [
    ['18:42', `${MODE_LABEL[d.state.mode] || '状态'}已同步`],
    ['18:40', `通过${d.path === 'lan' ? '局域网' : '云端'}下发指令`],
    ['17:55', `状态上报 ${deviceSummary(d)}`],
    ['17:12', '自动化「回家」执行'],
  ];
  return base;
}

function dialHTML(value, min, max, unit, label, step = 1) {
  const pct = (value - min) / (max - min);
  return `<div class="dial-wrap">
    <div class="dial" data-action="dial" data-min="${min}" data-max="${max}" data-step="${step}" role="slider"
      aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${value}" aria-label="${label}">
      <svg viewBox="0 0 224 224" aria-hidden="true">
        <circle class="track" cx="112" cy="112" r="98"></circle>
        <circle class="progress" cx="112" cy="112" r="98" stroke-dasharray="${(462 * pct).toFixed(1)} 616"></circle>
      </svg>
      <div class="dial-center"><b>${value}</b><span>${unit}</span></div>
    </div>
    <div class="dial-hint">拖动圆环调整</div>
  </div>`;
}

function inspectorBody(d) {
  const s = d.state;
  let main = '';
  if (d.type === 'light') {
    main = `${dialHTML(s.brightness, 1, 100, '%', '亮度')}
      <div class="dial-actions">
        <button class="round-btn ${!s.on ? 'primary' : ''}" data-action="toggle-device" data-id="${d.id}" aria-label="开关">${icon('power')}</button>
        <button class="round-btn" data-action="brightness-preset" data-id="${d.id}" data-value="20" aria-label="夜灯">${icon('moon')}</button>
        <button class="round-btn" data-action="brightness-preset" data-id="${d.id}" data-value="100" aria-label="最亮">${icon('sun')}</button>
      </div>
      <div class="insp-section">
        <div class="insp-label">场景 <b>${MODE_LABEL[s.mode] || '自定义'}</b></div>
        <div class="seg-row">
          <button data-action="light-mode" data-id="${d.id}" data-mode="sleep" class="${s.mode === 'sleep' ? 'active' : ''}">夜灯</button>
          <button data-action="light-mode" data-id="${d.id}" data-mode="read" class="${s.mode === 'read' ? 'active' : ''}">阅读</button>
          <button data-action="light-mode" data-id="${d.id}" data-mode="work" class="${s.mode === 'work' ? 'active' : ''}">专注</button>
          <button data-action="light-mode" data-id="${d.id}" data-mode="normal" class="${s.mode === 'normal' ? 'active' : ''}">标准</button>
        </div>
      </div>
      <div class="insp-section">
        <div class="slider-block">
          <div class="slider-head"><span>色温</span><b>${s.colorTemp} K</b></div>
          <input type="range" min="2700" max="6500" step="100" value="${s.colorTemp}" style="--v:${((s.colorTemp - 2700) / 3800) * 100}%"
            data-action="color-temp" data-id="${d.id}" aria-label="色温">
          <div class="range-scale"><span>暖 2700K</span><span>冷 6500K</span></div>
        </div>
      </div>`;
  } else if (d.type === 'ac') {
    main = `${dialHTML(s.temp, 16, 30, '°C', '目标温度')}
      <div class="dial-actions">
        <button class="round-btn ${!s.on ? 'primary' : ''}" data-action="toggle-device" data-id="${d.id}" aria-label="开关">${icon('power')}</button>
        <button class="round-btn ${s.swing ? 'primary' : ''}" data-action="ac-swing" data-id="${d.id}" aria-label="扫风">${icon('wind')}</button>
      </div>
      <div class="insp-section">
        <div class="insp-label">模式 <b>${MODE_LABEL[s.mode]}</b></div>
        <div class="seg-row">
          ${['cool', 'dry', 'fan', 'heat'].map(m => `<button data-action="ac-mode" data-id="${d.id}" data-mode="${m}" class="${s.mode === m ? 'active' : ''}">${MODE_LABEL[m]}</button>`).join('')}
        </div>
      </div>
      <div class="insp-section">
        <div class="insp-label">风速 <b>${FAN_LABEL[s.fan]}</b></div>
        <div class="seg-row">
          ${[0, 1, 3, 7].map(f => `<button data-action="ac-fan" data-id="${d.id}" data-fan="${f}" class="${s.fan === f ? 'active' : ''}">${FAN_LABEL[f]}</button>`).join('')}
        </div>
      </div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>室内</span><b>${s.indoor}°</b></div>
        <div class="stat-box"><span>室外</span><b>${s.outdoor}°</b></div>
        <div class="stat-box"><span>运行</span><b>2.2h</b></div>
      </div></div>`;
  } else if (d.type === 'curtain') {
    main = `<div style="text-align:center;padding:12px 0 4px"><div class="big-value">${s.position}<small>%</small></div>
      <div class="insp-sub" style="margin-top:6px">${s.position === 0 ? '已关闭' : s.position === 100 ? '全开' : '开合中停止'}</div></div>
      <div class="dial-actions" style="margin-top:14px">
        <button class="round-btn" data-action="curtain" data-id="${d.id}" data-pos="100" aria-label="全开">${icon('sun')}</button>
        <button class="round-btn primary" data-action="curtain" data-id="${d.id}" data-pos="0" aria-label="全关">${icon('moon')}</button>
      </div>
      <div class="insp-section"><div class="slider-block">
        <div class="slider-head"><span>开合位置</span><b>${s.position}%</b></div>
        <input type="range" min="0" max="100" value="${s.position}" style="--v:${s.position}%" data-action="curtain-slider" data-id="${d.id}" aria-label="开合位置">
        <div class="range-scale"><span>关闭</span><span>全开</span></div>
      </div></div>`;
  } else if (d.type === 'purifier') {
    main = `<div style="display:flex;align-items:flex-end;gap:8px;padding:4px 0 2px"><div class="big-value">${s.pm25}</div><span class="insp-sub" style="padding-bottom:6px">μg/m³ · PM2.5</span></div>
      <div class="insp-sub">空气优，滤芯剩余 ${s.filter}%</div>
      <div class="insp-section">
        <div class="insp-label">模式 <b>${MODE_LABEL[s.mode]}</b></div>
        <div class="seg-row">
          <button data-action="purifier-mode" data-id="${d.id}" data-mode="auto" class="${s.mode === 'auto' ? 'active' : ''}">自动</button>
          <button data-action="purifier-mode" data-id="${d.id}" data-mode="sleep" class="${s.mode === 'sleep' ? 'active' : ''}">睡眠</button>
          <button data-action="purifier-mode" data-id="${d.id}" data-mode="favorite" class="${s.mode === 'favorite' ? 'active' : ''}">收藏</button>
        </div>
      </div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>温度</span><b>${s.temp}°</b></div>
        <div class="stat-box"><span>湿度</span><b>${s.humidity}%</b></div>
        <div class="stat-box"><span>滤芯</span><b>${s.filter}%</b></div>
      </div></div>
      <div class="insp-section"><button class="primary-btn" style="width:100%" data-action="toggle-device" data-id="${d.id}">${s.on ? '关闭净化器' : '打开净化器'}</button></div>`;
  } else if (d.type === 'sensor') {
    main = `<div style="display:flex;align-items:flex-end;gap:8px;padding:2px 0 4px"><div class="big-value">${s.temperature}</div><span class="insp-sub" style="padding-bottom:6px">°C</span></div>
      <div class="insp-sub">湿度 ${s.humidity}% · 电池 ${s.battery}%</div>
      <div class="insp-section"><div class="insp-label">过去 24 小时温度 <b>24.6°</b></div>
        <div class="chart-wrap">${heroSpark(s.series)}</div>
        <div class="range-scale"><span>昨天 18:00</span><span>现在</span></div>
      </div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>最高</span><b>25.2°</b></div>
        <div class="stat-box"><span>最低</span><b>23.7°</b></div>
        <div class="stat-box"><span>电池</span><b>${s.battery}%</b></div>
      </div></div>`;
  } else if (d.type === 'humidifier') {
    main = `${dialHTML(s.targetHumidity, 30, 70, '%', '目标湿度')}
      <div class="dial-actions"><button class="round-btn ${!s.on ? 'primary' : ''}" data-action="toggle-device" data-id="${d.id}" aria-label="开关">${icon('power')}</button></div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>当前湿度</span><b>${s.humidity}%</b></div>
        <div class="stat-box"><span>水箱</span><b>${s.waterLevel}%</b></div>
        <div class="stat-box"><span>剩余</span><b>9h</b></div>
      </div></div>`;
  } else if (d.type === 'plug') {
    main = `<div style="display:flex;align-items:flex-end;gap:8px;padding:4px 0 2px"><div class="big-value">${s.power}</div><span class="insp-sub" style="padding-bottom:6px">W · 实时功率</span></div>
      <div class="insp-sub">今日用电 0.42 kWh，约 0.26 元</div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>电压</span><b>${s.voltage}V</b></div>
        <div class="stat-box"><span>电流</span><b>${s.current}A</b></div>
        <div class="stat-box"><span>温度</span><b>31°</b></div>
      </div></div>
      <div class="insp-section"><button class="primary-btn" style="width:100%" data-action="toggle-device" data-id="${d.id}">${s.on ? '断开插座' : '接通插座'}</button></div>`;
  } else if (d.type === 'vacuum') {
    main = `<div style="display:flex;align-items:flex-end;gap:8px;padding:4px 0 2px"><div class="big-value">${s.battery}</div><span class="insp-sub" style="padding-bottom:6px">% · 电量</span></div>
      <div class="insp-sub">${STATUS_LABEL[s.status]} · 上次清扫 68 m² / 54 分钟</div>
      <div class="dial-actions" style="margin-top:16px">
        <button class="round-btn primary" data-action="vacuum" data-id="${d.id}" aria-label="开始或暂停">${icon(s.status === 'cleaning' ? 'pause' : 'play')}</button>
        <button class="round-btn" data-action="vacuum-dock" data-id="${d.id}" aria-label="回充">${icon('dock')}</button>
      </div>
      <div class="insp-section"><div class="stat-grid">
        <div class="stat-box"><span>清扫面积</span><b>${s.area}m²</b></div>
        <div class="stat-box"><span>耗时</span><b>54m</b></div>
        <div class="stat-box"><span>耗材</span><b>68%</b></div>
      </div></div>`;
  }

  return `<div class="inspector-inner">
    <div class="insp-head">
      <div class="insp-icon" data-tone="${d.tone}">${icon(d.icon)}</div>
      <div><div class="insp-title">${esc(d.name)}</div>
        <div class="insp-sub">${roomById(d.room).name} · ${esc(d.model)}</div></div>
      <button class="insp-close" data-action="close-inspector" aria-label="关闭">${icon('close')}</button>
    </div>
    ${main}
    <div class="insp-section">
      <div class="insp-label">连接</div>
      <div class="path-card">
        <div class="path-row">${icon('bolt')} 局域网直连 <span class="path-badge">${d.path === 'lan' ? '当前' : '可用'}</span><b>${d.latency} ms</b></div>
        <div class="path-row">${icon('cloud')} 云端转发 <b>168 ms</b></div>
        <div class="path-row">${icon('history')} 固件 <b>${d.firmware}</b></div>
      </div>
    </div>
    <div class="insp-section">
      <div class="insp-label">最近事件</div>
      <div class="event-list">${eventsFor(d).map(([t, text]) => `<div class="event-row"><time>${t}</time><span class="dot"></span><span>${esc(text)}</span></div>`).join('')}</div>
    </div>
  </div>`;
}

function renderInspector() {
  const el = $('#inspector');
  if (!state.selected) {
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '';
    return;
  }
  const d = deviceById(state.selected);
  if (!d) { state.selected = null; return renderInspector(); }
  el.innerHTML = inspectorBody(d);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  bindDial();
}

/* ---------------- 渲染 ---------------- */
const PAGES = { overview: pageOverview, camera: pageCamera, scenes: pageScenes, automations: pageAutomations, devices: pageDevices, settings: pageSettings };

function renderCurrent(preserveScroll = false) {
  const main = $('#main');
  const top = preserveScroll ? main.scrollTop : 0;
  const t0 = performance.now();
  main.innerHTML = PAGES[state.page]();
  main.scrollTop = top;
  syncCameraLoop();
  requestAnimationFrame(() => {
    state.lastRender = performance.now() - t0;
    const el = $('#hudRender');
    if (el) el.textContent = state.lastRender.toFixed(1) + ' ms';
    updateHud();
  });
  renderInspector();
  renderRooms();
  updateChrome();
}

function renderRooms() {
  const list = $('#roomList');
  list.innerHTML = HOME.rooms.map(r => {
    const count = DEVICES.filter(d => d.room === r.id).length;
    const on = DEVICES.filter(d => d.room === r.id && isOn(d)).length;
    return `<button class="room-item ${state.room === r.id ? 'active' : ''}" data-action="select-room" data-room="${r.id}">
      <span class="room-glyph">${r.short}</span><span>${r.name}</span>
      ${on ? '<i class="room-dot"></i>' : ''}<span class="room-count">${count}</span>
    </button>`;
  }).join('');
}

function updateChrome() {
  const nav = { overview: '总览', camera: '监控', scenes: '场景', automations: '自动化', devices: '全部设备', settings: '设置' };
  $$('#mainNav .nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === state.page));
  $$('.sidebar-footer .nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === state.page));
  const roomName = state.room === 'all' ? '' : roomById(state.room).name + ' · ';
  $('#windowTitle').textContent = `${roomName}${nav[state.page]} — 云栖公寓`;
  const lan = DEVICES.filter(d => d.path === 'lan').length;
  $('#statusPath').textContent = `${lan} 台本地直连 · ${DEVICES.length - lan} 台云端`;
  $('#deviceCountNav').textContent = DEVICES.length;
  $('#cameraCountNav').textContent = CAMERAS.length;
  updateHud();
}

/* ---------------- 交互 ---------------- */
function toggleDevice(id, force) {
  const d = deviceById(id);
  if (!d || d.type === 'sensor') return;
  let next = force ?? !isOn(d);
  if (d.type === 'vacuum') {
    return vacuumAction(id, next ? 'start' : 'pause');
  }
  const patch = { on: next };
  if (d.type === 'curtain') {
    patch.position = next ? 100 : 0;
    patch.status = 'stopped';
  }
  commitDevice(id, patch, `${d.name}已${next ? '开启' : '关闭'}`);
}

function vacuumAction(id, cmd) {
  const d = deviceById(id);
  if (!d) return;
  if (cmd === 'start') commitDevice(id, { status: 'cleaning', on: true }, '开始清扫');
  else if (cmd === 'pause') commitDevice(id, { status: 'paused', on: false }, '已暂停');
  else commitDevice(id, { status: 'charging', on: false }, '回充中');
}

function setBrightness(id, value) {
  const d = deviceById(id);
  if (!d) return;
  d.state.brightness = Number(value);
  if (!d.state.on) d.state.on = true;
  const row = $(`.device-row[data-id="${id}"]`);
  if (row) {
    row.classList.remove('off');
    const val = $('.inline-value', row);
    if (val) val.textContent = value + '%';
    const sw = $('.inline-switch', row);
    if (sw) sw.classList.add('on');
  }
  const head = $('.inspector-inner .slider-head b');
  if (state.selected === id && d.type === 'light') {
    const dial = $('.dial-center b');
    if (dial) dial.textContent = value;
    const circle = $('.dial .progress');
    if (circle) circle.setAttribute('stroke-dasharray', `${(462 * value / 100).toFixed(1)} 616`);
    const tempHead = $('.inspector-inner .insp-label b');
    if (tempHead) tempHead.textContent = MODE_LABEL[d.state.mode] || '自定义';
    if (head) head.textContent = d.state.colorTemp + ' K';
  }
}

function runScene(id) {
  const scene = SCENES.find(s => s.id === id);
  if (!scene) return;
  setSyncBusy();
  const targets = Object.keys(scene.apply);
  setTimeout(() => {
    targets.forEach(devId => Object.assign(deviceById(devId).state, scene.apply[devId]));
    scene.last = '刚刚';
    setSyncDone();
    renderCurrent(state.page === 'overview');
    const lanCount = targets.filter(t => deviceById(t).path === 'lan').length;
    toast(`「${scene.name}」已执行`, `${targets.length} 台设备 · ${lanCount} 台本地优先`, 'spark');
    addHudLog(`scene ${scene.id} → ${targets.length} devices`);
  }, 520);
}

function stepTemp(id, delta) {
  const d = deviceById(id);
  if (!d) return;
  const next = clamp(d.state.temp + delta, 16, 30);
  if (next === d.state.temp) return;
  d.state.temp = next;
  d.state.on = true;
  renderCurrent(true);
  const dial = $('.dial-center b');
  if (dial) dial.textContent = next;
}

function roomPower(room, on) {
  const list = DEVICES.filter(d => d.room === room && d.type !== 'sensor' && d.type !== 'vacuum' && d.type !== 'camera');
  list.forEach(d => { d.state.on = on; if (d.type === 'curtain') d.state.position = on ? 100 : 0; });
  renderCurrent(true);
  toast(on ? '已打开该房间' : '已关闭该房间', `${list.length} 台设备`);
}

function allOff() {
  DEVICES.forEach(d => {
    if (d.type === 'sensor' || d.type === 'vacuum' || d.type === 'camera') return;
    d.state.on = false;
    if (d.type === 'curtain') d.state.position = 0;
  });
  renderCurrent(true);
  const count = DEVICES.filter(d => !['sensor', 'vacuum', 'camera'].includes(d.type)).length;
  toast('全部设备已关闭', `${count} 台设备 · 本地优先`, 'power');
}

/* ---------------- 命令面板 ---------------- */
let paletteIndex = 0;
let paletteItems = [];

function paletteSource() {
  const items = [];
  DEVICES.filter(d => d.type !== 'camera').forEach(d => items.push({
    group: '设备', label: d.name, sub: `${roomById(d.room).name} · ${isOn(d) ? '开启' : '关闭'}`,
    icon: d.icon, run: () => openDevice(d.id),
  }));
  CAMERAS.forEach(c => items.push({
    group: '监控', label: c.name, sub: `${roomById(c.room).name} · ${camStateLabel(c)}`,
    icon: 'camera', run: () => openCamera(c.id),
  }));
  SCENES.forEach(s => items.push({
    group: '场景', label: s.name, sub: s.caption, icon: s.icon, run: () => runScene(s.id),
  }));
  items.push(
    { group: '操作', label: '关闭全部设备', sub: '客厅与卧室', icon: 'power', run: allOff },
    { group: '操作', label: '打开全部灯光', sub: '4 台灯具', icon: 'sun', run: () => { DEVICES.filter(d => d.type === 'light').forEach(d => d.state.on = true); renderCurrent(true); toast('已打开全部灯光'); } },
    { group: '操作', label: '切换外观', sub: state.theme === 'light' ? '浅色 → 深色' : '深色 → 浅色', icon: 'moon', run: toggleTheme },
    { group: '操作', label: '性能面板', sub: '⌥P', icon: 'sliders', run: () => toggleHud(true) },
    { group: '操作', label: '刷新全部状态', sub: `重新读取 ${DEVICES.length} 台设备`, icon: 'history', run: refreshAll },
  );
  return items;
}

function renderPalette(query = '') {
  const q = query.trim().toLowerCase();
  const all = paletteSource();
  paletteItems = q ? all.filter(i => (i.label + i.sub + i.group).toLowerCase().includes(q)) : all;
  paletteIndex = 0;
  const groups = {};
  paletteItems.forEach(item => { (groups[item.group] ||= []).push(item); });
  const html = Object.entries(groups).map(([g, items]) => `<div class="palette-group">${g}</div>` +
    items.map(item => {
      const idx = paletteItems.indexOf(item);
      return `<div class="palette-item ${idx === paletteIndex ? 'active' : ''}" data-index="${idx}">${icon(item.icon)}<span>${esc(item.label)}</span><span class="sub">${esc(item.sub)}</span></div>`;
    }).join('')).join('');
  $('#paletteResults').innerHTML = html || '<div class="palette-empty">没有匹配的设备或操作</div>';
  const active = $('.palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  $('#palette').classList.add('open');
  $('#palette').setAttribute('aria-hidden', 'false');
  const input = $('#paletteInput');
  input.value = '';
  renderPalette('');
  setTimeout(() => input.focus(), 30);
}

function closePalette() {
  $('#palette').classList.remove('open');
  $('#palette').setAttribute('aria-hidden', 'true');
}

function paletteMove(delta) {
  if (!paletteItems.length) return;
  paletteIndex = (paletteIndex + delta + paletteItems.length) % paletteItems.length;
  $$('#paletteResults .palette-item').forEach(el => el.classList.toggle('active', Number(el.dataset.index) === paletteIndex));
  const active = $('.palette-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function paletteRun() {
  const item = paletteItems[paletteIndex];
  if (!item) return;
  closePalette();
  setTimeout(() => item.run(), 60);
}

/* ---------------- 检查器拨盘 ---------------- */
function bindDial() {
  const dial = $('.dial');
  if (!dial) return;
  const min = Number(dial.dataset.min), max = Number(dial.dataset.max);
  const svg = $('svg', dial), label = $('.dial-center b', dial);
  let dragging = false;

  const updateFromEvent = e => {
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let ang = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    if (ang < 135) ang += 360;
    ang = clamp(ang, 135, 405);
    const pct = (ang - 135) / 270;
    const value = Math.round((min + pct * (max - min)) / (dial.dataset.step || 1)) * (dial.dataset.step || 1);
    const v = clamp(value, min, max);
    label.textContent = v;
    dial.setAttribute('aria-valuenow', v);
    $('.progress', svg).setAttribute('stroke-dasharray', `${(462 * pct).toFixed(1)} 616`);
    const d = deviceById(state.selected);
    if (d) d.state[d.type === 'ac' ? 'temp' : d.type === 'humidifier' ? 'targetHumidity' : 'brightness'] = v;
    return v;
  };

  dial.addEventListener('pointerdown', e => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    updateFromEvent(e);
  });
  dial.addEventListener('pointermove', e => { if (dragging) updateFromEvent(e); });
  dial.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    dial.releasePointerCapture(e.pointerId);
    const d = deviceById(state.selected);
    if (!d) return;
    const v = Number(label.textContent);
    const patch = d.type === 'ac' ? { temp: v, on: true } : d.type === 'humidifier' ? { targetHumidity: v, on: true } : { brightness: v, on: true };
    commitDevice(d.id, patch, `${d.name}已调整为 ${v}${d.type === 'ac' ? '°C' : '%'}`, 120);
  });
}

/* ---------------- 主题 ---------------- */
function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem('mihome-theme', theme);
  $('#btnTheme').textContent = theme === 'light' ? '◐' : '◑';
  renderCurrent(true);
}

function toggleTheme() {
  applyTheme(state.theme === 'light' ? 'dark' : 'light');
  toast(state.theme === 'light' ? '已切换到浅色外观' : '已切换到深色外观', '', 'moon');
}

/* ---------------- 菜单栏速控 ---------------- */
let lastPopTrigger = null;
function togglePop(force) {
  const pop = $('#menubarPop');
  const open = force ?? !pop.classList.contains('open');
  if (open) {
    renderPop();
    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');
    lastPopTrigger = document.activeElement;
  } else {
    pop.classList.remove('open');
    pop.setAttribute('aria-hidden', 'true');
  }
}

function renderPop() {
  const ids = ['lamp-living', 'ac-living', 'purifier-living', 'vacuum-balcony'];
  $('#popGrid').innerHTML = ids.map(id => {
    const d = deviceById(id);
    return `<div class="pop-device" data-action="open-device" data-id="${d.id}">${icon(d.icon)}<span>${d.name}</span>${switchHTML(d)}</div>`;
  }).join('');
  $('#popScenes').innerHTML = SCENES.slice(0, 3).map(s => `<button data-action="run-scene" data-id="${s.id}">${s.name}</button>`).join('');
  $('#popTime').textContent = nowTime();
}

/* ---------------- 登录 ---------------- */
function drawQR(seed = 7) {
  const c = $('#qrCanvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const size = 440, modules = 37, cell = size / modules;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#171815';
  let s = seed;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const finder = (x, y) => {
    ctx.fillRect(x * cell, y * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#fff'; ctx.fillRect((x + 1) * cell, (y + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#171815'; ctx.fillRect((x + 2) * cell, (y + 2) * cell, 3 * cell, 3 * cell);
  };
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      const inFinder = (x < 7 && y < 7) || (x >= modules - 7 && y < 7) || (x < 7 && y >= modules - 7);
      const inQuiet = x < 1 || y < 1 || x >= modules - 1 || y >= modules - 1;
      if (inFinder || inQuiet) continue;
      if (rand() > 0.53) ctx.fillRect(x * cell, y * cell, cell * 1.02, cell * 1.02);
    }
  }
  ctx.fillStyle = '#171815';
  finder(1, 1); finder(modules - 8, 1); finder(1, modules - 8);
  // 中心留白，放一个中性的房屋轮廓
  const pad = 3.2 * cell;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(size / 2 - pad, size / 2 - pad, pad * 2, pad * 2, 10);
  ctx.fill();
  ctx.strokeStyle = '#c44f2b';
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cx = size / 2, cy = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx - 20, cy - 2);
  ctx.lineTo(cx, cy - 20);
  ctx.lineTo(cx + 20, cy - 2);
  ctx.moveTo(cx - 14, cy - 4);
  ctx.lineTo(cx - 14, cy + 18);
  ctx.lineTo(cx + 14, cy + 18);
  ctx.lineTo(cx + 14, cy - 4);
  ctx.stroke();
}

let qrLeft = 120;
function tickQR() {
  const el = $('#qrTimer');
  if (!el) return;
  qrLeft -= 1;
  if (qrLeft <= 0) { qrLeft = 120; drawQR(Math.floor(Math.random() * 1000)); }
  el.textContent = `${String(Math.floor(qrLeft / 60)).padStart(2, '0')}:${String(qrLeft % 60).padStart(2, '0')}`;
}

function hideLogin() {
  $('#loginLayer').classList.add('hide');
  setTimeout(() => { $('#loginLayer').style.display = 'none'; }, 500);
  setTimeout(() => toast('已进入演示家庭', `${DEVICES.length} 台设备 · ${DEVICES.filter(d => d.path === 'lan').length} 台本地直连`), 300);
}

/* ---------------- 性能 HUD ---------------- */
const hud = { on: false, frames: [], last: 0, logs: [] };
function toggleHud(force) {
  hud.on = force ?? !hud.on;
  $('#hud').classList.toggle('show', hud.on);
  $('#hud').setAttribute('aria-hidden', String(!hud.on));
  if (hud.on) { hud.last = 0; requestAnimationFrame(hudLoop); }
}

function updateHud() {
  if (!$('#hud').classList.contains('show')) return;
  const heap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + ' MB' : '—';
  $('#hudHeap').textContent = heap;
  $('#hudInflight').textContent = state.inflight;
  $('#hudRtt').textContent = (118 + Math.round(Math.random() * 30)) + ' ms';
  $('#hudCache').textContent = state.cacheHit + '%';
}

function addHudLog(line) {
  hud.logs.unshift(`${nowTime()} ${line}`);
  hud.logs = hud.logs.slice(0, 3);
  const el = $('#hudLog');
  if (el) el.innerHTML = hud.logs.map(l => `<div>${esc(l)}</div>`).join('');
}

function hudLoop(ts) {
  if (!hud.on) return;
  if (hud.last) {
    const dt = ts - hud.last;
    const fps = Math.min(120, 1000 / dt);
    hud.frames.push(fps);
    if (hud.frames.length > 60) hud.frames.shift();
    $('#hudFps').textContent = Math.round(fps);
    drawHudGraph();
  }
  hud.last = ts;
  requestAnimationFrame(hudLoop);
}

function drawHudGraph() {
  const c = $('#hudGraph');
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(143,208,172,.9)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  hud.frames.forEach((v, i) => {
    const x = (i / 60) * c.width;
    const y = c.height - (v / 120) * (c.height - 4) - 2;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/* ---------------- 事件 ---------------- */
document.addEventListener('click', e => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) {
    if (!e.target.closest('#menubarPop') && !e.target.closest('#btnMenuBar') && !e.target.closest('#btnMenuBar2')) togglePop(false);
    return;
  }
  const action = actionEl.dataset.action;
  const id = actionEl.dataset.id;

  // 设置页的分段控件与色板
  if (e.target.dataset.themeSet) {
    applyTheme(e.target.dataset.themeSet);
    return;
  }
  if (e.target.dataset.densitySet) {
    state.density = e.target.dataset.densitySet;
    document.body.dataset.density = state.density;
    localStorage.setItem('mihome-density', state.density);
    renderCurrent(true);
    toast(state.density === 'compact' ? '已切换为紧凑列表' : '已切换为宽松列表');
    return;
  }
  if (e.target.dataset.accent) {
    const c = e.target.dataset.accent;
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent-ink', c);
    document.documentElement.style.setProperty('--accent-soft', c + '1f');
    $$('.swatch').forEach(b => b.classList.toggle('active', b === e.target));
    toast('强调色已更新');
    return;
  }
  if (e.target.dataset.poll) {
    state.polling = Number(e.target.dataset.poll);
    renderCurrent(true);
    toast(`云端刷新间隔 ${state.polling / 1000} 秒`);
    return;
  }

  switch (action) {
    case 'open-device':
      openDevice(id);
      break;
    case 'open-camera':
      e.stopPropagation();
      openCamera(id);
      break;
    case 'camera-page':
      navigate('camera');
      break;
    case 'select-camera':
      state.camera = id;
      state.cameraMode = 'live';
      state.cameraEvent = null;
      state.cameraPaused = false;
      state.cameraGrid = false;
      renderCurrent();
      addHudLog(`camera select ${id}`);
      break;
    case 'camera-grid':
      state.cameraGrid = !state.cameraGrid;
      state.cameraPaused = false;
      renderCurrent(true);
      break;
    case 'cam-quality': {
      const q = e.target.dataset.quality;
      if (!q) break;
      const c = deviceById(state.camera);
      c.state.quality = q;
      renderCurrent(true);
      toast(`画质已切到${{ auto: '自动', hd: '高清', sd: '流畅' }[q]}`, `${c.name} · ${camBitrate(c)} Mbps`);
      break;
    }
    case 'cam-play':
      state.cameraPaused = !state.cameraPaused;
      renderCurrent(true);
      toast(state.cameraPaused ? '画面已暂停' : '继续播放', '', state.cameraPaused ? 'pause' : 'play');
      break;
    case 'cam-sound': {
      const c = deviceById(state.camera);
      c.state.sound = !c.state.sound;
      renderCurrent(true);
      toast(c.state.sound ? '双向语音已开启' : '双向语音已关闭', c.state.sound ? '按住说话，松开发送' : '', 'volume');
      break;
    }
    case 'cam-record': {
      const c = deviceById(state.camera);
      c.state.recording = !c.state.recording;
      renderCurrent(true);
      toast(c.state.recording ? '已开始录制' : '录制已停止', c.name, 'record');
      break;
    }
    case 'cam-privacy': {
      const c = deviceById(state.camera);
      c.state.privacy = !c.state.privacy;
      renderCurrent(true);
      toast(c.state.privacy ? '已开启隐私遮蔽' : '已解除隐私遮蔽', c.state.privacy ? '镜头转向底座，画面不会离开设备' : c.name, 'shield');
      break;
    }
    case 'cam-snapshot': {
      const flash = $('#camFlash');
      if (flash) { flash.classList.add('fire'); setTimeout(() => flash.classList.remove('fire'), 240); }
      const c = deviceById(state.camera);
      toast('截图已保存', `${c.name} · 桌面/MiHome 截图`, 'camera');
      addHudLog(`snapshot ${c.id}`);
      break;
    }
    case 'cam-full': {
      const frame = $('#cameraFrame');
      if (!frame) break;
      frame.classList.toggle('theater');
      toast(frame.classList.contains('theater') ? '已进入全屏' : '已退出全屏', '按 Esc 也可退出', 'expand');
      break;
    }
    case 'cam-ptz': {
      const dir = actionEl.dataset.dir;
      const frame = $('#cameraFrame');
      if (frame && dir !== 'center') {
        frame.classList.add(`ptz-${dir}`);
        setTimeout(() => frame.classList.remove(`ptz-${dir}`), 420);
      }
      const label = { up: '上抬', down: '下压', left: '左转', right: '右转', center: '回到中间' }[dir];
      toast(`云台${label}`, deviceById(state.camera).name);
      break;
    }
    case 'cam-event': {
      const c = deviceById(state.camera);
      const event = c.camera.events.find(x => x.time === actionEl.dataset.time);
      if (!event) break;
      state.cameraMode = 'replay';
      state.cameraEvent = event;
      state.cameraPaused = false;
      renderCurrent(true);
      toast(`回放 ${event.time}`, event.label, 'history');
      addHudLog(`replay ${c.id} ${event.time}`);
      break;
    }
    case 'cam-mode':
      state.cameraMode = state.cameraMode === 'live' ? 'replay' : 'live';
      state.cameraEvent = state.cameraMode === 'replay' ? (state.cameraEvent || deviceById(state.camera).camera.events[0]) : null;
      state.cameraPaused = false;
      renderCurrent(true);
      toast(state.cameraMode === 'replay' ? '进入回放' : '回到实时画面', '', state.cameraMode === 'replay' ? 'history' : 'play');
      break;
    case 'cam-events':
      $('.camera-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    case 'toggle-device':
      e.stopPropagation();
      toggleDevice(id);
      break;
    case 'step-temp':
      e.stopPropagation();
      stepTemp(id, Number(actionEl.dataset.delta));
      break;
    case 'brightness-preset': {
      const d = deviceById(id);
      d.state.on = true; d.state.brightness = Number(actionEl.dataset.value);
      commitDevice(id, { on: true, brightness: Number(actionEl.dataset.value) }, `${d.name}亮度 ${actionEl.dataset.value}%`, 100);
      break;
    }
    case 'light-mode': {
      const d = deviceById(id);
      const mode = actionEl.dataset.mode;
      const preset = { sleep: [12, 2700], read: [78, 4200], work: [92, 5000], normal: [100, 5000] }[mode];
      commitDevice(id, { on: true, mode, brightness: preset[0], colorTemp: preset[1] }, `${d.name} · ${MODE_LABEL[mode]}`);
      break;
    }
    case 'ac-mode': {
      const d = deviceById(id);
      commitDevice(id, { mode: actionEl.dataset.mode, on: true }, `${d.name} · ${MODE_LABEL[actionEl.dataset.mode]}`);
      break;
    }
    case 'ac-fan':
      commitDevice(id, { fan: Number(actionEl.dataset.fan), on: true }, `${deviceById(id).name}风速 ${FAN_LABEL[actionEl.dataset.fan]}`);
      break;
    case 'ac-swing':
      commitDevice(id, { swing: !deviceById(id).state.swing }, '扫风已切换');
      break;
    case 'purifier-mode':
      commitDevice(id, { mode: actionEl.dataset.mode, on: true }, `${deviceById(id).name} · ${MODE_LABEL[actionEl.dataset.mode]}`);
      break;
    case 'curtain':
      commitDevice(id, { position: Number(actionEl.dataset.pos), on: Number(actionEl.dataset.pos) > 0 }, Number(actionEl.dataset.pos) ? '窗帘已打开' : '窗帘已关闭', 400);
      break;
    case 'vacuum':
      e.stopPropagation();
      vacuumAction(id, deviceById(id).state.status === 'cleaning' ? 'pause' : 'start');
      break;
    case 'vacuum-dock':
      vacuumAction(id, 'dock');
      break;
    case 'run-scene':
      e.stopPropagation();
      runScene(id);
      break;
    case 'select-room':
      state.room = state.room === actionEl.dataset.room ? 'all' : actionEl.dataset.room;
      state.page = 'overview';
      state.selected = null;
      renderCurrent();
      break;
    case 'room-power':
      roomPower(actionEl.dataset.room, actionEl.dataset.on === '1');
      break;
    case 'all-off':
      allOff();
      break;
    case 'close-inspector':
      closeInspector();
      break;
    case 'toggle-auto': {
      const a = SCHEDULES.find(x => x.id === id);
      a.enabled = !a.enabled;
      renderCurrent(true);
      toast(`自动化已${a.enabled ? '启用' : '暂停'}`, a.name);
      break;
    }
    case 'new-scene':
    case 'new-automation':
      toast('原型中未实现创建流程', '正式版会复用米家场景接口', 'spark');
      break;
    case 'refresh':
      refreshAll();
      break;
    case 'filter':
      state.deviceFilter = actionEl.dataset.filter;
      renderCurrent();
      break;
    case 'toggle':
      break;
    case 'setting-toggle': {
      const key = actionEl.dataset.key;
      state[key] = !state[key];
      renderCurrent(true);
      toast(`${key === 'localFirst' ? '局域网直连优先' : key === 'mdns' ? '自动发现' : '菜单栏图标'}已${state[key] ? '开启' : '关闭'}`);
      break;
    }
    case 'sign-out':
      $('#loginLayer').style.display = 'grid';
      requestAnimationFrame(() => $('#loginLayer').classList.remove('hide'));
      closePalette();
      break;
    case 'clear-cache':
      toast('缓存已清除', '18.4 MB');
      break;
    case 'export-log':
      toast('诊断日志已导出到下载目录', 'mihome-diag-1029.log');
      break;
    case 'theme':
      break;
  }
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  if (action === 'brightness') setBrightness(id, el.value);
  if (action === 'color-temp') {
    const d = deviceById(id);
    d.state.colorTemp = Number(el.value);
    const head = $('.inspector-inner .slider-head b');
    if (head) head.textContent = el.value + ' K';
    el.style.setProperty('--v', ((el.value - 2700) / 3800) * 100 + '%');
    commitDevice(id, { colorTemp: Number(el.value), on: true }, `${d.name}色温 ${el.value}K`, 120);
  }
  if (action === 'curtain-slider') {
    commitDevice(id, { position: Number(el.value), on: Number(el.value) > 0 }, `窗帘开合 ${el.value}%`, 380);
  }
});

document.addEventListener('input', e => {
  const search = e.target.closest('[data-action="device-search"]');
  if (search) {
    state.deviceQuery = search.value;
    renderCurrent();
    const input = $('#deviceSearch');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    return;
  }
  const el = e.target.closest('input[type="range"]');
  if (!el) return;
  if (el.dataset.action === 'brightness') {
    el.style.setProperty('--v', el.value + '%');
    setBrightness(el.dataset.id, el.value);
  }
  if (el.dataset.action === 'color-temp') {
    el.style.setProperty('--v', ((el.value - 2700) / 3800) * 100 + '%');
    const head = $('.inspector-inner .slider-head b');
    if (head) head.textContent = el.value + ' K';
  }
  if (el.dataset.action === 'curtain-slider') {
    el.style.setProperty('--v', el.value + '%');
    const head = $('.inspector-inner .slider-head b');
    if (head) head.textContent = el.value + '%';
  }
});

function navigate(page) {
  state.page = page;
  state.room = 'all';
  state.selected = null;
  renderCurrent();
}

$('#mainNav').addEventListener('click', e => {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  navigate(b.dataset.nav);
});
$$('.sidebar-footer [data-nav]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.nav)));

$('#btnPalette').addEventListener('click', openPalette);
$('#paletteInput').addEventListener('input', e => renderPalette(e.target.value));
$('#paletteInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
  if (e.key === 'Enter') { e.preventDefault(); paletteRun(); }
});
$('#paletteResults').addEventListener('click', e => {
  const item = e.target.closest('.palette-item');
  if (!item) return;
  paletteIndex = Number(item.dataset.index);
  paletteRun();
});
$('.palette-backdrop').addEventListener('click', closePalette);

$('#btnTheme').addEventListener('click', toggleTheme);
$('#btnMenuBar').addEventListener('click', e => { e.stopPropagation(); togglePop(); });
$('#btnMenuBar2').addEventListener('click', e => { e.stopPropagation(); togglePop(); });
$('#popOpen').addEventListener('click', () => { togglePop(false); closePalette(); toast('主窗口已就绪'); });
$('#btnHomeSwitch').addEventListener('click', () => toast('当前只有一个家庭', '云栖公寓', 'grid'));
$('#btnAddRoom').addEventListener('click', () => toast('原型中未实现添加房间'));
$('#btnAccount').addEventListener('click', () => navigate('settings'));
$('#btnHud').addEventListener('click', () => toggleHud());
$('#hudClose').addEventListener('click', () => toggleHud(false));

$('#btnClose').addEventListener('click', () => toast('原型窗口不执行关闭', '', 'close'));
$('#btnMin').addEventListener('click', () => {
  $('#appWindow').classList.add('minimized');
  setTimeout(() => {
    $('#appWindow').classList.remove('minimized');
    toast('已从程序坞恢复');
  }, 900);
});
$('#btnZoom').addEventListener('click', () => $('#appWindow').classList.toggle('zoomed'));

$('#btnMockScan').addEventListener('click', () => {
  const btn = $('#btnMockScan');
  btn.textContent = '正在确认…';
  setTimeout(() => { btn.textContent = '模拟扫码成功'; hideLogin(); }, 700);
});
$('#btnSkipLogin').addEventListener('click', hideLogin);
$('#qrRefresh').addEventListener('click', () => { qrLeft = 120; drawQR(Math.floor(Math.random() * 1000)); toast('二维码已刷新'); });

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (mod && e.key === ',') { e.preventDefault(); closePalette(); togglePop(false); navigate('settings'); }
  if (mod && ['1', '2', '3', '4', '5'].includes(e.key)) {
    const page = ['overview', 'camera', 'scenes', 'automations', 'devices'][Number(e.key) - 1];
    e.preventDefault(); closePalette(); closeInspector(); navigate(page);
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); togglePop(); }
  if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); toggleHud(); }
  if (e.key === 'Escape') {
    closePalette(); togglePop(false); toggleHud(false); closeInspector();
    const frame = document.querySelector('#cameraFrame');
    if (frame) frame.classList.remove('theater');
  }
});

function openDevice(id) {
  const d = deviceById(id);
  if (d && d.type === 'camera') return openCamera(id);
  togglePop(false);
  state.selected = id;
  renderInspector();
  addHudLog(`inspect ${id}`);
}

function openCamera(id) {
  const d = deviceById(id);
  if (!d || d.type !== 'camera') return;
  togglePop(false);
  state.camera = id;
  state.cameraMode = 'live';
  state.cameraEvent = null;
  state.cameraPaused = false;
  state.cameraGrid = false;
  state.page = 'camera';
  state.selected = null;
  renderCurrent();
  addHudLog(`camera ${id}`);
}

function closeInspector() {
  state.selected = null;
  renderInspector();
}

function refreshAll() {
  setSyncBusy();
  setTimeout(() => {
    setSyncDone();
    renderCurrent(true);
    toast('状态已刷新', `${DEVICES.length} 台设备 · ${DEVICES.filter(d => d.path === 'lan').length} 台本地`);
    addHudLog('refresh all devices');
  }, 420);
}

/* ---------------- 启动 ---------------- */
function boot() {
  applyStaticIcons();
  if (state.theme === 'dark') $('#btnTheme').textContent = '◑';
  drawQR();
  $('#statusClock').textContent = nowTime();
  setInterval(tickQR, 1000);
  setInterval(() => { $('#statusClock').textContent = nowTime(); }, 10_000);
  setInterval(() => {
    const el = $('#statusSync');
    if (state.inflight) return;
    el.textContent = '刚刚同步';
  }, 15_000);
  renderCurrent();
  setInterval(() => {
    const d = deviceById('sensor-living');
    if (!d) return;
    d.state.temperature = Number((24.5 + Math.random() * 0.3).toFixed(1));
    d.state.humidity = Math.round(57 + Math.random() * 2);
    d.series.shift();
    d.series.push(d.state.temperature);
    if (state.page === 'overview' && !state.selected) {
      const big = $('.hero-reading .big');
      if (big) big.textContent = d.state.temperature;
      const sub = $('.hero-sub b');
      if (sub) sub.textContent = `湿度 ${d.state.humidity}%`;
    }
  }, 30_000);
  updateChrome();
}

boot();
