// Theme toggle and copy buttons. No dependencies.
(function () {
  var root = document.documentElement;
  var KEY = 'orch-site-theme';
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function current() {
    return root.dataset.theme || (media.matches ? 'dark' : 'light');
  }

  var toggle = document.querySelector('[data-theme-toggle]');
  function label() {
    if (!toggle) return;
    toggle.setAttribute(
      'aria-label',
      current() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
  }
  if (toggle) {
    label();
    toggle.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Storage unavailable (private mode): the choice lasts for this page only.
      }
      label();
    });
    media.addEventListener('change', label);
  }

  var status = document.querySelector('.copied');
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var pre = document.getElementById(button.getAttribute('data-copy'));
      if (!pre || !navigator.clipboard) return;
      navigator.clipboard.writeText(pre.textContent.trim()).then(
        function () {
          button.textContent = 'Copied';
          button.setAttribute('data-done', '');
          if (status) status.textContent = 'Command copied to the clipboard.';
          setTimeout(function () {
            button.textContent = 'Copy';
            button.removeAttribute('data-done');
          }, 1800);
        },
        function () {
          if (status) status.textContent = 'Copy failed. Select the command and copy it by hand.';
        },
      );
    });
  });
})();
