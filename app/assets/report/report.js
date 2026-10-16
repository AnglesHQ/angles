/* eslint-env browser */
/*
 * Angles build report — client-side behaviour.
 *
 * Inlined into the report by index.pug, so the downloaded file works offline. Expanding
 * and collapsing is native <details>/<summary>; this script only adds the bulk controls,
 * the status / text filter, the screenshot viewer and print expansion.
 */
(() => {
  const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const setOpen = (elements, open) => elements.forEach((element) => {
    if (open) element.setAttribute('open', '');
    else element.removeAttribute('open');
  });

  const executions = all('.execution');
  const suites = all('.suite');
  const chips = all('.filter-chip');
  const search = document.getElementById('report-search');
  const emptyState = document.getElementById('report-empty');
  let activeStatus = 'ALL';

  const applyFilter = () => {
    const term = search ? search.value.trim().toLowerCase() : '';
    let visibleCount = 0;
    executions.forEach((execution) => {
      const statusMatch = activeStatus === 'ALL' || execution.dataset.status === activeStatus;
      const textMatch = !term || execution.dataset.search.includes(term);
      const visible = statusMatch && textMatch;
      execution.classList.toggle('is-filtered-out', !visible);
      if (visible) visibleCount += 1;
    });
    suites.forEach((suite) => {
      const hasVisible = suite.querySelector('.execution:not(.is-filtered-out)') !== null;
      suite.classList.toggle('is-filtered-out', !hasVisible);
    });
    if (emptyState) emptyState.hidden = visibleCount !== 0 || executions.length === 0;
  };

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      activeStatus = chip.dataset.status;
      chips.forEach((other) => other.setAttribute('aria-pressed', String(other === chip)));
      applyFilter();
    });
  });

  if (search) search.addEventListener('input', applyFilter);

  const onClick = (id, handler) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', handler);
  };

  onClick('expand-all', () => setOpen(all('.suite, .execution, .action'), true));
  onClick('collapse-all', () => setOpen(all('.execution, .action'), false));

  // Open only what explains the failures: every failed/errored test and, inside it, the
  // failed/errored actions. Everything else is closed so the failures stand out.
  onClick('expand-failures', () => {
    setOpen(all('.execution, .action'), false);
    const failing = all('.execution-fail, .execution-error');
    setOpen(failing, true);
    setOpen(failing.map((execution) => execution.closest('.suite')).filter(Boolean), true);
    failing.forEach((execution) => setOpen(all('.action-fail, .action-error', execution), true));
  });

  // ── Theme toggle ──────────────────────────────────────────────────────────
  // index.pug applies a remembered choice before first paint; this wires up the button.
  // With no choice made the report follows the OS, so the effective theme is read from the
  // attribute first and the media query second. A choice is remembered where storage is
  // available, and the report still works (for the session) where it is not.
  const THEME_KEY = 'angles-report-theme';
  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  const prefersDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const currentTheme = () => root.getAttribute('data-theme')
    || (prefersDark && prefersDark.matches ? 'dark' : 'light');

  const renderToggle = () => {
    if (!toggle) return;
    const dark = currentTheme() === 'dark';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.querySelector('.theme-toggle-icon').textContent = dark ? '\u2600' : '\u263E';
    toggle.querySelector('.theme-toggle-label').textContent = dark ? 'Light mode' : 'Dark mode';
  };

  if (toggle) {
    toggle.hidden = false;
    renderToggle();
    toggle.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {
        // Storage unavailable: the choice holds until the report is closed.
      }
      renderToggle();
    });
    // Until the viewer chooses, keep the label in step with the OS if it changes.
    if (prefersDark && prefersDark.addEventListener) {
      prefersDark.addEventListener('change', renderToggle);
    }
  }

  // ── Screenshot viewer ─────────────────────────────────────────────────────
  const viewer = document.getElementById('screenshot-viewer');
  let lastTrigger = null;

  const closeViewer = () => {
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
    if (lastTrigger) lastTrigger.focus();
  };

  if (viewer) {
    const viewerImage = viewer.querySelector('img');
    const viewerCaption = viewer.querySelector('.viewer-caption');
    all('.step-shot').forEach((button) => {
      button.addEventListener('click', () => {
        const image = button.querySelector('img');
        if (!image) return;
        lastTrigger = button;
        viewerImage.src = image.src;
        viewerImage.alt = image.alt;
        viewerCaption.textContent = image.alt;
        viewer.hidden = false;
        viewer.focus();
      });
    });
    viewer.addEventListener('click', closeViewer);
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeViewer();
  });

  // ── Print: expand everything, then restore what the reader had open ───────
  let openBeforePrint = null;
  // Paper is white, so a dark report is printed in the light theme and put back after.
  let themeBeforePrint = null;
  let printing = false;
  window.addEventListener('beforeprint', () => {
    openBeforePrint = all('details').filter((details) => details.open);
    setOpen(all('details'), true);
    printing = true;
    themeBeforePrint = root.getAttribute('data-theme');
    root.setAttribute('data-theme', 'light');
  });
  window.addEventListener('afterprint', () => {
    if (printing) {
      printing = false;
      if (themeBeforePrint === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', themeBeforePrint);
      renderToggle();
    }
    if (!openBeforePrint) return;
    setOpen(all('details'), false);
    setOpen(openBeforePrint, true);
    openBeforePrint = null;
  });
})();
