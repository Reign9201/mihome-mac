const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { profileFromSpec, summarizeCardMetrics } = require('../ui/capabilities.js');

const spec = {
  services: [
    {
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:1',
      description: 'Light',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:1',
          format: 'bool',
          access: ['read', 'write'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:brightness:1',
          format: 'uint8',
          access: ['read', 'write'],
          unit: 'percentage',
          value_range: { min: 1, max: 100, step: 1 },
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:1',
          format: 'uint8',
          access: ['write'],
          value_list: [{ value: 0, description: 'Reading' }],
        },
      ],
      actions: [
        { iid: 1, type: 'urn:miot-spec-v2:action:toggle:1', inputs: [] },
        { iid: 2, type: 'urn:miot-spec-v2:action:set-level:1', inputs: [{ piid: 2 }] },
      ],
    },
    {
      iid: 3,
      type: 'urn:miot-spec-v2:service:battery:1',
      properties: [{
        iid: 1,
        type: 'urn:miot-spec-v2:property:battery-level:1',
        format: 'uint8',
        access: ['read', 'notify'],
        unit: 'percentage',
      }],
    },
  ],
};

test('maps MIoT properties to typed controls', () => {
  const profile = profileFromSpec(spec);
  assert.deepEqual(profile.controls.map((item) => item.type), ['toggle', 'range', 'segments']);
  assert.equal(profile.controls[0].label, '开关');
  assert.equal(profile.controls[1].suffix, '%');
  assert.equal(profile.actions.length, 1);
  assert.equal(profile.metrics.find((item) => item.label === '电量').secondary, true);
});

test('does not invent controls for a missing spec', () => {
  const profile = profileFromSpec({ services: [] });
  assert.equal(profile.controls.length, 0);
  assert.match(profile.note, /没有可用/);
});

test('accepts the hyphenated fields returned by miot-spec.org', () => {
  const profile = profileFromSpec({
    services: [{
      iid: 2,
      type: 'urn:miot-spec-v2:service:light:1',
      description: 'Light',
      properties: [
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:brightness:1',
          format: 'uint8',
          access: ['read', 'write'],
          unit: 'percentage',
          'value-range': [1, 100, 1],
        },
        {
          iid: 3,
          type: 'urn:miot-spec-v2:property:mode:1',
          format: 'uint8',
          access: ['write'],
          'value-list': [{ value: 0, description: 'Reading' }],
        },
      ],
    }],
  });
  assert.deepEqual(profile.controls.map((item) => item.type), ['range', 'segments']);
  assert.equal(profile.controls[0].min, 1);
  assert.equal(profile.controls[0].max, 100);
  assert.deepEqual(profile.controls[1].options, [[0, '阅读']]);
});

test('does not label every switch-status property as a camera switch', () => {
  const profile = profileFromSpec({
    services: [{
      iid: 2,
      type: 'urn:miot-spec-v2:service:switch:1',
      description: 'Switch',
      properties: [{
        iid: 1,
        type: 'urn:miot-spec-v2:property:switch-status:1',
        description: 'Switch Status',
        format: 'bool',
        access: ['read', 'write'],
      }],
    }],
  });
  assert.equal(profile.controls[0].label, '开关状态');
});

test('localizes Xiaomi camera settings and units', () => {
  const profile = profileFromSpec({
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:camera-control:0000782F:chuangmi-069a01:1',
        description: 'Camera Control',
        properties: [
          {
            iid: 1,
            type: 'urn:miot-spec-v2:property:on:00000006:chuangmi-069a01:1',
            description: 'Switch Status',
            format: 'bool',
            access: ['read', 'write'],
          },
          {
            iid: 2,
            type: 'urn:miot-spec-v2:property:image-rollover:00000058:chuangmi-069a01:1',
            description: 'Image Rollover',
            format: 'int32',
            access: ['read', 'write'],
            unit: 'arcdegrees',
            'value-range': [0, 180, 1],
          },
          {
            iid: 3,
            type: 'urn:miot-spec-v2:property:night-shot:00000057:chuangmi-069a01:1',
            description: 'Night Shot',
            format: 'uint8',
            access: ['read', 'write'],
            'value-list': [
              { value: 0, description: 'On' },
              { value: 1, description: 'Off' },
              { value: 2, description: 'Auto' },
            ],
          },
          {
            iid: 7,
            type: 'urn:miot-spec-v2:property:recording-mode:0000008B:chuangmi-069a01:1',
            description: 'Recording Mode',
            format: 'uint8',
            access: ['read', 'write'],
            'value-list': [
              { value: 0, description: 'All Record' },
              { value: 1, description: 'Motion Record' },
              { value: 2, description: 'No Record' },
            ],
          },
        ],
      },
      {
        iid: 3,
        type: 'urn:miot-spec-v2:service:indicator-light:00007803:chuangmi-069a01:1',
        description: 'Indicator Light',
        properties: [{
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:00000006:chuangmi-069a01:1',
          description: 'Switch Status',
          format: 'bool',
          access: ['read', 'write'],
        }],
      },
      {
        iid: 5,
        type: 'urn:miot-spec-v2:service:motion-detection:0000784F:chuangmi-069a01:1',
        description: 'Motion Detection',
        properties: [
          {
            iid: 2,
            type: 'urn:miot-spec-v2:property:alarm-interval:0000008F:chuangmi-069a01:1',
            description: 'Alarm Interval',
            format: 'uint16',
            access: ['read', 'write'],
            unit: 'minutes',
            'value-range': [1, 60, 1],
          },
          {
            iid: 3,
            type: 'urn:miot-spec-v2:property:detection-sensitivity:00000090:chuangmi-069a01:1',
            description: 'Detection Sensitivity',
            format: 'uint8',
            access: ['read', 'write'],
            'value-list': [
              { value: 0, description: 'Low' },
              { value: 1, description: 'High' },
            ],
          },
        ],
      },
      {
        iid: 17,
        type: 'urn:miot-spec-v2:service:self-check:000078D7:chuangmi-069a01:3',
        description: 'Self Check',
        properties: [{
          iid: 3,
          type: 'urn:miot-spec-v2:property:manual-check-results:000002A3:chuangmi-069a01:3',
          description: 'Manual Check Results',
          format: 'uint8',
          access: ['read', 'write'],
          'value-list': [
            { value: 0, description: 'Normal' },
            { value: 1, description: 'Abnormal' },
          ],
        }],
      },
      {
        iid: 16,
        type: 'urn:chuangmi-spec:service:sd-status:00007802:chuangmi-069a01:1',
        description: 'sd-status',
        properties: [{
          iid: 2,
          type: 'urn:chuangmi-spec:property:record-duration:00000002:chuangmi-069a01:2',
          description: '',
          format: 'uint16',
          access: ['read', 'write'],
          unit: 'minutes',
          'value-range': [0, 60, 1],
        }],
      },
    ],
  });
  const byLabel = Object.fromEntries(profile.controls.map((item) => [item.label, item]));
  assert.equal(byLabel['摄像头开关'].label, '摄像头开关');
  assert.equal(byLabel['指示灯'].label, '指示灯');
  assert.equal(byLabel['画面翻转'].suffix, '°');
  assert.deepEqual(byLabel['夜视模式'].options, [[0, '开启'], [1, '关闭'], [2, '自动']]);
  assert.deepEqual(byLabel['录像模式'].options, [
    [0, '全部录像'], [1, '移动侦测录像'], [2, '不录像'],
  ]);
  assert.equal(byLabel['报警间隔'].suffix, '分钟');
  assert.deepEqual(byLabel['侦测灵敏度'].options, [[0, '低'], [1, '高']]);
  assert.deepEqual(byLabel['手动检测结果'].options, [[0, '正常'], [1, '异常']]);
  assert.equal(byLabel['录像时长'].suffix, '分钟');
  const visibleText = profile.controls
    .flatMap((item) => [item.label, item.group, ...(item.options || []).map((option) => option[1])])
    .join(' ');
  assert.equal(/[A-Za-z]{2,}/.test(visibleText), false);
});

test('distinguishes camera and indicator switches and localizes baby alarms', () => {
  const profile = profileFromSpec({
    services: [
      {
        iid: 2,
        type: 'urn:miot-spec-v2:service:camera-control:0000782F:chuangmi-039a01:1',
        description: 'Camera Control',
        properties: [{
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:00000006:chuangmi-039a01:1',
          description: 'Switch Status',
          format: 'bool',
          access: ['read', 'write'],
        }],
      },
      {
        iid: 3,
        type: 'urn:miot-spec-v2:service:indicator-light:00007803:chuangmi-039a01:1',
        description: 'Indicator Light',
        properties: [{
          iid: 1,
          type: 'urn:miot-spec-v2:property:on:00000006:chuangmi-039a01:1',
          description: 'Switch Status',
          format: 'bool',
          access: ['read', 'write'],
        }],
      },
      {
        iid: 7,
        type: 'urn:chuangmi-spec:service:imi-alarm:00007801:chuangmi-039a01:1',
        description: 'imi-alarm',
        properties: [
          {
            iid: 3,
            type: 'urn:chuangmi-spec:property:baby-wake-switch:00000003:chuangmi-039a01:2',
            description: '',
            format: 'bool',
            access: ['read', 'write'],
          },
          {
            iid: 5,
            type: 'urn:chuangmi-spec:property:babycry-switch:00000005:chuangmi-039a01:2',
            description: '',
            format: 'bool',
            access: ['read', 'write'],
          },
        ],
      },
    ],
  });
  const labels = profile.controls.map((item) => item.label);
  assert.deepEqual(labels, ['摄像头开关', '指示灯', '宝宝起床提醒', '宝宝哭声提醒']);
});

test('device cards show only concise localized metrics', () => {
  const profile = {
    metrics: [
      { siid: 2, piid: 1, label: 'MAC 地址', suffix: 'mac', digits: 0 },
      { siid: 2, piid: 2, label: '模式', suffix: 'mode', digits: 0,
        options: [[0, '自动']] },
      { siid: 2, piid: 3, label: '湿度', suffix: 'relative-humidity', unit: '%', digits: 0 },
      { siid: 2, piid: 4, label: '温度', suffix: 'temperature', unit: '°C', digits: 1 },
      { siid: 2, piid: 5, label: '存储总容量', suffix: 'storage-total-space', unit: 'KB', digits: 0 },
      { siid: 3, piid: 1, label: '电量', suffix: 'battery-level', unit: '%', digits: 0,
        secondary: true },
    ],
  };
  const values = new Map([
    ['2:1', '84:46:93:73:82:19'],
    ['2:2', 0],
    ['2:3', 43],
    ['2:4', 23.2],
    ['2:5', 61729280],
    ['3:1', 100],
  ]);
  const summary = summarizeCardMetrics(profile, (def) => values.get(`${def.siid}:${def.piid}`));
  assert.equal(summary, '温度 23.2°C · 湿度 43%');
});

test('device card summary uses a localized state when no numeric metric exists', () => {
  const profile = {
    metrics: [
      { siid: 2, piid: 1, label: '状态', suffix: 'status', digits: 0,
        options: [[0, '正常'], [1, '异常']] },
      { siid: 2, piid: 2, label: '原始值', suffix: 'raw', digits: 0 },
    ],
  };
  const values = new Map([['2:1', 0], ['2:2', '30;30;7,1,2,3']]);
  const summary = summarizeCardMetrics(profile, (def) => values.get(`${def.siid}:${def.piid}`));
  assert.equal(summary, '状态 正常');
});

test('device card summary omits value-list entries that only expose a number', () => {
  const profile = {
    metrics: [
      { siid: 2, piid: 1, label: '状态', suffix: 'status', options: [[0, '0']] },
      { siid: 2, piid: 2, label: '温度', suffix: 'temperature', unit: '°C', digits: 1 },
    ],
  };
  const values = new Map([['2:1', 0], ['2:2', 23.2]]);
  const summary = summarizeCardMetrics(profile, (def) => values.get(`${def.siid}:${def.piid}`));
  assert.equal(summary, '温度 23.2°C');
});

test('ignores unnamed vendor properties while retaining known lock state', () => {
  const profile = profileFromSpec({
    services: [{
      iid: 2,
      type: 'urn:miot-spec-v2:service:door-lock:00007808:loock-t3pul:2',
      description: 'Door Lock',
      properties: [
        {
          iid: 1,
          type: 'urn:chuangmi-spec:property:vendor-raw:00000001:loock-t3pul:2',
          description: '',
          format: 'uint32',
          access: ['read'],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:door-state:00000012:loock-t3pul:2',
          description: '',
          format: 'uint8',
          access: ['read'],
          'value-list': [{ value: 16, description: '16' }],
        },
      ],
    }],
  });
  assert.deepEqual(profile.metrics.map((item) => item.label), ['门状态']);
  assert.deepEqual(profile.controls, []);
});

test('keeps infrared air-conditioner controls readable', () => {
  const profile = profileFromSpec({
    services: [{
      iid: 2,
      type: 'urn:miot-spec-v2:service:ir-aircondition-control:00007824:miir-ir02:1',
      description: 'IR Aircondition Control',
      properties: [
        {
          iid: 1,
          type: 'urn:miot-spec-v2:property:ir-mode:0000004C:miir-ir02:1',
          description: 'Mode for IR',
          format: 'uint8',
          access: ['write'],
          'value-list': [
            { value: 0, description: 'Auto' },
            { value: 1, description: 'Cool' },
            { value: 2, description: 'Heat' },
          ],
        },
        {
          iid: 2,
          type: 'urn:miot-spec-v2:property:ir-temperature:0000004D:miir-ir02:1',
          description: 'Temperature for IR',
          format: 'float',
          access: ['write'],
          'value-range': { min: 16, max: 30, step: 1 },
        },
      ],
    }],
  });
  assert.deepEqual(profile.controls.map((item) => item.label), ['空调模式', '空调温度']);
  assert.deepEqual(profile.controls[0].options, [[0, '自动'], [1, '制冷'], [2, '制热']]);
  assert.equal(profile.controls[1].suffix, '°C');
});

test('global UI lock disables selection and copying', () => {
  const root = path.resolve(__dirname, '..');
  const css = fs.readFileSync(path.join(root, 'ui/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(css, /user-select:none/);
  assert.match(css, /-webkit-user-drag:none/);
  assert.match(css, /::selection\{background:transparent/);
  assert.match(js, /'copy', 'cut', 'dragstart'/);
  assert.match(js, /'selectstart'/);
  assert.match(js, /'contextmenu'/);
  assert.match(js, /camera_diagnostics/);
  assert.match(js, /MiCameraPlayer/);
  assert.match(js, /云台控制/);
  assert.match(js, /摄像头设置/);
});

test('ships an independent frontend-to-backend diagnostic log', () => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  const diagnostics = fs.readFileSync(path.join(root, 'ui/diagnostics.js'), 'utf8');
  const player = fs.readFileSync(path.join(root, 'ui/camera-player.js'), 'utf8');
  assert.match(html, /src="diagnostics\.js"/);
  assert.match(html, /src="camera-player\.js"/);
  assert.ok(html.indexOf('diagnostics.js') < html.indexOf('app.js'));
  assert.ok(html.indexOf('camera-player.js') < html.indexOf('app.js'));
  assert.match(html, /id="exportLog"/);
  assert.match(diagnostics, /log_frontend/);
  assert.match(diagnostics, /unhandledrejection/);
  assert.match(diagnostics, /root\.MiLog/);
  assert.match(player, /RTCPeerConnection/);
  assert.match(player, /addSourceBuffer/);
  assert.match(app, /invoke\('log_export'\)/);
});

test('player falls back once when WebRTC is unavailable and keeps MSE low-latency', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/camera-player.js'), 'utf8');

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }

    emit(name) {
      this.listeners.get(name)?.({ data: '' });
    }

    send() {}
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }

  class FakePeerConnection {
    constructor() {
      this.connectionState = 'new';
      this.listeners = new Map();
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    addTransceiver() {}
    getReceivers() { return []; }
    close() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription() {}
  }

  const video = {
    videoWidth: 0,
    currentTime: 0,
    playbackRate: 1,
    pause() {},
    play() { return Promise.resolve(); },
    load() {},
    removeAttribute() {},
    addEventListener() {},
  };
  const modes = [];
  const errors = [];
  const sandbox = {
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  sandbox.MiCameraPlayer.play(
    video,
    { url: 'http://127.0.0.1/hls', webrtc_url: 'ws://127.0.0.1/api/ws' },
    {
      onMode: (mode) => modes.push(mode),
      onError: (mode) => errors.push(mode),
    },
  );

  const signaling = FakeWebSocket.instances[0];
  signaling.emit('error');
  signaling.emit('close');
  assert.deepEqual(modes, ['hls']);
  assert.deepEqual(errors, ['webrtc']);
  assert.match(source, /stream\.prefer_mse/);
  assert.match(source, /\['mse', 'webrtc', 'hls'\]/);
  assert.match(source, /jitterBufferTarget = 0/);
  assert.match(source, /webrtc disconnected/);
  assert.match(source, /mse websocket closed/);
  assert.match(source, /advance\(\);\n    return cleanup;/);
});

test('remote grids render each camera as soon as its stream is ready', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(source, /const starts = usable\.map\(async \(camera\) =>/);
  assert.match(source, /readyCount \+= 1/);
  assert.match(source, /target\.status\.hidden = true/);
  assert.match(source, /await Promise\.all\(starts\)/);
  assert.doesNotMatch(source, /const settled = await Promise\.allSettled\(usable\.map/);
});

test('local player prefers MSE and receives go2rtc media without ICE', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/camera-player.js'), 'utf8');

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; }
    emit(name, data = '') { this.listeners.get(name)?.({ data }); }
  }

  class FakeSourceBuffer {
    constructor() {
      this.updating = false;
      this.listeners = new Map();
      this.buffered = {
        length: 1,
        start: () => 0,
        end: () => 1,
      };
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    appendBuffer() {}
    remove() {}
  }

  class FakeMediaSource {
    static instances = [];

    static isTypeSupported() { return true; }

    constructor() {
      this.readyState = 'open';
      this.listeners = new Map();
      FakeMediaSource.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    addSourceBuffer() { return new FakeSourceBuffer(); }
    setLiveSeekableRange() {}
    emit(name) { this.listeners.get(name)?.(); }
  }

  const video = {
    videoWidth: 0,
    currentTime: 0,
    playbackRate: 1,
    pause() {},
    play() { return Promise.resolve(); },
    load() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const modes = [];
  const errors = [];
  const sandbox = {
    WebSocket: FakeWebSocket,
    ManagedMediaSource: FakeMediaSource,
    MediaSource: FakeMediaSource,
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL() {},
    },
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const cleanup = sandbox.MiCameraPlayer.play(
    video,
    {
      url: 'http://127.0.0.1/hls',
      webrtc_url: 'ws://127.0.0.1/api/ws',
      prefer_mse: true,
    },
    {
      onMode: (mode) => modes.push(mode),
      onError: (mode) => errors.push(mode),
    },
  );

  const signaling = FakeWebSocket.instances[0];
  const mediaSource = FakeMediaSource.instances[0];
  mediaSource.emit('sourceopen');
  signaling.emit('open');
  signaling.emit('message', JSON.stringify({
    type: 'mse',
    value: 'video/mp4; codecs="hvc1.1.6.L153.B0"',
  }));
  signaling.emit('message', new Uint8Array([0, 1, 2, 3]).buffer);

  assert.deepEqual(modes, ['mse']);
  assert.deepEqual(errors, []);
  assert.ok(video.srcObject instanceof FakeMediaSource);
  assert.ok(signaling.sent.some((data) => data.includes('"type":"mse"')));
  cleanup();
});

test('loads a narrow Tauri bridge instead of the global API', () => {
  const root = path.resolve(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'ui/tauri-bridge.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  assert.equal(app.includes('window.__TAURI__'), false);
  assert.match(app, /window\.__MIHOME_TAURI__\?\.invoke/);
  assert.match(bridge, /@tauri-apps\/api\/core/);
  assert.match(html, /src="tauri-api\.js"/);
});

test('chunks device-spec requests to the backend limit', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../ui/app.js'), 'utf8');
  assert.match(app, /const SPEC_BATCH_SIZE = 128;/);
  assert.match(app, /missing\.slice\(offset, offset \+ SPEC_BATCH_SIZE\)/);
});

test('bundle keeps a strict CSP and ships license notices', () => {
  const config = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', 'src-tauri/tauri.conf.json'),
    'utf8',
  ));
  assert.match(config.app.security.csp, /default-src 'self'/);
  assert.match(config.app.security.csp, /script-src 'self'/);
  assert.match(config.app.security.csp, /ws:\/\/127\.0\.0\.1:\*/);
  assert.equal(config.app.security.csp.includes("'unsafe-inline'"), false);
  assert.equal(config.app.withGlobalTauri, false);
  assert.equal(config.bundle.macOS.minimumSystemVersion, '13.0');
  assert.equal(config.bundle.resources['../../LICENSE'], 'LICENSE');
  assert.equal(
    config.bundle.resources['../../THIRD_PARTY_NOTICES.md'],
    'THIRD_PARTY_NOTICES.md',
  );
  assert.deepEqual(config.bundle.externalBin, ['../../helpers/go2rtc/go2rtc']);
});

test('release bundle strips symbols without requiring cargo-binutils', () => {
  const root = path.resolve(__dirname, '..');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const build = fs.readFileSync(path.resolve(root, '../scripts/build-macos.sh'), 'utf8');
  const config = JSON.parse(fs.readFileSync(
    path.join(root, 'src-tauri/tauri.conf.json'),
    'utf8',
  ));
  assert.match(cargo, /tauri = \{ version = "2", default-features = false, features = \["wry"\] \}/);
  assert.match(cargo, /^lto = true$/m);
  assert.match(cargo, /^codegen-units = 1$/m);
  assert.match(cargo, /^strip = false$/m);
  assert.match(cargo, /^panic = "abort"$/m);
  assert.equal(config.build.beforeBundleCommand, 'bash ../scripts/strip-macos-binary.sh');
  assert.match(build, /DMG_FORMAT=\$\{DMG_FORMAT:-ULMO\}/);
  assert.equal(
    fs.existsSync(path.resolve(root, '../scripts/strip-macos-binary.sh')),
    true,
  );
});
