const HOME = {
  id: '9000',
  name: '云栖公寓',
  region: '杭州 · 西湖区',
  rooms: [
    { id: 'living', name: '客厅', short: '客' },
    { id: 'bedroom', name: '主卧', short: '卧' },
    { id: 'study', name: '书房', short: '书' },
    { id: 'kitchen', name: '厨房', short: '厨' },
    { id: 'entry', name: '玄关', short: '玄' },
    { id: 'balcony', name: '阳台', short: '阳' },
  ],
};

const DEVICES = [
  {
    id: 'lamp-living', name: '客厅主灯', room: 'living', type: 'light', icon: 'light',
    model: 'yeelink.light.lamp4', online: true, path: 'lan', latency: 12, tone: 'warm', pinned: true,
    state: { on: true, brightness: 78, colorTemp: 4200, mode: 'read' },
    history: [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '每天 19:00 自动打开',
    firmware: '1.5.9_0021',
  },
  {
    id: 'ac-living', name: '客厅空调', room: 'living', type: 'ac', icon: 'ac',
    model: 'xiaomi.aircondition.mc5', online: true, path: 'lan', latency: 16, tone: 'cool', pinned: true,
    state: { on: true, temp: 24, mode: 'cool', fan: 0, swing: true, indoor: 26.2, outdoor: 31.5 },
    history: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '制冷 · 自动风 · 运行 2 小时 14 分',
    firmware: '3.1.2',
  },
  {
    id: 'curtain-living', name: '客厅窗帘', room: 'living', type: 'curtain', icon: 'curtain',
    model: 'lumi.curtain.hagl05', online: true, path: 'lan', latency: 18, tone: 'sand', pinned: false,
    state: { on: true, position: 60, status: 'stopped' },
    history: [0, 0, 0, 0, 20, 60, 100, 100, 100, 100, 100, 100, 100, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 60],
    note: '开合 60% · 电机温度正常',
    firmware: '2.0.4',
  },
  {
    id: 'purifier-living', name: '空气净化器', room: 'living', type: 'purifier', icon: 'purifier',
    model: 'zhimi.airpurifier.va1', online: true, path: 'lan', latency: 21, tone: 'sage', pinned: true,
    state: { on: true, mode: 'auto', pm25: 12, filter: 76, temp: 24.1, humidity: 57 },
    history: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '自动模式 · 滤芯剩余 76%',
    firmware: '2.2.6',
  },
  {
    id: 'sensor-living', name: '温湿度计', room: 'living', type: 'sensor', icon: 'sensor',
    model: 'lumi.sensor_ht.htv1', online: true, path: 'lan', latency: 9, tone: 'neutral', pinned: true,
    state: { on: true, temperature: 24.6, humidity: 58, battery: 87 },
    series: [24.1, 24.0, 23.8, 23.7, 23.9, 24.2, 24.5, 24.8, 25.0, 25.2, 25.1, 24.9, 24.7, 24.6, 24.6, 24.8, 24.9, 24.7, 24.5, 24.4, 24.3, 24.5, 24.6, 24.6],
    note: '电池 87% · 12 分钟前上报',
    firmware: '1.0.1_0027',
  },
  {
    id: 'strip-bed', name: '主卧灯带', room: 'bedroom', type: 'light', icon: 'strip',
    model: 'yeelink.light.strip2', online: true, path: 'lan', latency: 14, tone: 'warm', pinned: false,
    state: { on: false, brightness: 30, colorTemp: 3000, mode: 'sleep' },
    history: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    note: '夜间起夜模式已关闭',
    firmware: '1.4.0',
  },
  {
    id: 'humidifier-bed', name: '主卧加湿器', room: 'bedroom', type: 'humidifier', icon: 'humidifier',
    model: 'zhimi.humidifier.ca4', online: true, path: 'lan', latency: 19, tone: 'cool', pinned: false,
    state: { on: true, targetHumidity: 55, waterLevel: 62, humidity: 52, mode: 'auto' },
    history: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '水箱 62% · 约剩余 9 小时',
    firmware: '2.3.1',
  },
  {
    id: 'lamp-study', name: '书房台灯', room: 'study', type: 'light', icon: 'light',
    model: 'yeelink.light.lamp4', online: true, path: 'lan', latency: 11, tone: 'warm', pinned: false,
    state: { on: true, brightness: 62, colorTemp: 4000, mode: 'work' },
    history: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '专注模式 · 连续使用 48 分钟',
    firmware: '1.5.9_0021',
  },
  {
    id: 'plug-study', name: '书房插座', room: 'study', type: 'plug', icon: 'plug',
    model: 'lumi.plug.ugv1', online: true, path: 'lan', latency: 13, tone: 'neutral', pinned: false,
    state: { on: true, power: 46.2, voltage: 220.1, current: 0.21 },
    history: [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    note: '今日用电 0.42 kWh',
    firmware: '1.2.0',
  },
  {
    id: 'light-kitchen', name: '厨房灯', room: 'kitchen', type: 'light', icon: 'kitchen',
    model: 'yeelink.light.ceiling3', online: true, path: 'lan', latency: 10, tone: 'neutral', pinned: false,
    state: { on: false, brightness: 100, colorTemp: 5000, mode: 'normal' },
    history: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    note: '离线期间保持关闭',
    firmware: '1.3.2',
  },
  {
    id: 'cam-living', name: '客厅摄像头', room: 'living', type: 'camera', icon: 'camera',
    model: 'chuangmi.camera.046c04', online: true, path: 'lan', latency: 38, tone: 'ink', pinned: true,
    state: { on: true, live: true, privacy: false, recording: true, sound: false, quality: 'hd', ptz: true, motion: true, bitrate: 1.8 },
    camera: {
      protocol: 'CS2', lens: '广角 110°', resolution: '1080p', codec: 'H.264',
      events: [
        { time: '18:42', label: '移动侦测', detail: '沙发旁有人经过，持续 8 秒', type: 'motion' },
        { time: '17:05', label: '画面变化', detail: '窗帘被风吹动，幅度超过阈值', type: 'scene' },
        { time: '12:20', label: '移动侦测', detail: '猫跳上窗台，停留 3 分钟', type: 'motion' },
      ],
    },
    note: '直播中 · 1080p · 局域网 P2P',
    firmware: '4.1.2_0210',
  },
  {
    id: 'cam-entry', name: '玄关摄像头', room: 'entry', type: 'camera', icon: 'camera',
    model: 'chuangmi.camera.072ac1', online: true, path: 'lan', latency: 42, tone: 'cool', pinned: false,
    state: { on: true, live: true, privacy: false, recording: true, sound: false, quality: 'hd', ptz: true, motion: true, bitrate: 2.4 },
    camera: {
      protocol: 'CS2', lens: '广角 130°', resolution: '2K', codec: 'H.265',
      events: [
        { time: '18:36', label: '有人经过', detail: '门口停留 4 秒，未识别到人脸', type: 'motion' },
        { time: '17:05', label: '快递送达', detail: '包裹放在鞋柜旁，停留 12 秒', type: 'package' },
        { time: '08:12', label: '离家', detail: '门锁上锁，画面恢复安静', type: 'door' },
      ],
    },
    note: '直播中 · 2K · 局域网 P2P',
    firmware: '4.3.0_0118',
  },
  {
    id: 'cam-balcony', name: '阳台摄像头', room: 'balcony', type: 'camera', icon: 'camera',
    model: 'chuangmi.camera.ipc019', online: true, path: 'lan', latency: 64, tone: 'sand', pinned: false,
    state: { on: true, live: true, privacy: false, recording: false, sound: false, quality: 'auto', ptz: false, motion: true, bitrate: 0.9 },
    camera: {
      protocol: 'TUTK', lens: '广角 100°', resolution: '720p', codec: 'H.264',
      events: [
        { time: '18:20', label: '移动侦测', detail: '晾衣架被风吹动', type: 'scene' },
        { time: '16:48', label: '画面变化', detail: '天色变暗，夜视已开启', type: 'scene' },
      ],
    },
    note: '直播中 · 720p · 云端转发',
    firmware: '3.4.1_0086',
  },
  {
    id: 'vacuum-balcony', name: '扫地机器人', room: 'balcony', type: 'vacuum', icon: 'vacuum',
    model: 'dreame.vacuum.p2009', online: true, path: 'cloud', latency: 168, tone: 'neutral', pinned: true,
    state: { on: false, status: 'charging', battery: 100, area: 68, mode: 'standard' },
    history: [0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0],
    note: '充电中 · 上次清扫 68 m² / 54 分钟',
    firmware: '4.3.9_0',
  },
];

const CAMERAS = DEVICES.filter(d => d.type === 'camera');

const SCENES = [
  {
    id: 'home', name: '回家', caption: '灯亮、空调开、窗帘收一半', icon: 'sun', tone: 'amber',
    last: '今天 18:42', apply: {
      'lamp-living': { on: true, brightness: 80 },
      'ac-living': { on: true, temp: 24 },
      'curtain-living': { position: 40 },
      'purifier-living': { on: true, mode: 'auto' },
    },
  },
  {
    id: 'away', name: '离家', caption: '全屋灯光关闭，扫地机回充', icon: 'bolt', tone: 'ink',
    last: '今天 09:08', apply: {
      'lamp-living': { on: false }, 'strip-bed': { on: false }, 'lamp-study': { on: false },
      'light-kitchen': { on: false }, 'ac-living': { on: false }, 'humidifier-bed': { on: false },
      'curtain-living': { position: 0 }, 'vacuum-balcony': { status: 'charging' },
    },
  },
  {
    id: 'movie', name: '观影', caption: '窗帘全关，只留 15% 暖光', icon: 'moon', tone: 'blue',
    last: '昨天 21:30', apply: {
      'curtain-living': { position: 0, status: 'stopped' },
      'lamp-living': { on: true, brightness: 15, colorTemp: 2700 },
      'strip-bed': { on: true, brightness: 10, colorTemp: 2600 },
      'ac-living': { on: true, temp: 25, mode: 'cool', fan: 1 },
      'purifier-living': { on: true, mode: 'sleep' },
    },
  },
  {
    id: 'night', name: '晚安', caption: '全屋熄灯，空调 26°C 睡眠', icon: 'moon', tone: 'dusk',
    last: '昨天 23:36', apply: {
      'lamp-living': { on: false }, 'strip-bed': { on: false }, 'lamp-study': { on: false },
      'light-kitchen': { on: false }, 'ac-living': { on: true, temp: 26, mode: 'cool', fan: 0 },
      'humidifier-bed': { on: true, targetHumidity: 50 },
      'curtain-living': { position: 0 }, 'purifier-living': { on: true, mode: 'sleep' },
    },
  },
];

const SCHEDULES = [
  { id: 's1', time: '07:30', name: '拉开客厅窗帘', target: '客厅窗帘 · 开至 60%', days: '工作日', enabled: true, icon: 'curtain' },
  { id: 's2', time: '08:00', name: '关闭客厅空调', target: '客厅空调 · 关闭', days: '每天', enabled: true, icon: 'ac' },
  { id: 's3', time: '19:00', name: '打开客厅主灯', target: '客厅主灯 · 亮度 70%', days: '每天', enabled: true, icon: 'light' },
  { id: 's4', time: '23:30', name: '全屋熄灯', target: '4 台灯具 · 关闭', days: '每天', enabled: true, icon: 'power' },
  { id: 's5', time: '02:00', name: '夜间清扫', target: '扫地机器人 · 标准模式', days: '周二 / 四 / 六', enabled: false, icon: 'vacuum' },
];

const MODE_LABEL = { cool: '制冷', dry: '除湿', fan: '送风', heat: '制热', auto: '自动', sleep: '睡眠', favorite: '收藏', read: '阅读', work: '专注', normal: '标准', standard: '标准', strong: '强力' };
const FAN_LABEL = { 0: '自动', 1: '1 档', 2: '2 档', 3: '3 档', 4: '4 档', 5: '5 档', 6: '6 档', 7: '7 档' };
const STATUS_LABEL = { charging: '充电中', cleaning: '清扫中', paused: '已暂停', returning: '回充中', stopped: '已停止' };

const DEVICE_ICON_TIP = {
  light: '灯具', ac: '空调', curtain: '窗帘', purifier: '净化器', sensor: '传感器',
  humidifier: '加湿器', plug: '插座', vacuum: '扫地机', camera: '摄像头',
};
