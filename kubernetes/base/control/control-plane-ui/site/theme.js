// Applies the saved light/dark theme before the first paint (classic
// script, loaded synchronously by index.html).
(function () {
  var theme = 'light';

  try {
    theme = localStorage.getItem('mtco.theme') || 'light';
  } catch (e) {
    // Storage blocked: keep the default.
  }

  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
})();
