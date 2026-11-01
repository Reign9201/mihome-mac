const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  profileFromSpec,
  summarizeCardMetrics,
  formatArrayValue,
} = require('../ui/capabilities.js');

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

test('array values hide status codes and localize readable labels', () => {
  assert.equal(formatArrayValue([0, 'Untested']), '未检测');
  assert.equal(formatArrayValue([0, 1, 2]), '—');
  assert.equal(formatArrayValue(['normal', 'Ptz Check']), '正常、云台检测');
});

test('unknown vendor option text never falls back to English or raw values', () => {
  const { optionLabel, localizedUnitValue } = require('../ui/capabilities.js');
  assert.equal(optionLabel({ value: 9, description: 'Vendor Private Mode' }), '未知选项');
  assert.equal(optionLabel({ value: 9, description: '' }), '未知选项');
  assert.equal(optionLabel({ value: 180, description: '180arcdegrees' }), '180°');
  assert.equal(optionLabel({ value: 10, description: '10minutes' }), '10分钟');
  assert.equal(localizedUnitValue('unknown-unit'), '');
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

test('styles keep valid selectors and match the compact device card height', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../ui/styles.css'), 'utf8');
  assert.doesNotMatch(css, /(^|\n)device-glyph\[data-kind="plug"\]/);
  assert.match(css, /contain-intrinsic-size:auto 97px/);
  assert.match(css, /\.side\{background:rgba\([^}]+;background:color-mix/);
  assert.match(css, /\.room-chip\.active small\{color:rgba\([^}]+;color:color-mix/);
});

test('camera list keeps vendor model identifiers out of the primary label', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(source, /局域网 · \$\{camera\.ip\}/);
  assert.match(source, /copy\.title = camera\.model/);
  assert.doesNotMatch(source, /`\$\{camera\.model\} · \$\{camera\.ip/);
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
    async setLocalDescription(description) { this.localDescription = description; }
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
    RTCPeerConnection: FakePeerConnection,
    MediaStream: class {},
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const cleanup = sandbox.MiCameraPlayer.play(
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
  assert.match(source, /remoteAudioCodecs/);
  assert.match(source, /webrtc disconnected/);
  assert.match(source, /mse websocket closed/);
  assert.match(source, /advance\(\);\n    return cleanup;/);
  assert.match(source, /HLS_STARTUP_TIMEOUT/);
  assert.match(source, /MSE_LIVE_TARGET = 0\.35/);
  assert.match(source, /MSE_LIVE_MAX = 1\.2/);
  assert.match(source, /MSE_LIVE_CHECK_INTERVAL = 250/);
  assert.match(source, /MSE_LIVE_TRIM_INTERVAL = 2000/);
  assert.match(source, /MSE_LIVE_RETAIN_BEHIND = 0\.75/);
  assert.match(source, /const jumpToLive = \(reason, force = false\)/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /sourceBuffer\.remove\(start, keepBefore\)/);
  assert.doesNotMatch(source, /sourceBuffer\.remove\(start, Math\.max\(start, end - MSE_LIVE_TARGET\)\)/);
  assert.match(source, /video\.playbackRate = 1;\n      video\.load\(\)/);
  cleanup();
});

test('remote grids render each camera as soon as its stream is ready', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(source, /const selected = grid \? usable\.slice\(0, MAX_REMOTE_STREAMS\) : usable/);
  assert.match(source, /const starts = runLimited\(selected, MAX_REMOTE_START_CONCURRENCY, async \(camera\) =>/);
  assert.match(source, /readyCount \+= 1/);
  assert.match(source, /target\.status\.hidden = true/);
  assert.match(source, /await starts/);
  assert.doesNotMatch(source, /const settled = await Promise\.allSettled\(usable\.map/);
});

test('remote reconnect preserves audio and first-frame stalls trigger recovery', () => {
  const app = fs.readFileSync(path.resolve(__dirname, '../ui/app.js'), 'utf8');
  assert.match(app, /state\.remoteAudio\.get\(camera\.did\) === true/);
  assert.match(app, /did: camera\.did, quality: 1, audio: !grid/);
  assert.match(app, /did: camera\.did, quality: 1, audio: !state\.cameraGrid/);
  assert.match(app, /toggling sound never rebuilds video/);
  assert.match(app, /video\.srcObject\?\.getAudioTracks\?\.\(\)/);
  assert.match(app, /function setCameraAudio\(video, enabled, name\)/);
  assert.match(app, /window\.MiCameraPlayer\?\.setAudio\?\.\(video, true\)/);
  assert.match(app, /独立低延迟音轨/);
  assert.match(app, /if \(!video\.paused\) video\.pause\(\);\n  video\.play\(\)/);
  assert.match(app, /setCameraAudio\(video, true, camera\.name\)/);
  assert.match(app, /声音已打开/);
  assert.match(app, /画面长时间没有首帧/);
  assert.match(app, /REMOTE_FIRST_FRAME_TIMEOUT = 15000/);
  assert.match(app, /CAMERA_STALL_INTERVALS = 3/);
});

test('WebRTC diagnostics expose negotiated audio codec and playback state', () => {
  const player = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');
  assert.match(player, /remoteAudioCodecs/);
  assert.match(player, /totalSamplesDuration/);
  assert.match(player, /play rejected/);
  assert.match(player, /volumeChangeHandler/);
  assert.match(player, /audio-track-ready/);
  assert.match(player, /audio-unmuted/);
});

test('WebRTC returns to the live edge after suspension or jitter-buffer growth', () => {
  const player = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');
  assert.match(player, /WEBRTC_STATS_INTERVAL = 1000/);
  assert.match(player, /WEBRTC_STALE_BUFFER_MAX = 0\.35/);
  assert.match(player, /WEBRTC_STALE_BUFFER_CHECKS = 2/);
  assert.match(player, /WEBRTC_DECODE_STALL_CHECKS = 3/);
  assert.match(player, /WEBRTC_PACKET_STALL_CHECKS = 3/);
  assert.match(player, /WEBRTC_HARD_STALL_WINDOW = 25000/);
  assert.match(player, /WEBRTC_RESUME_RECONNECT_AFTER = 1000/);
  assert.match(player, /WEBRTC_LIVE_AFTER_PAUSE_MS = 1200/);
  assert.match(player, /jitterBufferAverage/);
  assert.match(player, /packets > lastVideoProgress\.packets/);
  assert.match(player, /frames <= lastVideoProgress\.frames/);
  assert.match(player, /restartWebrtc\('decode-stall'\)/);
  assert.match(player, /restartWebrtc\('jitter-buffer'\)/);
  assert.match(player, /restartWebrtc\('packet-stall'\)/);
  assert.match(player, /requestHardStall\('packet-stall'\)/);
  assert.match(player, /restartWebrtc\('resume-after-pause'\)/);
  assert.match(player, /!root\.document\?\.hidden && staleVideoBuffer/);
  assert.match(player, /visibility-resume/);
  assert.match(player, /focus-resume/);
  assert.match(player, /resume-live/);
  assert.match(player, /restartWebrtc\(`\$\{reason\}-stalled`\)/);
  assert.match(player, /addEventListener\?\.\('blur', onWindowBlur\)/);
  assert.match(player, /codecsSignature/);
  assert.match(player, /codecs: includeCodecs \? codecs : undefined/);
});

test('WebRTC resumes healthy playback without rebuilding and restarts only when stalled', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');

  const runCase = async ({ advances, hidden = false, pauseResume = false, backgroundMs = 1500 }) => {
    let now = 1_000_000;
    let nextTimer = 1;
    const timers = new Map();
    const setTimeoutFake = (callback, delay = 0) => {
      const id = nextTimer++;
      timers.set(id, { at: now + Number(delay || 0), callback });
      return id;
    };
    const clearTimeoutFake = (id) => timers.delete(id);
    const advance = (duration) => {
      const target = now + duration;
      while (true) {
        let nextId = null;
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!next || timer.at < next.at)) {
            nextId = id;
            next = timer;
          }
        }
        if (!next) break;
        timers.delete(nextId);
        now = next.at;
        next.callback();
      }
      now = target;
    };

    class FakeDate extends Date {
      static now() { return now; }
    }

    class FakeWebSocket {
      static OPEN = 1;
      static instances = [];

      constructor() {
        this.readyState = FakeWebSocket.OPEN;
        this.listeners = new Map();
        FakeWebSocket.instances.push(this);
      }

      addEventListener(name, handler) { this.listeners.set(name, handler); }
      emit(name, event = {}) { this.listeners.get(name)?.(event); }
      send() {}
      close() { this.readyState = 3; }
    }

    class FakeMediaStream {
      constructor() { this.tracks = []; }
      addTrack(track) { this.tracks.push(track); }
      removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    }

    class FakePeerConnection {
      static instances = [];

      constructor() {
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.listeners = new Map();
        FakePeerConnection.instances.push(this);
      }

      addEventListener(name, handler) { this.listeners.set(name, handler); }
      emit(name, event = {}) { this.listeners.get(name)?.(event); }
      addTransceiver() {}
      getReceivers() { return []; }
      async getStats() { return new Map(); }
      close() {}
      async createOffer() { return { type: 'offer', sdp: 'offer' }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async setRemoteDescription() {}
    }

    const documentListeners = new Map();
    const windowListeners = new Map();
    const videoListeners = new Map();
    const document = {
      hidden,
      addEventListener(name, handler) { documentListeners.set(name, handler); },
      removeEventListener(name) { documentListeners.delete(name); },
    };
    const video = {
      muted: true,
      volume: 1,
      paused: true,
      videoWidth: 1,
      playbackRate: 1,
      get currentTime() { return advances ? now / 1000 : 0; },
      getVideoPlaybackQuality() {
        return { totalVideoFrames: advances ? Math.floor(now / 33) : 0 };
      },
      pause() { this.paused = true; },
      play() { this.paused = false; return Promise.resolve(); },
      load() {},
      removeAttribute() {},
      addEventListener(name, handler) { videoListeners.set(name, handler); },
      removeEventListener(name) { videoListeners.delete(name); },
    };
    const diagnosticEvents = [];
    const sandbox = {
      WebSocket: FakeWebSocket,
      RTCPeerConnection: FakePeerConnection,
      MediaStream: FakeMediaStream,
      Date: FakeDate,
      document,
      setTimeout: setTimeoutFake,
      clearTimeout: clearTimeoutFake,
      console,
    };
    sandbox.window = sandbox;
    sandbox.addEventListener = (name, handler) => windowListeners.set(name, handler);
    sandbox.removeEventListener = (name) => windowListeners.delete(name);
    vm.runInNewContext(source, sandbox);

    const cleanup = sandbox.MiCameraPlayer.play(
      video,
      { url: 'http://127.0.0.1/hls', webrtc_url: 'ws://127.0.0.1/api/ws', video_only: true },
      { onDiagnostics: (mode, detail) => diagnosticEvents.push({ mode, detail }) },
    );
    const signaling = FakeWebSocket.instances[0];
    signaling.emit('open');
    await Promise.resolve();
    const peer = FakePeerConnection.instances[0];
    peer.emit('track', {
      track: {
        id: 'video-track',
        kind: 'video',
        muted: false,
        enabled: true,
        readyState: 'live',
        addEventListener() {},
        stop() {},
      },
    });
    peer.connectionState = 'connected';
    peer.emit('connectionstatechange');
    videoListeners.get('loadeddata')?.();

    if (pauseResume) {
      video.paused = true;
      videoListeners.get('pause')?.();
      advance(1300);
      video.paused = false;
      videoListeners.get('play')?.();
      advance(50);
      const peersAfterPlay = FakePeerConnection.instances.length;
      const reasons = diagnosticEvents
        .filter((event) => event.mode === 'webrtc')
        .map((event) => (
          event.detail?.reason === 'restart'
            ? `restart:${event.detail.detail}`
            : event.detail?.reason
        ));
      cleanup();
      return { peersAfterPlay, reasons };
    }

    if (hidden) {
      documentListeners.get('visibilitychange')?.();
    } else {
      windowListeners.get('blur')?.();
    }
    advance(backgroundMs);
    windowListeners.get('focus')?.();
    advance(200);
    const peersAfterResume = FakePeerConnection.instances.length;
    advance(1400);
    const peersAfterProbe = FakePeerConnection.instances.length;
    const reasons = diagnosticEvents
      .filter((event) => event.mode === 'webrtc')
      .map((event) => event.detail?.reason);
    cleanup();
    return { peersAfterResume, peersAfterProbe, reasons };
  };

  const healthy = await runCase({ advances: true, backgroundMs: 1000 });
  assert.equal(healthy.peersAfterResume, 1);
  assert.equal(healthy.peersAfterProbe, 1);
  assert.ok(healthy.reasons.includes('resume-live'), JSON.stringify(healthy));

  const stalled = await runCase({ advances: false, backgroundMs: 1000 });
  assert.equal(stalled.peersAfterResume, 1);
  assert.equal(stalled.peersAfterProbe, 2);
  assert.ok(stalled.reasons.includes('resume-stalled'), JSON.stringify(stalled));

  const hidden = await runCase({ advances: false, hidden: true, backgroundMs: 1000 });
  assert.equal(hidden.peersAfterResume, 1);
  assert.equal(hidden.peersAfterProbe, 1);
  assert.equal(hidden.reasons.includes('resume-stalled'), false);

  const rebuilt = await runCase({ advances: true, backgroundMs: 1500 });
  assert.equal(rebuilt.peersAfterResume, 2);
  assert.ok(rebuilt.reasons.includes('restart'), JSON.stringify(rebuilt));

  const paused = await runCase({ advances: true, pauseResume: true });
  assert.equal(paused.peersAfterPlay, 2);
  assert.ok(paused.reasons.includes('restart:resume-after-pause'));
});

test('WebRTC restarts playback when an audio track becomes audible', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    send() {}
    close() {}
  }

  class FakeMediaStream {
    constructor() { this.tracks = []; }
    addTrack(track) { this.tracks.push(track); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  }

  class FakePeerConnection {
    static instances = [];

    constructor() {
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.listeners = new Map();
      FakePeerConnection.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    addTransceiver() {}
    getReceivers() { return []; }
    async getStats() { return new Map(); }
    close() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription() {}
  }

  const video = {
    muted: false,
    volume: 1,
    paused: true,
    pauseCalls: 0,
    playCalls: 0,
    listeners: new Map(),
    videoWidth: 1,
    currentTime: 0,
    playbackRate: 1,
    pause() { this.pauseCalls += 1; this.paused = true; },
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    load() {},
    removeAttribute() {},
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    removeEventListener() {},
  };
  const sandbox = {
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakePeerConnection,
    MediaStream: FakeMediaStream,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  const cleanup = sandbox.MiCameraPlayer.play(
    video,
    { url: 'http://127.0.0.1/hls', webrtc_url: 'ws://127.0.0.1/api/ws' },
    {},
  );

  const track = (kind) => {
    const listeners = new Map();
    return {
      id: `${kind}-track`,
      kind,
      muted: true,
      enabled: true,
      readyState: 'live',
      addEventListener(name, handler) { listeners.set(name, handler); },
      emit(name) { listeners.get(name)?.(); },
      stop() {},
    };
  };
  const peer = FakePeerConnection.instances[0];
  peer.emit('track', { track: track('video') });
  const audio = track('audio');
  peer.emit('track', { track: audio });

  const pauseBeforeAudio = video.pauseCalls;
  const playBeforeAudio = video.playCalls;
  audio.muted = false;
  audio.emit('unmute');

  assert.ok(video.srcObject.getAudioTracks().includes(audio));
  assert.equal(video.pauseCalls, pauseBeforeAudio + 1);
  assert.equal(video.playCalls, playBeforeAudio + 1);
  cleanup();
});

test('WebRTC removes muted audio from the media element to protect low latency', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');
  assert.match(source, /track\.kind === 'audio' && video\.muted/);
  assert.match(source, /media\.removeTrack\(track\)/);
  assert.match(source, /audio-muted/);
});

test('WebRTC reports continuous jitter and freeze diagnostics', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');
  assert.match(source, /jitterBufferDelay: report\.jitterBufferDelay/);
  assert.match(source, /reportMedia\('periodic'\)/);
  assert.match(source, /scheduleMediaStats\(\);/);
});

test('remote audio uses a separate PeerConnection and reports RTP health', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    send() {}
    close() { this.readyState = 3; }
  }

  class FakeMediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  }

  class FakeAudio {
    static instances = [];

    constructor() {
      this.srcObject = null;
      this.muted = true;
      this.volume = 1;
      this.paused = true;
      this.readyState = 4;
      this.pauseCalls = 0;
      this.playCalls = 0;
      FakeAudio.instances.push(this);
    }

    pause() { this.pauseCalls += 1; this.paused = true; }
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); }
  }

  class FakePeerConnection {
    static instances = [];

    constructor() {
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.listeners = new Map();
      FakePeerConnection.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    addTransceiver() {}
    getReceivers() { return []; }
    async getStats() {
      return new Map([[
        'audio-inbound',
        {
          type: 'inbound-rtp',
          kind: 'audio',
          bytesReceived: 4096,
          packetsReceived: 64,
          packetsLost: 0,
          audioLevel: 0.25,
          totalAudioEnergy: 1.5,
          totalSamplesDuration: 2.5,
        },
      ]]);
    }
    close() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription() {}
  }

  const video = {
    muted: true,
    volume: 1,
    paused: true,
    videoWidth: 1,
    currentTime: 0,
    playbackRate: 1,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    load() {},
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  };
  const diagnosticEvents = [];
  const sandbox = {
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakePeerConnection,
    MediaStream: FakeMediaStream,
    Audio: FakeAudio,
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
      webrtc_url: 'ws://127.0.0.1/api/ws?src=video',
      audio_webrtc_url: 'ws://127.0.0.1/api/ws?src=audio',
    },
    {
      onDiagnostics: (mode, detail) => diagnosticEvents.push({ mode, detail }),
    },
  );

  assert.equal(sandbox.MiCameraPlayer.setAudio(video, true), true);
  const audioSocket = FakeWebSocket.instances.find((ws) => ws.url.includes('src=audio'));
  const audioPeer = FakePeerConnection.instances[1];
  audioSocket.emit('open');
  audioPeer.emit('track', {
    track: {
      kind: 'audio',
      muted: false,
      enabled: true,
      readyState: 'live',
      addEventListener() {},
      stop() {},
    },
  });
  audioPeer.connectionState = 'connected';
  audioPeer.emit('connectionstatechange');
  assert.equal(FakeAudio.instances[0].muted, false);
  assert.equal(FakeAudio.instances[0].paused, false);
  const pauseCalls = FakeAudio.instances[0].pauseCalls;
  const playCalls = FakeAudio.instances[0].playCalls;
  assert.equal(sandbox.MiCameraPlayer.setAudio(video, true), true);
  assert.equal(FakeAudio.instances[0].pauseCalls, pauseCalls);
  assert.equal(FakeAudio.instances[0].playCalls, playCalls);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const stats = diagnosticEvents.find((event) => event.mode === 'audio-stats');
  assert.ok(stats, JSON.stringify(diagnosticEvents));
  assert.equal(stats.detail.inbound.audio.bytes, 4096);
  assert.equal(stats.detail.inbound.audio.packets, 64);
  assert.equal(stats.detail.inbound.audio.audioLevel, 0.25);

  assert.equal(
    sandbox.MiCameraPlayer.setAudio(video, false),
    true,
    JSON.stringify(diagnosticEvents),
  );
  assert.equal(FakeAudio.instances[0].muted, true, JSON.stringify(diagnosticEvents));
  assert.equal(FakeAudio.instances[0].paused, true);
  cleanup();
});

test('local playback falls back to remote when no first frame arrives', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'ui/app.js'), 'utf8');
  assert.match(source, /本地画面未出画，已自动切换远程/);
  assert.match(source, /本地未出画，正在切换远程连接/);
  assert.match(source, /\}, 15000\);/);
});

test('local player can fall back to MSE without ICE', () => {
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

test('local streams stay on stable H.264 unless native video is explicitly preferred', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  assert.match(main, /fixed-rate H\.264 stream avoids WebKit's periodic HEVC/);
  assert.match(main, /Native video is used only when no transcoder/);
  assert.match(main, /MIHOME_LOCAL_PREFER_NATIVE=1/);
  assert.match(main, /fallback_webrtc_url: runtime\.fallback_webrtc_url_for_did/);
  assert.match(main, /mse_webrtc_url: Some\(runtime\.mse_webrtc_url_for_did/);
  assert.match(main, /prefer_mse: camera::local_prefers_mse\(\),\n\s+video_only: true/);
  assert.match(main, /stream\.quality\(\) == quality[\s\S]{0,120}stream\.has_audio\(\) == audio/);
  assert.match(main, /stream\.health_reason\(\)\.is_none\(\)/);
});

test('remote video stays isolated from the independently negotiated audio stream', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  assert.equal(
    (main.match(/host: "CS2 relay"\.to_string\(\),\n\s+prefer_mse: false,\n\s+video_only: true/g) || []).length,
    2,
  );
});

test('local video-only WebRTC does not negotiate an audio transceiver', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/camera-player.js'), 'utf8');

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    emit(name, event = {}) { this.listeners.get(name)?.(event); }
    send() {}
    close() {}
  }

  class FakePeerConnection {
    static instances = [];

    constructor() {
      this.connectionState = 'new';
      this.listeners = new Map();
      this.transceivers = [];
      FakePeerConnection.instances.push(this);
    }

    addEventListener(name, handler) { this.listeners.set(name, handler); }
    addTransceiver(kind) { this.transceivers.push(kind); }
    getReceivers() { return []; }
    close() {}
    async createOffer() { return { type: 'offer', sdp: 'offer' }; }
    async setLocalDescription(description) { this.localDescription = description; }
  }

  const video = {
    muted: true,
    volume: 1,
    paused: true,
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
  const cleanup = sandbox.MiCameraPlayer.play(
    video,
    { url: 'http://127.0.0.1/hls', webrtc_url: 'ws://127.0.0.1/api/ws', video_only: true },
    {},
  );

  FakeWebSocket.instances[0].emit('open');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(FakePeerConnection.instances[0].transceivers, ['video']);
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
  const infoPlist = fs.readFileSync(
    path.resolve(__dirname, '..', 'src-tauri/Info.plist'),
    'utf8',
  );
  assert.match(infoPlist, /<key>NSLocalNetworkUsageDescription<\/key>/);
  assert.match(infoPlist, /局域网/);
});

test('release bundle strips symbols without requiring cargo-binutils', () => {
  const root = path.resolve(__dirname, '..');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  const build = fs.readFileSync(path.resolve(root, '../scripts/build-macos.sh'), 'utf8');
  const config = JSON.parse(fs.readFileSync(
    path.join(root, 'src-tauri/tauri.conf.json'),
    'utf8',
  ));
  assert.match(cargo, /tauri = \{ version = "2", default-features = false, features = \["wry", "tray-icon"\] \}/);
  assert.match(cargo, /^lto = true$/m);
  assert.match(cargo, /^codegen-units = 1$/m);
  assert.match(cargo, /^strip = false$/m);
  assert.match(cargo, /^panic = "abort"$/m);
  assert.equal(config.build.beforeBundleCommand, 'bash ../scripts/strip-macos-binary.sh');
  assert.match(build, /DMG_FORMAT=\$\{DMG_FORMAT:-ULMO\}/);
  assert.match(build, /APPLE_SIGNING_IDENTITY="-"/);
  assert.match(build, /SIGNING_MODE=ad-hoc/);
  assert.match(build, /codesign --verify --deep --strict --verbose=2 "\$APP_BUNDLE"/);
  assert.equal(
    fs.existsSync(path.resolve(root, '../scripts/strip-macos-binary.sh')),
    true,
  );
});
