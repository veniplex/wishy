// Set theme and language before the first paint so nothing flashes (see src/theme.ts).
// Kept as a separate file so the Content-Security-Policy (script-src 'self') does not need to allow an inline script.
try {
  var m = localStorage.getItem('theme')
  var d = document.documentElement
  if (m === 'light' || m === 'dark') d.setAttribute('data-theme', m)
  // Language (see src/i18n): remembered choice, otherwise browser language; otherwise lang stays as in index.html until the app knows the admin default
  var l = localStorage.getItem('locale') || (navigator.language || '').slice(0, 2)
  if (l === 'de' || l === 'en') d.setAttribute('lang', l)
  var dark = m === 'dark' || (m !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#1b1715' : '#fbf6f0')
} catch (e) {}
