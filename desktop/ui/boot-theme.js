// 在首屏绘制前把存下来的外观设置落到 <html> 和 <meta name="color-scheme"> 上，
// 否则钉死深色的用户会先看到一帧浅色。逻辑要和 app.js 的 applyTheme 保持一致。
(() => {
  const stored = localStorage.getItem('mihome-theme');
  const pinned = stored === 'light' || stored === 'dark';
  const scheme = pinned
    ? stored
    : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = scheme;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.content = pinned ? stored : 'light dark';

  // body 上那份是给 [data-style][data-theme] 这类同元素组合选择器用的，
  // 这时 body 还没解析出来，等它有了再补。app.js 起来后会写同一个值。
  document.addEventListener('DOMContentLoaded', () => {
    if (document.body && !document.body.dataset.theme) document.body.dataset.theme = scheme;
  });
})();
