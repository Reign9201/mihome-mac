(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiCapabilities = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROPERTY_LABELS = {
    on: '开关', brightness: '亮度', 'color-temperature': '色温', mode: '模式',
    'fan-level': '风速', 'target-temperature': '目标温度', temperature: '温度',
    'relative-humidity': '湿度', 'battery-level': '电量', 'night-vision': '夜视',
    'motion-detection': '移动侦测', 'motion-record': '录像', 'video-quality': '画质',
    'wide-dynamic-range': '宽动态', 'full-color-night-vision': '全彩夜视',
    'time-watermark': '时间水印', 'status-led': '状态灯', 'alarm-interval': '报警间隔',
    volume: '音量', mute: '静音', 'motor-control': '云台', 'physical-controls-locked': '按键锁',
    'charging-state': '充电状态', 'power-consumption': '功率', 'electric-current': '电流',
    voltage: '电压', 'filter-life-level': '滤芯寿命', 'water-level': '水位',
    'image-rollover': '画面翻转', 'night-shot': '夜视模式', 'wdr-mode': '宽动态范围',
    'glimmer-full-color': '微光全彩', 'recording-mode': '录像模式',
    'motion-tracking': '移动追踪', 'manual-check-results': '手动检测结果',
    'self-check-results': '自检结果', 'self-check-items': '自检项目',
    'detection-sensitivity': '侦测灵敏度', status: '状态', ejected: '已弹出',
    'record-duration': '录像时长', 'storage-total-space': '存储总容量',
    'storage-free-space': '可用空间', 'storage-used-space': '已用空间',
    'cruise-switch': '巡航开关', 'cruise-cycle': '巡航周期',
    'cruise-start-time': '巡航开始时间', 'cruise-end-time': '巡航结束时间',
    'cruise-repetition': '巡航重复', 'cruise-mode': '巡航模式',
    'cruise-position': '巡航位置', 'fav-area': '收藏区域',
    'active-fav-area': '当前收藏区域', 'current-temperature': '当前温度',
    'target-humidity': '目标湿度', 'child-lock': '童锁', 'indicator-light': '指示灯',
    'baby-wake-switch': '宝宝起床提醒', 'babycry-switch': '宝宝哭声提醒',
    ejected: '弹出存储卡', 'door-state': '门状态',
    'motion-detection-start-time': '侦测开始', 'motion-detection-end-time': '侦测结束',
    'connected-device-number': '连接设备数', 'ir-mode': '空调模式',
    'ir-temperature': '空调温度',
  };

  const SERVICE_GROUPS = {
    switch: '开关', light: '灯光', fan: '风扇', 'air-conditioner': '空调',
    battery: '电池', 'temperature-humidity-sensor': '温湿度', environment: '环境',
    'motion-sensor': '传感器', 'contact-sensor': '传感器', 'camera-control': '摄像头设置',
    camera: '摄像头设置', television: '电视', speaker: '声音', 'door-lock': '门锁',
    'indicator-light': '指示灯', 'memory-card-management': '存储卡管理',
    'motion-detection': '移动侦测', 'p2p-stream': '视频流', 'self-check': '设备自检',
    cruise: '巡航', 'camera-fav-area': '收藏区域', 'ai-scene': '智能场景',
    'imi-alarm': '报警提醒', 'sd-status': '存储卡状态',
    'ir-aircondition-control': '空调控制',
  };

  const UNIT_LABELS = {
    percentage: '%', kelvin: 'K', celsius: '°C', fahrenheit: '°F',
    arcdegrees: '°', degrees: '°', minutes: '分钟', minute: '分钟',
    seconds: '秒', second: '秒', hours: '小时', hour: '小时',
    milliseconds: '毫秒', microseconds: '微秒', lux: 'lx',
    'mg/m3': 'mg/m³', 'μg/m3': 'μg/m³', ppm: 'ppm', db: 'dB',
    none: '',
  };

  const TEXT_LABELS = {
    'switch status': '开关状态', 'image rollover': '画面翻转', 'night shot': '夜视模式',
    'wide dynamic range mode': '宽动态范围', 'glimmer full color': '微光全彩',
    'recording mode': '录像模式', 'motion tracking': '移动追踪',
    'time watermark': '时间水印', 'motion detection': '移动侦测',
    'alarm interval': '报警间隔', 'detection sensitivity': '侦测灵敏度',
    'manual check results': '手动检测结果', 'self check results': '自检结果',
    'self check items': '自检项目', status: '状态',
    'storage total space': '存储总容量', 'storage free space': '可用空间',
    'storage used space': '已用空间', 'record duration': '录像时长',
    'device manufacturer': '设备制造商', 'device model': '设备型号',
    'device serial number': '设备序列号', 'device id': '设备 ID',
    'current firmware version': '当前固件版本', 'serial number': '序列号',
    'camera control': '摄像头设置', 'indicator light': '指示灯',
    'memory card management': '存储卡管理', 'p2p stream': '视频流',
    'pp stream': '视频流', 'self check': '设备自检', cruise: '巡航',
    'camera fav area': '收藏区域', speaker: '声音', switch: '开关',
    toggle: '切换', reboot: '重启', power: '电源',
    'fan speed down': '风速降低', 'fan speed up': '风速提高',
    'temperature down': '温度降低', 'temperature up': '温度提高',
    'turn off': '关闭', 'turn on': '开启',
  };

  const VALUE_LABELS = {
    on: '开启', off: '关闭', auto: '自动', automatic: '自动',
    'all record': '全部录像', 'motion record': '移动侦测录像', 'no record': '不录像',
    low: '低', medium: '中', high: '高', normal: '正常', abnormal: '异常',
    untested: '未检测', tested: '已检测',
    'not exist': '未插入', full: '已满', broken: '已损坏', formating: '格式化中',
    formatting: '格式化中', eject: '已弹出', fixing: '修复中', ejecting: '弹出中',
    uninitialized: '未初始化', 'not enough space': '空间不足', 'file err': '文件错误',
    incompatible: '不兼容', 'sdcard state': '存储卡状态',
    'restore previous state': '恢复先前状态', 'ptz check': '云台检测',
    'pic detection': '画面检测', 'mic loop detection': '麦克风回环检测',
    'power detection': '电源检测', 'connection check': '连接检测',
    'surveillance check': '监控检测', 'record audio replay': '录音回放',
    'panoramic cruise': '全景巡航', 'fixed point cruise': '定点巡航',
    reading: '阅读', movie: '电影', music: '音乐', night: '夜间',
    cool: '制冷', dry: '除湿', heat: '制热', fan: '送风',
  };

  const CARD_METRIC_ORDER = [
    'temperature', 'current-temperature', 'target-temperature',
    'relative-humidity', 'target-humidity', 'battery-level',
    'power-consumption', 'brightness', 'water-level', 'filter-life-level',
  ];
  const CARD_OPTION_METRICS = new Set([
    'mode', 'status', 'charging-state', 'lock-state', 'door-state',
    'alarm-state', 'fault',
  ]);

  function normalizedText(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase('en-US')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function localizedText(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const translated = TEXT_LABELS[normalizedText(text)];
    if (translated) return translated;
    return /[A-Za-z]/.test(text) ? '' : text;
  }

  function optionLabel(item) {
    const description = String(item?.description ?? '').trim();
    const translated = VALUE_LABELS[normalizedText(description)];
    if (translated) return translated;
    return localizedText(description) || String(item?.value ?? '');
  }

  function arrayValueLabel(item) {
    if (item === undefined || item === null || typeof item === 'object') return '';
    const text = String(item).trim();
    if (!text || /^-?\d+(?:\.\d+)?$/.test(text)) return '';
    return VALUE_LABELS[normalizedText(text)] || localizedText(text) || '';
  }

  function formatArrayValue(value) {
    if (!Array.isArray(value)) return '';
    const labels = value.map(arrayValueLabel).filter(Boolean);
    return labels.length ? labels.join('、') : '—';
  }

  function formatCardMetric(def, value) {
    const option = def.options?.find(([key]) => String(key) === String(value));
    if (option) {
      const label = String(option[1] ?? '').trim();
      // Some vendor specs expose value lists without descriptions. Showing the
      // raw enum number on a card is noisier than omitting the metric.
      if (!CARD_OPTION_METRICS.has(def.suffix) || /^-?\d+(?:\.\d+)?$/.test(label)) {
        return '';
      }
      return `${def.label} ${label}`;
    }
    const numeric = typeof value === 'number'
      || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value));
    if (!numeric || !Number.isFinite(Number(value))) return '';
    if (!CARD_METRIC_ORDER.includes(def.suffix)) return '';
    return `${def.label} ${Number(value).toFixed(def.digits ?? 0)}${def.unit || ''}`;
  }

  function summarizeCardMetrics(profile, getValue) {
    const rank = (def) => {
      const index = CARD_METRIC_ORDER.indexOf(def.suffix);
      return index < 0 ? CARD_METRIC_ORDER.length : index;
    };
    return profile.metrics
      .filter((def) => !def.secondary)
      .map((def) => ({ def, value: getValue(def) }))
      .filter((item) => item.value !== undefined && item.value !== null)
      .sort((left, right) => rank(left.def) - rank(right.def))
      .map((item) => formatCardMetric(item.def, item.value))
      .filter(Boolean)
      .slice(0, 2)
      .join(' · ');
  }

  function kindSuffix(kind) {
    const text = String(kind || '');
    const parts = text.split(':').filter(Boolean);
    const marker = parts.findIndex((part) =>
      ['device', 'service', 'property', 'action'].includes(part));
    return (marker >= 0 ? parts[marker + 1] : parts.pop()) || text;
  }

  function propertyAccessible(property) {
    return !property.access?.length
      || property.access.includes('read')
      || property.access.includes('notify');
  }

  function propertyWritable(property) {
    return property.access?.includes('write') || false;
  }

  function propertyValueList(property) {
    return property.value_list || property['value-list'];
  }

  function propertyValueRange(property) {
    const raw = property.value_range || property['value-range'];
    if (Array.isArray(raw)) {
      return raw.length >= 2
        ? { min: raw[0], max: raw[1], step: raw[2] ?? 1 }
        : undefined;
    }
    return raw;
  }

  function propertyLabel(service, property) {
    const suffix = kindSuffix(property.kind || property.type);
    if (suffix === 'on' || suffix === 'switch-status') {
      const group = serviceGroup(service);
      if (group === '指示灯') return '指示灯';
      if (group === '摄像头设置') return '摄像头开关';
      return suffix === 'on' ? '开关' : '开关状态';
    }
    return PROPERTY_LABELS[suffix]
      || localizedText(property.description)
      || serviceGroup(service)
      || '属性';
  }

  function propertyIsKnown(service, property) {
    const suffix = kindSuffix(property.kind || property.type);
    if (suffix === 'on' || suffix === 'switch-status') return true;
    if (PROPERTY_LABELS[suffix]) return true;
    const description = localizedText(property.description);
    return Boolean(description && description !== serviceGroup(service));
  }

  function propertyUnit(service, property) {
    const suffix = kindSuffix(property.kind || property.type);
    const declared = normalizedText(property.unit);
    if (declared && Object.prototype.hasOwnProperty.call(UNIT_LABELS, declared)) {
      return UNIT_LABELS[declared];
    }
    if (suffix === 'temperature' || suffix === 'target-temperature' || suffix === 'ir-temperature') return '°C';
    if (suffix === 'relative-humidity' || suffix === 'battery-level' || suffix === 'brightness') return '%';
    if (suffix === 'color-temperature') return 'K';
    if (suffix === 'alarm-interval' || suffix === 'cruise-cycle') return '分钟';
    if (suffix === 'storage-total-space'
      || suffix === 'storage-free-space'
      || suffix === 'storage-used-space') return 'KB';
    if (suffix === 'record-duration') return '分钟';
    if (suffix === 'voltage') return 'V';
    if (suffix === 'electric-current') return 'mA';
    if (suffix === 'power-consumption') return 'W';
    return '';
  }

  function serviceGroup(service) {
    return SERVICE_GROUPS[kindSuffix(service.kind || service.type)]
      || localizedText(service.description)
      || '控制';
  }

  function profileFromSpec(spec) {
    const metrics = [];
    const controls = [];
    const actions = [];
    const seen = new Set();
    const seenMetrics = new Set();
    for (const service of spec.services || []) {
      const serviceName = kindSuffix(service.kind || service.type);
      if (serviceName === 'device-information') continue;
      const group = serviceGroup(service);
      for (const property of service.properties || []) {
        const key = `${service.iid}:${property.iid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const suffix = kindSuffix(property.kind || property.type);
        if (!propertyIsKnown(service, property)) continue;
        const label = propertyLabel(service, property);
        const unit = propertyUnit(service, property);
        const digits = unit === '°C' ? 1 : 0;
        const readable = propertyAccessible(property);
        const writable = propertyWritable(property);
        const options = propertyValueList(property)?.map((item) => [
          item.value,
          optionLabel(item),
        ]);
        if (writable && options?.length) {
          controls.push({
            type: 'segments', siid: service.iid, piid: property.iid, label,
            options, group, primary: suffix === 'on', readable,
          });
          continue;
        }
        if (writable && property.format === 'bool') {
          controls.push({
            type: 'toggle', siid: service.iid, piid: property.iid, label,
            group, primary: suffix === 'on', readable,
          });
          continue;
        }
        if (writable && propertyValueRange(property)) {
          const range = propertyValueRange(property);
          controls.push({
            type: 'range', siid: service.iid, piid: property.iid, label,
            min: range.min, max: range.max, step: range.step || 1,
            suffix: unit, group, readable,
          });
          continue;
        }
        if (readable) {
          const metricKey = `${group}\u0000${label}\u0000${suffix}\u0000${unit}`;
          if (seenMetrics.has(metricKey)) continue;
          seenMetrics.add(metricKey);
          metrics.push({
            siid: service.iid, piid: property.iid, label, suffix, unit, digits, options,
            secondary: serviceName === 'battery',
          });
        }
      }
      for (const action of service.actions || []) {
        if (action.inputs?.length) continue;
        actions.push({
          siid: service.iid,
          aiid: action.iid,
          label: localizedText(action.description)
            || TEXT_LABELS[normalizedText(kindSuffix(action.kind || action.type))]
            || '执行动作',
        });
      }
    }
    return {
      metrics,
      controls,
      actions,
      note: metrics.length || controls.length || actions.length ? '' : '设备规格中没有可用的属性或动作。',
    };
  }

  return {
    PROPERTY_LABELS,
    SERVICE_GROUPS,
    UNIT_LABELS,
    VALUE_LABELS,
    kindSuffix,
    propertyAccessible,
    propertyWritable,
    propertyLabel,
    propertyUnit,
    serviceGroup,
    optionLabel,
    formatArrayValue,
    localizedText,
    summarizeCardMetrics,
    profileFromSpec,
  };
});
