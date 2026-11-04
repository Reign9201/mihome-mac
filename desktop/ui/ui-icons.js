/* 线性图标，统一 24×24、1.5px 描边。 */
const ICONS = {
  grid: '<path d="M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z"/>',
  spark: '<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6L4.5 10.9 10.1 9 12 3.5Z"/><path d="M18.5 16.5v4M16.5 18.5h4"/>',
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3.1 2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.1M12 18.3v2.1M20.4 12h-2.1M5.7 12H3.6M17.9 6.1l-1.5 1.5M7.6 16.4l-1.5 1.5M17.9 17.9l-1.5-1.5M7.6 7.6 6.1 6.1"/>',
  menubar: '<rect x="3.2" y="4.5" width="17.6" height="15" rx="2.4"/><path d="M3.2 9h17.6M7 6.8h.1M9.6 6.8h.1"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.2"/><path d="m15.4 15.4 4.2 4.2"/>',
  power: '<path d="M12 3.8v8.1"/><path d="M7.3 6.4a7.6 7.6 0 1 0 9.4 0"/>',
  play: '<path d="M8.5 5.8 18 12l-9.5 6.2V5.8Z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  dock: '<path d="M4 18.5h16M6.5 18.5v-3.2h11v3.2M8.5 9.2h7M12 9.2V5.5"/>',
  sun: '<circle cx="12" cy="12" r="3.7"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M19 14.4A7.8 7.8 0 0 1 9.6 5a7.9 7.9 0 1 0 9.4 9.4Z"/>',
  drop: '<path d="M12 3.8c3.2 3.7 5.4 6.5 5.4 9.2a5.4 5.4 0 0 1-10.8 0c0-2.7 2.2-5.5 5.4-9.2Z"/>',
  wind: '<path d="M3.5 8.5h11a2.6 2.6 0 1 0-2.6-2.6M3.5 12.5h15a2.4 2.4 0 1 1-2.4 2.4M3.5 16.5h7.2"/>',
  thermometer: '<path d="M10 13.6V5.4a2 2 0 0 1 4 0v8.2a4.1 4.1 0 1 1-4 0Z"/><path d="M12 8.5v6.1"/>',
  bolt: '<path d="m13.2 2.8-7 10.4h5l-.6 8 7.2-10.6h-5.2l.6-7.8Z"/>',
  cloud: '<path d="M7.4 18.2h9.4a3.8 3.8 0 0 0 .4-7.6 5.4 5.4 0 0 0-10.4-1 4.4 4.4 0 0 0 .6 8.6Z"/>',
  light: '<path d="M9 17.2h6M9.8 20h4.4"/><path d="M8.2 14.2a5.2 5.2 0 1 1 7.6 0c-.8.8-1.2 1.5-1.3 2.2H9.5c-.1-.7-.5-1.4-1.3-2.2Z"/>',
  strip: '<path d="M3.5 9.5h17M3.5 14.5h17"/><path d="M6.5 9.5v5M12 9.5v5M17.5 9.5v5"/>',
  ac: '<rect x="3.2" y="4.8" width="17.6" height="8.6" rx="2"/><path d="M6.4 10h11.2M7.5 17c0 1.6 1.3 2.7 3 2.7M13.5 17c0 1.5 1.2 2.6 2.9 2.6M10.8 13.4v2.1"/>',
  curtain: '<path d="M3.5 4.5h17M5 4.5v14.8M19 4.5v14.8M8.2 4.5c0 4.3-1 7.4-2.2 9.2M15.8 4.5c0 4.3 1 7.4 2.2 9.2M12 4.5v14.8"/>',
  purifier: '<rect x="6.2" y="3.4" width="11.6" height="17.2" rx="3"/><circle cx="12" cy="10" r="3.2"/><path d="M10.3 10h3.4M12 8.3v3.4M8 17.4h8"/>',
  sensor: '<rect x="5" y="3.5" width="14" height="17" rx="2.6"/><path d="M9 8.2h6M12 8.2v4.2M10.4 14.6a2.2 2.2 0 1 0 3.2 0"/>',
  humidifier: '<path d="M7 8.2h10v9.2a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3V8.2Z"/><path d="M9 8.2V6.4a3 3 0 0 1 6 0v1.8M10 15.4c0-1.2.9-2.2 2-2.2s2 1 2 2.2"/>',
  plug: '<rect x="6.5" y="7" width="11" height="10.5" rx="2.4"/><path d="M9.5 7V4.2M14.5 7V4.2M12 7v3.4M9.5 11.4h5"/>',
  vacuum: '<circle cx="12" cy="13" r="7.2"/><path d="M9.5 13h5M12 10.5V13M12 6.2v-.8M5.6 9.8l1.3.7"/>',
  kitchen: '<path d="M4.5 10.5h15V19a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-8.5Z"/><path d="M8 10.5V6.8M12 10.5V5M16 10.5V6.8"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.6 4.5L19 6.8"/>',
  minus: '<path d="M5 12h14"/>',
  more: '<circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none"/>',
  fan: '<circle cx="12" cy="12" r="7.5"/><path d="M12 12c0-3 1.2-5.2 3-5.2s2.6 2.6-.8 4.2M12 12c-3 0-5.2 1.2-5.2 3s2.6 2.6 4.2-.8M12 12c0 3-1.2 5.2-3 5.2s-2.6-2.6.8-4.2"/>',
  auto: '<path d="M12 3.8 14.2 9l5.2.4-4 3.4 1.3 5.1-4.7-2.8-4.7 2.8L8.6 12.8l-4-3.4L9.8 9 12 3.8Z"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5M4.5 5v4h4"/><path d="M12 8.2V12l2.8 1.8"/>',
  camera: '<rect x="2.8" y="6.4" width="12.6" height="11.2" rx="2.4"/><path d="m15.4 10.4 5.3-2.7v8.6l-5.3-2.7"/>',
  volume: '<path d="M4.5 9.4h3l3.6-3v11.2l-3.6-3h-3z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  mic: '<rect x="9" y="3.6" width="6" height="10.4" rx="3"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7V21M9 21h6"/>',
  record: '<circle cx="12" cy="12" r="7.6"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  expand: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  shield: '<path d="M12 3.5 19 6v5.1c0 4.4-2.8 7.7-7 9.4-4.2-1.7-7-5-7-9.4V6l7-2.5Z"/><path d="m9 12 2.1 2.1L15.4 10"/>',
  up: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
  down: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
  left: '<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>',
  right: '<path d="M5 12h14M13.5 6.5 19 12l-5.5 5.5"/>',
};

function icon(name, cls = '') {
  const body = ICONS[name] || ICONS.grid;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function applyStaticIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });
}
