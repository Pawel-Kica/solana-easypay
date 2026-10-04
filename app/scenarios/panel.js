// Runs in the app page before the app (Playwright addInitScript), on every load. play.mjs prepends
// window.__PLAY = { webPort, accounts }. It seeds the fixed test accounts, records toasts for the checks, and draws
// the Play panel on the right. The panel talks to play.mjs through window.__play(command, arg), and play.mjs redraws
// it with window.__playRender(state).
(() => {
  const { webPort, accounts } = window.__PLAY;
  if (location.port !== String(webPort) || window.top !== window) return;

  // The scenario accounts, before the app generates random ones.
  if (!localStorage.getItem('easypay.testAccounts')) localStorage.setItem('easypay.testAccounts', JSON.stringify(accounts));
  localStorage.setItem('easypay.network', 'Local');

  // Every toast the app shows, in order: { title, error }. Checks wait for the first one after an action.
  window.__playToasts = [];
  new MutationObserver((records) => {
    for (const r of records)
      for (const node of r.addedNodes) {
        if (!(node instanceof HTMLElement) || node.getAttribute('role') !== 'status') continue;
        const title = node.querySelector('p')?.textContent ?? node.textContent;
        window.__playToasts.push({ title, error: node.className.includes('border-red') });
      }
  }).observe(document, { childList: true, subtree: true });

  const WIDTH = 380;
  const css = `
    html { margin-right: ${WIDTH}px !important; }
    .fixed.inset-x-0, .fixed.inset-0 { right: ${WIDTH}px !important; }
    .fixed.right-4 { right: calc(${WIDTH}px + 1rem) !important; }
    .play-mark { outline: 3px solid #FFD400 !important; outline-offset: 3px; border-radius: 12px; transition: outline 0.2s; }
  `;

  const panelCss = `
    :host { all: initial; }
    .panel { position: fixed; top: 0; right: 0; bottom: 0; width: ${WIDTH}px; z-index: 2147483647; display: flex;
      flex-direction: column; background: #0b0b0d; color: #eee; border-left: 1px solid #ffffff1f;
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 10px; }
    h1 { font-size: 15px; margin: 0; font-weight: 600; color: #FFD400; letter-spacing: .02em; }
    .pill { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #ffffff14; }
    .pill.running, .pill.resetting { background: #9945FF33; color: #cdb0ff; }
    .pill.passed { background: #40B66B33; color: #6fe09a; }
    .pill.failed { background: #ef444433; color: #fca5a5; }
    .pill.paused, .pill.stopped { background: #f59e0b33; color: #fcd34d; }
    .list { overflow-y: auto; max-height: 40%; padding: 0 8px; border-bottom: 1px solid #ffffff14; }
    .group { color: #ffffff66; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin: 10px 8px 4px; }
    .item { display: block; width: 100%; text-align: left; background: none; border: 0; color: #ddd; padding: 6px 8px;
      border-radius: 8px; cursor: pointer; font: inherit; }
    .item:hover { background: #ffffff0d; }
    .item.selected { background: #9945FF2e; color: #fff; }
    .item:disabled { cursor: default; }
    .summary { padding: 10px 16px 0; color: #ffffffa0; min-height: 36px; }
    .controls { display: flex; gap: 6px; padding: 10px 16px; }
    .controls button { flex: 1; height: 34px; border-radius: 10px; border: 1px solid #ffffff26; background: #ffffff0d;
      color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .controls button.primary { background: #9945FF; border-color: #9945FF; }
    .controls button:disabled { opacity: .35; cursor: default; }
    .step { margin: 0 16px; padding: 12px; border-radius: 12px; background: #ffffff0a; min-height: 52px; }
    .step .n { font-size: 11px; color: #ffffff70; }
    .step .t { font-size: 14px; margin-top: 2px; }
    .error { margin: 10px 16px 0; padding: 10px 12px; border-radius: 12px; background: #ef44441f; color: #fecaca;
      white-space: pre-wrap; word-break: break-word; }
    .log { flex: 1; overflow-y: auto; padding: 8px 16px 16px; }
    .log div { padding: 2px 0; word-break: break-word; }
    .log .step-line { color: #ffffffd0; margin-top: 4px; }
    .log .ok { color: #6fe09a; } .log .bad { color: #fca5a5; } .log .info { color: #ffffff70; }
  `;

  let state = null;
  let root;
  let shownSelected;

  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'disabled') el.disabled = v;
      else el.setAttribute(k, v);
    }
    el.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  };
  const send = (command, arg) => window.__play?.(command, arg);

  const STATUS = {
    idle: 'Ready',
    resetting: 'Resetting',
    running: 'Playing',
    paused: 'Paused',
    stopping: 'Stopping',
    stopped: 'Stopped',
    passed: 'Passed',
    failed: 'Failed',
  };

  function render() {
    if (!root || !state) return;
    const busy = ['resetting', 'running', 'stopping'].includes(state.status);
    const active = busy || state.status === 'paused';
    const selected = state.scenarios.find((s) => s.id === state.selected);
    const groups = [...new Set(state.scenarios.map((s) => s.side))];
    const listScroll = root.querySelector('.list')?.scrollTop ?? 0;

    const panel = h(
      'div',
      { class: 'panel' },
      h('header', {}, h('h1', {}, '▶ Play'), h('span', { class: `pill ${state.status}` }, STATUS[state.status])),
      h(
        'div',
        { class: 'list' },
        ...groups.flatMap((side) => [
          h('div', { class: 'group' }, side),
          ...state.scenarios
            .filter((s) => s.side === side)
            .map((s) =>
              h(
                'button',
                {
                  class: `item${s.id === state.selected ? ' selected' : ''}`,
                  disabled: active,
                  onclick: () => send('select', s.id),
                },
                s.title,
              ),
            ),
        ]),
      ),
      h('div', { class: 'summary' }, selected?.summary ?? ''),
      h(
        'div',
        { class: 'controls' },
        state.status === 'paused'
          ? h('button', { class: 'primary', onclick: () => send('resume') }, '▶ Resume')
          : h('button', { class: 'primary', disabled: busy, onclick: () => send('play') }, '▶ Play'),
        h('button', { disabled: state.status !== 'running', onclick: () => send('pause') }, '⏸ Pause'),
        h('button', { disabled: !active, onclick: () => send('stop') }, '■ Stop'),
      ),
      h(
        'div',
        { class: 'step' },
        h('div', { class: 'n' }, state.current ? `Step ${state.current.index} of ${state.current.total}` : 'No scenario running'),
        h('div', { class: 't' }, state.current?.text ?? 'Pick a scenario and press Play. Every Play starts on a fresh chain.'),
      ),
      state.error && h('div', { class: 'error' }, state.error),
      h(
        'div',
        { class: 'log' },
        ...state.log.map((l) =>
          h(
            'div',
            { class: l.kind === 'step' ? 'step-line' : l.kind === 'check' ? (l.ok ? 'ok' : 'bad') : l.kind === 'error' ? 'bad' : 'info' },
            l.kind === 'check' ? `${l.ok ? '✓' : '✗'} ${l.text}` : l.kind === 'step' ? `${l.index}. ${l.text}` : l.text,
          ),
        ),
      ),
    );
    root.replaceChildren(h('style', {}, panelCss), panel);
    root.querySelector('.list').scrollTop = listScroll;
    // Keeps the picked scenario in view, also when play.mjs picks it (--run).
    if (state.selected !== shownSelected) root.querySelector('.item.selected')?.scrollIntoView({ block: 'nearest' });
    shownSelected = state.selected;
    const log = root.querySelector('.log');
    log.scrollTop = log.scrollHeight;
  }

  window.__playRender = (next) => {
    state = next;
    render();
  };

  // Outlines the element the next action uses, so a viewer can follow the clicks.
  window.__playMark = (el) => {
    el.classList.add('play-mark');
    setTimeout(() => el.classList.remove('play-mark'), 900);
  };

  const mount = () => {
    document.head.append(h('style', {}, css));
    const host = h('div', { id: 'easypay-play' });
    document.documentElement.append(host);
    root = host.attachShadow({ mode: 'open' });
    send('ready');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
