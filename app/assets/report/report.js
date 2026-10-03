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
  window.addEventListener('beforeprint', () => {
    openBeforePrint = all('details').filter((details) => details.open);
    setOpen(all('details'), true);
  });
  window.addEventListener('afterprint', () => {
    if (!openBeforePrint) return;
    setOpen(all('details'), false);
    setOpen(openBeforePrint, true);
    openBeforePrint = null;
  });
})();
