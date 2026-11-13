// Shared Chrome DevTools Protocol helpers and the offline Tauri mock used by
// ui-regression.mjs and perf-scale.mjs.

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.onEvent?.(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

export const waitFor = async (check, timeout = 12000) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw last instanceof Error ? last : new Error(`timeout: ${JSON.stringify(last)}`);
};

export const mockSource = String.raw`
(() => {
  const specs = {
    'urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:temperature-humidity-sensor:0000780B:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:temperature:00000020:mock:1', description: 'Temperature', format: 'float', access: ['read'], unit: 'celsius' },
          { iid: 2, type: 'urn:miot-spec-v2:property:relative-humidity:00000021:mock:1', description: 'Relative Humidity', format: 'uint8', access: ['read'], unit: 'percentage' },
          { iid: 3, type: 'urn:miot-spec-v2:property:battery-level:0000000A:mock:1', description: 'Battery Level', format: 'uint8', access: ['read'], unit: 'percentage' },
          { iid: 4, type: 'urn:miot-spec-v2:property:filter-life-level:000000A1:mock:1', description: 'Filter Life Level', format: 'uint8', access: ['read'], unit: 'percentage', 'value-range': [0, 100, 1] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:light:0000A001:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:light:00007802:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:brightness:00000010:mock:1', description: 'Brightness', format: 'uint8', access: ['read', 'write'], unit: 'percentage', 'value-range': [1, 100, 1] },
          { iid: 3, type: 'urn:miot-spec-v2:property:color-temperature:0000000B:mock:1', description: 'Color Temperature', format: 'uint16', access: ['read', 'write'], unit: 'kelvin', 'value-range': [2700, 6500, 100] },
          { iid: 4, type: 'urn:miot-spec-v2:property:mode:00000008:mock:1', description: 'Mode', format: 'uint8', access: ['read', 'write'], 'value-list': [{ value: 0, description: 'None' }, { value: 1, description: 'Reading' }, { value: 2, description: 'Lighting' }, { value: 3, description: 'Tv' }, { value: 4, description: 'Warmth' }, { value: 5, description: 'Night Light' }, { value: 6, description: 'Vendor Private Mode' }] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:curtain:0000A00D:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:curtain:00007808:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:target-position:0000001A:mock:1', description: 'Target Position', format: 'uint8', access: ['read', 'write'], unit: 'percentage', 'value-range': [0, 100, 1] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:camera:0000A009:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:camera-control:0000782F:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Camera Switch', format: 'bool', access: ['read', 'write'] },
          { iid: 2, type: 'urn:miot-spec-v2:property:night-shot:00000057:mock:1', description: 'Night Shot', format: 'uint8', access: ['read', 'write'], 'value-list': [{ value: 0, description: 'Auto' }, { value: 1, description: 'Off' }] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:outlet:0000A002:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:switch:00007801:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
        ],
      }, {
        iid: 11,
        type: 'urn:miot-spec-v2:service:power-consumption:0000780E:mock:1',
        description: 'Power Consumption',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:power-consumption:0000002F:mock:1', description: 'Power Consumption', format: 'float', access: ['read', 'notify'], unit: 'kWh' },
          { iid: 2, type: 'urn:miot-spec-v2:property:electric-power:00000066:mock:1', description: 'Electric Power', format: 'float', access: ['read', 'notify'], unit: 'watt' },
        ],
      }],
    },
    'urn:miot-spec-v2:device:speaker:0000A015:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:speaker:0000781C:mock:1',
        description: 'Speaker',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:volume:00000013:mock:1', description: 'Volume', format: 'uint8', access: ['read', 'write'], unit: 'percentage', 'value-range': [0, 100, 1] },
          { iid: 2, type: 'urn:miot-spec-v2:property:mute:00000040:mock:1', description: 'Mute', format: 'bool', access: ['read', 'write'] },
        ],
      }, {
        iid: 3,
        type: 'urn:miot-spec-v2:service:play-control:0000781D:mock:1',
        description: 'Play Control',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:playing-state:00000099:mock:1', description: 'Playing State', format: 'uint8', access: ['notify'] },
        ],
        actions: [
          { iid: 1, type: 'urn:miot-spec-v2:action:play:0000280B:mock:1', description: 'Play', in: [] },
          { iid: 2, type: 'urn:miot-spec-v2:action:pause:0000280C:mock:1', description: 'Pause', in: [] },
          { iid: 3, type: 'urn:miot-spec-v2:action:next:0000280D:mock:1', description: 'Next', in: [] },
          { iid: 4, type: 'urn:miot-spec-v2:action:previous:0000280E:mock:1', description: 'Previous', in: [] },
        ],
      }, {
        iid: 5,
        type: 'urn:miot-spec-v2:service:intelligent-speaker:00007A0F:mock:1',
        description: 'Intelligent Speaker',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:text-content:000000C1:mock:1', description: 'Text Content', format: 'string', access: [] },
          { iid: 2, type: 'urn:miot-spec-v2:property:silent-execution:000000C2:mock:1', description: 'Silent Execution', format: 'bool', access: [] },
        ],
        actions: [
          { iid: 1, type: 'urn:miot-spec-v2:action:play-text:00002837:mock:1', description: 'Play Text', in: [1] },
          { iid: 3, type: 'urn:miot-spec-v2:action:wake-up:00002838:mock:1', description: 'Wake Up', in: [] },
          { iid: 5, type: 'urn:miot-spec-v2:action:execute-text-directive:00002839:mock:1', description: 'Execute Text Directive', in: [1, 2] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:television:0000A00C:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:television:00007809:mock:1',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write'] },
        ],
      }],
    },
    'urn:miot-spec-v2:device:router:0000A036:mock:1': {
      services: [{
        iid: 2,
        type: 'urn:miot-spec-v2:service:router:00007864:mock:1',
        description: 'Router',
        actions: [{ iid: 1, type: 'urn:miot-spec-v2:action:reboot:00002801:mock:1' }],
        properties: [
          { iid: 3, type: 'urn:miot-spec-v2:property:connected-device-number:000000A0:mock:1', description: 'Connected Device Number', format: 'uint16', access: ['read', 'notify'] },
        ],
      }, {
        iid: 5,
        type: 'urn:miot-spec-v2:service:indicator-light:00007803:mock:1',
        description: 'Indicator Light',
        properties: [
          { iid: 1, type: 'urn:miot-spec-v2:property:on:00000006:mock:1', description: 'Switch Status', format: 'bool', access: ['read', 'write', 'notify'] },
        ],
      }],
    },
  };
  const values = {
    'sensor1:2:1': 23.6,
    'sensor1:2:2': 51,
    'sensor1:2:3': 86,
    'sensor1:2:4': 12,
    'light1:2:1': true,
    'light1:2:2': 68,
    'light1:2:3': 4200,
    'light1:2:4': 1,
    'curtain1:2:1': true,
    'curtain1:2:2': 60,
    'camera1:2:1': true,
    'camera1:2:2': 0,
    'camera2:2:1': true,
    'camera2:2:2': 0,
    'plug1:2:1': true,
    'plug1:11:1': 12.4,
    'plug1:11:2': 36.5,
    'speaker1:2:1': 35,
    'speaker1:2:2': false,
    'fan1:2:1': false,
    'fan1:2:2': 20,
    'fan1:2:4': 1,
    'tv1:2:1': false,
    'router1:2:3': 22,
    'router1:5:1': false,
    'b-light:2:1': true,
    'b-light:2:2': 55,
    'b-light:2:3': 3900,
    'b-light:2:4': 2,
    'c-light:2:1': false,
    'c-light:2:2': 80,
    'c-light:2:3': 5000,
    'c-light:2:4': 3,
  };
  const devices = [
    { did: 'sensor1', name: '温湿度计', model: 'miaomiaoce.sensor_ht.t8', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:temperature-humidity-sensor:0000A00A:mock:1', parent_id: null },
    { did: 'light1', name: '客厅主灯', model: 'yeelink.light.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null },
    { did: 'curtain1', name: '客厅窗帘', model: 'lumi.curtain.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:curtain:0000A00D:mock:1', parent_id: null },
    { did: 'camera1', name: '小米智能摄像机3 云台版', model: 'chuangmi.camera.069a01', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1', parent_id: null },
    { did: 'camera2', name: '小米智能摄像机2 云台版', model: 'chuangmi.camera.039a01', home_id: 'home1', room_id: 'study', room_name: '书房', online: true, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1', parent_id: null },
    { did: 'plug1', name: '书房插座', model: 'cuco.plug.mock', home_id: 'home1', room_id: 'study', room_name: '书房', online: true, spec_type: 'urn:miot-spec-v2:device:outlet:0000A002:mock:1', parent_id: null },
    { did: 'speaker1', name: '卧室小爱音箱', model: 'xiaomi.wifispeaker.mock', home_id: 'home1', room_id: 'bedroom', room_name: '卧室', online: true, spec_type: 'urn:miot-spec-v2:device:speaker:0000A015:mock:1', parent_id: null },
    { did: 'fan1', name: '卧室风扇灯', model: 'yeelink.light.fanmock', home_id: 'home1', room_id: 'bedroom', room_name: '卧室', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null },
    { did: 'tv1', name: '客厅电视', model: 'xiaomi.tv.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: false, spec_type: 'urn:miot-spec-v2:device:television:0000A00C:mock:1', parent_id: null },
    { did: 'router1', name: '客厅路由器', model: 'xiaomi.router.mock', home_id: 'home1', room_id: 'living', room_name: '客厅', online: true, spec_type: 'urn:miot-spec-v2:device:router:0000A036:mock:1', parent_id: null },
  ];
  const scenes = [
    { id: 'scene-home', name: '回家', home_id: 'home1' },
    { id: 'scene-away', name: '离家', home_id: 'home1' },
    { id: 'scene-movie', name: '观影', home_id: 'home1' },
  ];
  const cameras = [
    { did: 'camera1', name: '小米智能摄像机3 云台版', model: 'chuangmi.camera.069a01', ip: '192.0.2.10', online: true, subtype: 'camera', channel: 0, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1' },
    { did: 'camera2', name: '小米智能摄像机2 云台版', model: 'chuangmi.camera.039a01', ip: null, online: true, subtype: 'camera', channel: 0, spec_type: 'urn:miot-spec-v2:device:camera:0000A009:mock:1' },
  ];
  // Optional load profile for perf-scale.mjs: window.__MOCK_SCALE__ =
  // { cameras, lights } adds that many synthetic devices to mock-user.
  const scale = window.__MOCK_SCALE__ || {};
  const scaledRooms = [['living', '客厅'], ['study', '书房'], ['bedroom', '卧室']];
  const scaledDids = { living: [], study: [], bedroom: [] };
  for (let index = 0; index < Math.max(0, Number(scale.cameras) || 0); index += 1) {
    const did = 'cam-scale-' + index;
    const [roomId, roomName] = scaledRooms[index % scaledRooms.length];
    const online = index % 9 !== 4;
    const ip = index % 4 === 3 ? null : '10.20.' + (index >> 8) + '.' + (index & 255);
    const model = index % 2 ? 'chuangmi.camera.069a01' : 'chuangmi.camera.039a01';
    const name = '仓库摄像头 ' + String(index + 1).padStart(3, '0');
    const spec = 'urn:miot-spec-v2:device:camera:0000A009:mock:1';
    cameras.push({ did, name, model, ip, online, subtype: 'camera', channel: 0, spec_type: spec });
    devices.push({ did, name, model, home_id: 'home1', room_id: roomId, room_name: roomName, online, spec_type: spec, parent_id: null });
    scaledDids[roomId].push(did);
    values[did + ':2:1'] = true;
    values[did + ':2:2'] = 0;
  }
  for (let index = 0; index < Math.max(0, Number(scale.lights) || 0); index += 1) {
    const did = 'light-scale-' + index;
    const [roomId, roomName] = scaledRooms[index % scaledRooms.length];
    devices.push({ did, name: '筒灯 ' + (index + 1), model: 'yeelink.light.mock', home_id: 'home1', room_id: roomId, room_name: roomName, online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null });
    scaledDids[roomId].push(did);
    values[did + ':2:1'] = index % 2 === 0;
    values[did + ':2:2'] = 40 + (index % 60);
    values[did + ':2:3'] = 4000;
    values[did + ':2:4'] = 1;
  }
  const accountDevices = {
    'mock-user': devices,
    'mock-user-2': [{
      did: 'b-light', name: '工作室射灯', model: 'yeelink.light.mock', home_id: 'home-b', room_id: 'b-room', room_name: '工作室', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null,
    }],
    'mock-user-3': [{
      did: 'c-light', name: '创意工作室灯', model: 'yeelink.light.mock', home_id: 'home-c', room_id: 'c-room', room_name: '工位', online: true, spec_type: 'urn:miot-spec-v2:device:light:0000A001:mock:1', parent_id: null,
    }],
  };
  const accountHomes = {
    'mock-user': [{
      id: 'home1', name: '云栖公寓', uid: 1, room_count: 3,
      rooms: [
        { id: 'living', name: '客厅', dids: ['sensor1', 'light1', 'curtain1', 'camera1', 'tv1', 'router1'] },
        { id: 'study', name: '书房', dids: ['camera2', 'plug1'] },
        { id: 'bedroom', name: '卧室', dids: ['speaker1', 'fan1'] },
      ],
    }, {
      id: 'home2', name: '工作室', uid: 1, room_count: 3,
      rooms: [
        { id: 'living', name: '客厅', dids: ['sensor1', 'light1', 'curtain1', 'camera1', 'tv1', 'router1'] },
        { id: 'study', name: '书房', dids: ['camera2', 'plug1'] },
        { id: 'bedroom', name: '卧室', dids: ['speaker1', 'fan1'] },
      ],
    }],
    'mock-user-2': [{ id: 'home-b', name: '湖畔住宅', uid: 2, room_count: 1, rooms: [{ id: 'b-room', name: '工作室', dids: ['b-light'] }] }],
    'mock-user-3': [{ id: 'home-c', name: '创意工作室', uid: 3, room_count: 1, rooms: [{ id: 'c-room', name: '工位', dids: ['c-light'] }] }],
  };
  for (const home of accountHomes['mock-user']) {
    for (const room of home.rooms) room.dids.push(...(scaledDids[room.id] || []));
  }
  const accountScenes = {
    'mock-user': scenes,
    'mock-user-2': [{ id: 'scene-b', name: '工作室加班', home_id: 'home-b' }],
    'mock-user-3': [{ id: 'scene-c', name: '创意模式', home_id: 'home-c' }],
  };
  const accountCameras = {
    'mock-user': cameras,
    'mock-user-2': [],
    'mock-user-3': [],
  };
  let accounts = [
    { user_id: 'mock-user', display_name: '云栖账号', active: true },
    { user_id: 'mock-user-2', display_name: '工作室账号', active: false },
  ];
  let activeUserId = 'mock-user';
  const accountSummaries = () => accounts.map((account) => ({
    ...account,
    active: account.user_id === activeUserId,
  }));
  let authGeneration = 0;
  const setActiveAccount = (userId) => {
    if (!accounts.some((account) => account.user_id === userId)) return false;
    activeUserId = userId;
    return true;
  };
  window.__SET_DEVICE_ONLINE__ = (did, online) => {
    const device = (accountDevices[activeUserId] || []).find((item) => item.did === did);
    if (device) device.online = Boolean(online);
  };
  const quickPrefs = { 'mock-user': { devices: [], scenes: [] } };
  const accountAutomations = {
    'mock-user': [{
      id: 'auto1',
      name: '早上开灯',
      time: '07:30',
      days: [1, 2, 3, 4, 5],
      scene_id: 'scene-home',
      home_id: 'home1',
      enabled: true,
      last_run: null,
    }],
    'mock-user-2': [],
    'mock-user-3': [],
  };
  const integration = {
    settings: {
      gateway_enabled: false,
      gateway_port: 17666,
      gateway_token_masked: '••••mock',
      gateway_token_configured: true,
      feishu: {
        enabled: true, configured: true, mode: 'websocket',
        app_id: 'cli_••••mock', secret_configured: true,
        verification_configured: false, encryption_configured: false,
      },
      wecom: {
        enabled: false, configured: false, mode: 'websocket',
        app_id: null, secret_configured: false,
        verification_configured: false, encryption_configured: false,
      },
      dingtalk: {
        enabled: false, configured: false, mode: 'websocket',
        app_id: null, secret_configured: false,
        verification_configured: false, encryption_configured: false,
      },
      llm_enabled: false,
      llm_base_url: 'https://api.openai.com/v1',
      llm_model: 'gpt-4.1-mini',
      llm_key_configured: false,
      asr_enabled: true,
      asr_provider: 'whisper_cpp',
      asr_base_url: 'https://api.openai.com/v1',
      asr_model: 'whisper-1',
      asr_language: 'zh-CN',
      asr_key_configured: false,
      asr_command: 'whisper-cli',
      asr_model_path: '',
      bindings: [],
      active_pairing_codes: [],
    },
    gateway: {
      running: false, port: null, base_url: null,
      uptime_seconds: null, error: null,
    },
    connections: {
      feishu_ws: {
        running: true, state: 'connected', endpoint: '飞书事件长连接',
        connected_seconds: 120, last_error: null,
      },
      wecom_ws: {
        running: false, state: 'stopped', endpoint: 'wss://openws.work.weixin.qq.com',
        connected_seconds: null, last_error: null,
      },
      dingtalk_ws: {
        running: false, state: 'stopped', endpoint: '钉钉 Stream 长连接',
        connected_seconds: null, last_error: null,
      },
    },
  };
  const integrationSnapshot = () => clone({
    settings: integration.settings,
    gateway: integration.gateway,
    connections: integration.connections,
    webhook: {
      feishu_path: '/v1/platform/feishu',
      wecom_path: '/v1/platform/wecom',
      dingtalk_mode: 'stream',
      requires_public_tunnel: true,
    },
  });
  let automationSequence = 10;
  window.__MOCK_SET_CONNECTION__ = (key, patch) => {
    Object.assign(integration.connections[key], patch);
    return integrationSnapshot();
  };
  window.__MOCK_NEXT_LOGIN__ = null;
  window.__MOCK_DELAY_NEXT__ = null;
  window.__MOCK_LIST_HOMES_ERROR__ = null;
  window.__MOCK_CALLS__ = [];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  window.__MIHOME_TAURI__ = Object.freeze({
    invoke: async (command, args = {}) => {
      window.__MOCK_CALLS__.push({ command, args: clone(args) });
      const delayed = window.__MOCK_DELAY_NEXT__;
      if (delayed && delayed.command === command
        && (!delayed.account || delayed.account === activeUserId)) {
        window.__MOCK_DELAY_NEXT__ = null;
        await new Promise((resolve) => setTimeout(resolve, delayed.ms));
      }
      if (command === 'auth_resume') return activeUserId;
      if (command === 'auth_accounts') return clone(accountSummaries());
      if (command === 'auth_logout') {
        accounts = accounts.filter((account) => account.user_id !== activeUserId);
        activeUserId = accounts[0]?.user_id || null;
        return { active_user_id: activeUserId, accounts: clone(accountSummaries()) };
      }
      if (command === 'auth_switch_account') {
        if (!setActiveAccount(args.userId)) throw new Error('mock account missing');
        return args.userId;
      }
      if (command === 'auth_set_account_label') {
        const account = accounts.find((item) => item.user_id === activeUserId);
        if (account) account.display_name = args.label;
        return null;
      }
      if (command === 'auth_cancel') {
        authGeneration += 1;
        return null;
      }
      if (command === 'auth_start') {
        authGeneration += 1;
        return {
          qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-label="mock qr"><rect width="20" height="20" fill="#fff"/><path d="M2 2h6v6H2zm10 0h6v6h-6zM2 12h6v6H2zm10 2h2v2h-2zm4-2h2v2h-2z" fill="#111"/></svg>',
        };
      }
      if (command === 'auth_poll') {
        const pollGeneration = authGeneration;
        if (window.__MOCK_DELAY_NEXT__?.command === 'auth_poll') {
          await new Promise((resolve) => setTimeout(resolve, window.__MOCK_DELAY_NEXT__.ms));
          window.__MOCK_DELAY_NEXT__ = null;
        }
        if (pollGeneration !== authGeneration) {
          return { status: 'error', user_id: null, message: '登录已取消' };
        }
        const userId = window.__MOCK_NEXT_LOGIN__ || accounts[0]?.user_id || 'mock-user';
        const labels = { 'mock-user': '云栖账号', 'mock-user-2': '工作室账号', 'mock-user-3': '创意账号' };
        window.__MOCK_NEXT_LOGIN__ = null;
        if (!accounts.some((account) => account.user_id === userId)) {
          accounts.push({ user_id: userId, display_name: labels[userId] || null, active: false });
        }
        setActiveAccount(userId);
        return { status: 'success', user_id: userId, message: '' };
      }
      if (command === 'app_meta') return { name: 'MiHome Mac', version: '1.3.0' };
      if (command === 'ui_ready' || command === 'camera_stop' || command === 'log_export') return null;
      if (command === 'list_homes') {
        if (window.__MOCK_LIST_HOMES_ERROR__) throw new Error(window.__MOCK_LIST_HOMES_ERROR__);
        return clone(accountHomes[activeUserId] || []);
      }
      if (command === 'list_devices') return clone(accountDevices[activeUserId] || []);
      if (command === 'get_device_specs') {
        return {
          specs: Object.fromEntries(args.specTypes.filter((key) => specs[key]).map((key) => [key, specs[key]])),
          errors: [],
        };
      }
      if (command === 'get_properties' || command === 'get_property') {
        const requests = command === 'get_properties' ? args.requests : [{ did: args.did, siid: args.siid, piid: args.piid }];
        return requests.map(({ did, siid, piid }) => ({
          did, siid, piid, code: 0, value: values[did + ':' + siid + ':' + piid],
        }));
      }
      if (command === 'set_property') {
        values[args.did + ':' + args.siid + ':' + args.piid] = args.value;
        return [{ code: 0 }];
      }
      if (command === 'call_action') {
        (window.__MOCK_ACTIONS__ ||= []).push(clone(args));
        if (window.__MOCK_ACTION_ERROR__) throw new Error(window.__MOCK_ACTION_ERROR__);
        return null;
      }
      if (command === 'device_statistics') {
        const query = args.query;
        (window.__MOCK_STATS_QUERIES__ ||= []).push(clone(query));
        if (window.__MOCK_STATS_ERROR__) throw new Error(window.__MOCK_STATS_ERROR__);
        if (query.did !== 'plug1') return [];
        // One record per local day or month start, newest first like the cloud.
        const points = [];
        const start = new Date(query.time_start * 1000);
        for (let index = 0; index < query.limit; index += 1) {
          const date = query.data_type === 'stat_month_v3'
            ? new Date(start.getFullYear(), start.getMonth() + index, 1)
            : new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
          if (date.getTime() / 1000 > query.time_end) break;
          if (index === 2) continue;
          const base = query.data_type === 'stat_month_v3' ? 30 : 1;
          points.push({ time: Math.floor(date.getTime() / 1000), value: Number((base * (0.6 + (index % 5) * 0.25)).toFixed(2)) });
        }
        return points.reverse();
      }
      if (command === 'list_scenes') return clone(accountScenes[activeUserId] || []);
      // 菜单栏面板配置：按账号分开保存，切换账号后读到的应该是各自的那一份。
      if (command === 'quick_prefs') return clone(quickPrefs[activeUserId] || { devices: [], scenes: [] });
      if (command === 'save_quick_prefs') {
        const next = { devices: clone(args.devices || []), scenes: clone(args.scenes || []) };
        quickPrefs[activeUserId] = next;
        return clone(next);
      }
      if (command === 'run_scene') return null;
      if (command === 'list_cameras') return clone(accountCameras[activeUserId] || []);
      if (command === 'camera_start') {
        return args.dids.map((did) => ({ id: did, url: 'http://127.0.0.1:9/mock.m3u8', host: 'local', prefer_mse: true, video_only: true }));
      }
      if (command === 'camera_remote_start') {
        // Simulates a slow relay handshake for every remote start.
        if (window.__MOCK_REMOTE_DELAY_MS__) {
          await new Promise((resolve) => setTimeout(resolve, window.__MOCK_REMOTE_DELAY_MS__));
        }
        return { id: args.did, url: 'http://127.0.0.1:9/mock.m3u8', host: 'CS2 relay', prefer_mse: false, video_only: true, webrtc_url: null };
      }
      if (command === 'camera_remote_stop' || command === 'camera_remote_ptz') return null;
      if (command === 'camera_diagnostics') return { alive: true, api_ready: true, detail: 'mock ready' };
      if (command === 'list_automations') return clone(accountAutomations[activeUserId] || []);
      if (command === 'save_automation') {
        const item = { ...args.automation, id: 'auto' + automationSequence++ };
        accountAutomations[activeUserId].push(item);
        return clone(accountAutomations[activeUserId]);
      }
      if (command === 'toggle_automation') {
        accountAutomations[activeUserId] = accountAutomations[activeUserId]
          .map((item) => item.id === args.id ? { ...item, enabled: args.enabled } : item);
        return clone(accountAutomations[activeUserId]);
      }
      if (command === 'delete_automation') {
        accountAutomations[activeUserId] = accountAutomations[activeUserId]
          .filter((item) => item.id !== args.id);
        return clone(accountAutomations[activeUserId]);
      }
      if (command === 'integration_snapshot') return integrationSnapshot();
      if (command === 'integration_save_platform') {
        const target = integration.settings[args.platform];
        target.enabled = args.enabled;
        target.mode = args.mode || target.mode;
        target.configured = true;
        target.secret_configured = true;
        target.app_id = args.appId || target.app_id || 'mock••••';
        const connection = integration.connections[args.platform + '_ws'];
        if (args.enabled && target.mode === 'websocket') {
          connection.running = true;
          connection.state = 'connected';
          connection.connected_seconds = 1;
          connection.last_error = null;
        } else {
          connection.running = false;
          connection.state = 'stopped';
          connection.connected_seconds = null;
        }
        return integrationSnapshot();
      }
      if (command === 'integration_reconnect_platform') {
        const connection = integration.connections[args.platform + '_ws'];
        connection.running = true;
        connection.state = 'connected';
        connection.connected_seconds = 1;
        connection.last_error = null;
        return integrationSnapshot();
      }
      if (command === 'integration_save_llm') {
        integration.settings.llm_enabled = args.enabled;
        integration.settings.llm_base_url = args.baseUrl;
        integration.settings.llm_model = args.model;
        integration.settings.llm_key_configured = Boolean(args.apiKey) || integration.settings.llm_key_configured;
        return integrationSnapshot();
      }
      if (command === 'integration_save_asr') {
        integration.settings.asr_enabled = args.enabled;
        integration.settings.asr_provider = args.provider;
        integration.settings.asr_base_url = args.baseUrl;
        integration.settings.asr_model = args.model;
        integration.settings.asr_language = args.language;
        integration.settings.asr_command = args.command;
        integration.settings.asr_model_path = args.modelPath;
        integration.settings.asr_key_configured = Boolean(args.apiKey) || integration.settings.asr_key_configured;
        return integrationSnapshot();
      }
      if (command === 'integration_set_gateway') {
        integration.gateway.running = args.enabled;
        integration.gateway.port = args.enabled ? args.port : null;
        integration.gateway.base_url = args.enabled ? 'http://127.0.0.1:' + args.port : null;
        integration.settings.gateway_port = args.port;
        integration.settings.gateway_enabled = args.enabled;
        return integrationSnapshot();
      }
      if (command === 'integration_generate_pair_code') {
        const pairing = {
          code: '123456',
          platform: args.platform,
          expires_in: 600,
          expires_at: Math.floor(Date.now() / 1000) + 600,
        };
        integration.settings.active_pairing_codes = [pairing];
        return clone(pairing);
      }
      if (command === 'integration_revoke_binding') {
        integration.settings.bindings = integration.settings.bindings.filter((item) => item.id !== args.id);
        return integrationSnapshot();
      }
      if (command === 'integration_reveal_gateway_token') return 'mock-gateway-token';
      if (command === 'integration_test_feishu'
        || command === 'integration_test_wecom'
        || command === 'integration_test_dingtalk') {
        return '平台连接测试成功';
      }
      if (command === 'integration_test_llm') return '模型连接成功：gpt-4.1-mini';
      if (command === 'integration_test_asr') return '语音识别可用';
      throw new Error('unhandled mock invoke: ' + command);
    },
  });
})();
`;
