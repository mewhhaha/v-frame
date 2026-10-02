/** Native controls exercise browser semantics, not a fixture's reimplementation of them. */
export const interactionLab = `<!doctype html><html lang="en"><head>
  <title>Interaction lab</title>
  <style>
    body { margin: 0; font: 16px system-ui; color: #111; background: white; }
    main { display: grid; gap: 12px; padding: 16px; }
    h1, h2, p { margin: 0; }
    label, input, button, select { font: inherit; }
    button, input, select { padding: 6px; }
    :focus-visible { outline: 3px solid #0645ad; outline-offset: 2px; }
    [popover] { position: fixed; inset: auto; margin: 0; padding: 16px; width: 240px; border: 1px solid #111; background: white; color: #111; }
    [popover] > :not([popover]) { display: block; margin-bottom: 8px; }
    dialog { padding: 16px; border: 1px solid #111; background: white; color: #111; }
    dialog::backdrop { background: rgb(0 0 0 / 50%); }
    [hidden] { display: none !important; }
  </style>
</head><body><main>
  <h1>Workspace settings</h1>
  <form id="settings">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" required aria-describedby="email-help">
    <p id="email-help">Used for delivery updates.</p>
    <button id="save" type="submit">Save settings</button>
    <p id="result" role="status" aria-live="polite"></p>
  </form>
  <label><input id="updates" type="checkbox" role="switch">Delivery updates</label>
  <fieldset><legend>Delivery speed</legend>
    <label><input type="radio" name="speed" value="standard" checked>Standard</label>
    <label><input type="radio" name="speed" value="express">Express</label>
  </fieldset>
  <label for="region">Region</label>
  <select id="region"><option>Europe</option><option>Americas</option></select>
  <button id="info-trigger" popovertarget="info">Delivery details</button>
  <div id="info" popover="auto" role="dialog" aria-labelledby="info-title" aria-describedby="info-description">
    <h2 id="info-title">Delivery details</h2>
    <p id="info-description">Change delivery instructions.</p>
    <label for="instructions">Instructions</label><input id="instructions" autofocus>
    <button id="nested-trigger" popovertarget="nested">More details</button>
    <button popovertarget="info" popovertargetaction="hide">Close details</button>
    <div id="nested" popover="auto" role="dialog" aria-labelledby="nested-title">
      <h2 id="nested-title">Extra delivery details</h2>
      <button id="nested-close" autofocus popovertarget="nested" popovertargetaction="hide">Close extra details</button>
    </div>
  </div>
  <button id="manual-trigger">Pinned details</button>
  <div id="manual" popover="manual" role="dialog" aria-labelledby="manual-title">
    <h2 id="manual-title">Pinned delivery details</h2><button id="manual-close">Close pinned details</button>
  </div>
  <button id="modal-trigger">Edit delivery</button>
  <dialog id="modal" aria-labelledby="modal-title" aria-describedby="modal-description">
    <h2 id="modal-title">Edit delivery</h2><p id="modal-description">Confirm the delivery name.</p>
    <form method="dialog"><label for="delivery-name">Delivery name</label><input id="delivery-name" autofocus>
      <button value="cancel">Cancel edit</button><button value="confirm">Confirm edit</button>
    </form>
  </dialog>
  <details><summary>Advanced settings</summary><button>Reset settings</button></details>
  <button disabled>Unavailable action</button><button hidden>Hidden action</button>
  <div inert><button>Inert action</button></div>
  <button id="last">Last guest action</button>
</main><script>
  window.interactions = [];
  const record = (type, event) => window.interactions.push({type, target: event.target.id});
  document.addEventListener('focusin', event => record('focusin', event));
  document.addEventListener('input', event => record('input', event));
  document.addEventListener('change', event => record('change', event));
  document.querySelector('#settings').addEventListener('submit', event => {
    event.preventDefault();
    document.querySelector('#result').textContent = 'Saved ' + new FormData(event.target).get('email');
  });
  const info = document.querySelector('#info');
  const nested = document.querySelector('#nested');
  const position = (popover, trigger) => {
    const rect = trigger.getBoundingClientRect();
    popover.style.left = rect.left + 'px';
    popover.style.top = rect.bottom + 8 + 'px';
  };
  info.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') position(info, document.querySelector('#info-trigger'));
  });
  info.addEventListener('toggle', event => {
    if (event.newState === 'closed' && info.contains(document.activeElement)) document.querySelector('#info-trigger').focus();
  });
  nested.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') position(nested, document.querySelector('#nested-trigger'));
  });
  let nestedKeyboardDismiss = false;
  nested.addEventListener('keydown', event => {
    if (event.key === 'Escape') nestedKeyboardDismiss = true;
  });
  nested.addEventListener('toggle', event => {
    if (event.newState === 'closed' && (nestedKeyboardDismiss || nested.contains(document.activeElement))) document.querySelector('#nested-trigger').focus();
    nestedKeyboardDismiss = false;
  });
  const manual = document.querySelector('#manual');
  const manualTrigger = document.querySelector('#manual-trigger');
  manualTrigger.addEventListener('click', () => {
    position(manual, manualTrigger);
    manual.showPopover();
    document.querySelector('#manual-close').focus();
  });
  document.querySelector('#manual-close').addEventListener('click', () => {
    manual.hidePopover();
    manualTrigger.focus();
  });
  document.querySelector('#modal-trigger').addEventListener('click', () => document.querySelector('#modal').showModal());
</script></body></html>`;
