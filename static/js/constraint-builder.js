/* ─────────────────────────────────────────────────────────────────────────
 * constraint-builder.js
 *
 * Self-contained overlay for visually building constraints over a running
 * web app. Inject via a single <script> tag — the panel appears in the
 * top-right corner of the page.
 *
 * Workflow:
 *   1. Click "Select action" → pick the element that triggers the behaviour
 *      (a button, input, …). Cursor turns into a crosshair; hovering shows
 *      a dashed outline; clicking captures `e.target.id`.
 *   2. Click "+ Add target" → pick one or more elements that should change
 *      as a result of the action.
 *   3. Click "Save constraint" → the constraint string
 *        P(w(target1) AND w(target2) … | A(action)) = 1
 *      is built automatically and appended to the saved list.
 *   4. Switch to the Review tab and click "Export JSON" to download every
 *      saved constraint along with its human-readable labels.
 *
 * Element IDs (e.g. `cv_0001`) are required on every clickable element —
 * generate them with the project's `inject_ids` pre-processing step.
 * Display labels are derived from `innerText` and are purely cosmetic.
 *
 * Implementation notes:
 *   • Single IIFE, no globals other than `window.__constraintBuilder`.
 *   • All highlighting / click capture is torn down when selection mode
 *     exits or the user hits Escape.
 *   • Saved constraints persist across reloads via localStorage.
 *   • All UI styles are scoped to `#__constraint_builder_panel` and its
 *     descendants — the app's own CSS is untouched.
 * ─────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  if (window.__constraintBuilder) {
    console.warn('[constraint-builder] already initialised — skipping');
    return;
  }

  // ── Constants ─────────────────────────────────────────────────────────
  const PANEL_ID    = '__constraint_builder_panel';
  const STYLE_ID    = '__constraint_builder_styles';
  const STORAGE_KEY = '__constraint_builder_saved';
  const HL_COLOR    = '#0f766e';
  const LABEL_MAX   = 25;

  // ── State ─────────────────────────────────────────────────────────────
  const state = {
    action:       null,     // { id, label } | null
    targets:      [],       // [{ id, label, op, kind }]   kind: "ui" | "api"
    saved:        [],       // [{ constraint, action, targets, created_at }]
    mode:         'build',  // 'build' | 'review'
    status:       null,     // { kind: 'error' | 'info', text }
    selecting:    false,    // selection mode active?
    pickingKind:  null,     // 'action' | 'target' | null — which button is in pick mode
    visualizingIdx: null,   // index of saved constraint currently visualized (arrows on page), or null
    confirmClear: false,    // "Clear all" two-click confirmation latch
    apis:         [],       // [{ id, endpoint, method, file, line }]
    storage:      [],       // [{ id, area, key, ops, file, line }]
    elements:     [],       // [{ id, label }] — for the value picker's element dropdown
  };

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.saved)); }
    catch (e) { /* private mode etc — drop silently */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      state.saved = raw ? JSON.parse(raw) : [];
    } catch (e) { state.saved = []; }
  }

  // ── Display labels ────────────────────────────────────────────────────
  // Prefer the data-cv-label baked in during preprocessing — those are
  // stable. Fall back to live innerText when the element wasn't tagged.
  function getDisplayLabel(el) {
    const baked = (el.dataset && el.dataset.cvLabel) || '';
    const text  = baked || (el.innerText || '').trim().slice(0, LABEL_MAX);
    return text ? `${el.id} (${text})` : el.id;
  }

  // ── Constraint formula ────────────────────────────────────────────────
  // *targets* is the full state.targets array. Each target has:
  //   { id, label, op, kind, source, source_literal, source_element_id, source_element_label }
  //   kind:   "ui" | "api"
  //   source: "any" | "literal" | "element" | "api"   (UI targets only)
  // UI targets render as:
  //   any      → w(id)
  //   literal  → w(id, <number or "string">)
  //   element  → w(id, r(other_id))
  //   api      → w(id, r(api_result))
  // API targets render as call(id) regardless of source.
  // targets[0].op is unused; targets[i].op for i > 0 joins target i-1 to i.
  function targetFormula(t) {
    if (t.kind === 'api') return `call(${t.id})`;
    const valueExpr = renderValueExpr(t);
    return valueExpr ? `w(${t.id}, ${valueExpr})` : `w(${t.id})`;
  }

  // Render the value_expr piece based on the target's value source. Returns
  // null when source is "any" (or absent), in which case w(id) is emitted
  // without a value_expr.
  function renderValueExpr(t) {
    switch (t.source) {
      case 'literal': {
        const raw = (t.source_literal == null) ? '' : String(t.source_literal);
        // Bare number → emit unquoted; everything else → quoted string.
        // Negative numbers and decimals both count as numeric.
        return /^-?\d+(\.\d+)?$/.test(raw.trim())
          ? raw.trim()
          : `"${raw.replace(/"/g, '\\"')}"`;
      }
      case 'element':
        return t.source_element_id ? `r(${t.source_element_id})` : null;
      case 'api':
        return `r(api_result)`;
      case 'any':
      default:
        return null;
    }
  }

  function buildConstraint(actionId, targets) {
    if (!actionId || targets.length === 0) return null;
    let writes = targetFormula(targets[0]);
    for (let i = 1; i < targets.length; i++) {
      const op = targets[i].op || 'AND';
      writes = `${writes} ${op} ${targetFormula(targets[i])}`;
    }
    return `P(${writes} | A(${actionId})) = 1`;
  }

  // ── Styles (scoped to the panel) ──────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        width: 340px;
        max-height: calc(100vh - 32px);
        background: #fbfaf7;
        border: 1px solid #ddd8d0;
        border-radius: 6px;
        box-shadow: 0 10px 28px rgba(28,25,23,0.14);
        font-family: "Source Sans 3", "Segoe UI", system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        color: #1c1917;
        z-index: 999999;
        display: flex;
        flex-direction: column;
      }
      #${PANEL_ID} * { box-sizing: border-box; }

      #${PANEL_ID} .__cb_header {
        background: #134e4a;
        color: #f5f4f1;
        padding: 8px 12px;
        border-radius: 5px 5px 0 0;
        cursor: move;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 600;
        user-select: none;
      }
      #${PANEL_ID} .__cb_close {
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 2px 6px;
        border-radius: 4px;
      }
      #${PANEL_ID} .__cb_close:hover { background: rgba(255,255,255,0.18); }

      #${PANEL_ID} .__cb_tabs {
        display: flex;
        border-bottom: 1px solid #ddd8d0;
      }
      #${PANEL_ID} .__cb_tabs button {
        flex: 1;
        padding: 8px 10px;
        background: #f0eeea;
        border: none;
        border-right: 1px solid #ddd8d0;
        cursor: pointer;
        font: inherit;
        color: #6b6560;
        font-weight: 500;
      }
      #${PANEL_ID} .__cb_tabs button:last-child { border-right: none; }
      #${PANEL_ID} .__cb_tabs button._active {
        background: #fbfaf7;
        color: #1c1917;
        font-weight: 600;
        box-shadow: inset 0 -2px 0 ${HL_COLOR};
      }

      #${PANEL_ID} .__cb_body {
        padding: 12px;
        overflow-y: auto;
        flex: 1;
      }
      #${PANEL_ID} .__cb_section_label {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .07em;
        text-transform: uppercase;
        color: #6b6560;
        margin: 0 0 6px 0;
      }
      #${PANEL_ID} .__cb_section { margin-bottom: 14px; }

      #${PANEL_ID} .__cb_chip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 6px 8px;
        background: #f0eeea;
        border: 1px solid #ddd8d0;
        border-radius: 5px;
        margin-bottom: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        word-break: break-all;
      }
      #${PANEL_ID} .__cb_chip ._remove {
        cursor: pointer;
        color: #a8a29e;
        font-weight: 700;
        padding: 0 4px;
        flex-shrink: 0;
      }
      #${PANEL_ID} .__cb_chip ._remove:hover { color: #dc2626; }

      #${PANEL_ID} .__cb_target_block {
        margin-bottom: 6px;
      }
      #${PANEL_ID} .__cb_target_block .__cb_chip {
        margin-bottom: 2px;
      }
      #${PANEL_ID} .__cb_value_row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-left: 12px;
        font-size: 11px;
        color: #57534e;
      }
      #${PANEL_ID} .__cb_value_row::before {
        content: "↳";
        color: #a8a29e;
        margin-right: 2px;
      }
      #${PANEL_ID} .__cb_value_row_api { font-style: italic; color: #a8a29e; }
      #${PANEL_ID} .__cb_value_label { color: #6b6560; }
      #${PANEL_ID} .__cb_value_source {
        font: inherit;
        font-size: 11px;
        background: #fbfaf7;
        border: 1px solid #ddd8d0;
        border-radius: 4px;
        padding: 1px 4px;
        cursor: pointer;
        color: ${HL_COLOR};
        font-weight: 600;
      }
      #${PANEL_ID} .__cb_value_input {
        font: inherit;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        border: 1px solid #ddd8d0;
        border-radius: 4px;
        padding: 1px 5px;
        min-width: 110px;
        max-width: 180px;
      }
      #${PANEL_ID} select.__cb_value_input { font-family: inherit; }

      #${PANEL_ID} .__cb_op_row {
        display: flex;
        align-items: center;
        margin: 2px 0 2px 12px;
      }
      #${PANEL_ID} .__cb_op_row::before {
        content: "";
        display: inline-block;
        width: 10px;
        border-top: 1px dashed #ddd8d0;
        margin-right: 6px;
      }
      #${PANEL_ID} .__cb_op_select {
        font: inherit;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .04em;
        background: #fbfaf7;
        color: ${HL_COLOR};
        border: 1px solid #ddd8d0;
        border-radius: 4px;
        padding: 1px 4px;
        cursor: pointer;
      }
      #${PANEL_ID} .__cb_op_select:hover { border-color: ${HL_COLOR}; }

      #${PANEL_ID} .__cb_empty {
        font-size: 12px;
        color: #a8a29e;
        font-style: italic;
        margin-bottom: 6px;
      }

      #${PANEL_ID} .__cb_btn {
        font: inherit;
        background: #fbfaf7;
        border: 1px solid #ddd8d0;
        color: #1c1917;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
      }
      #${PANEL_ID} .__cb_btn:hover { background: #f0eeea; }
      #${PANEL_ID} .__cb_btn._primary {
        background: ${HL_COLOR};
        color: #fff;
        border-color: ${HL_COLOR};
      }
      #${PANEL_ID} .__cb_btn._primary:hover { background: #115e59; }
      #${PANEL_ID} .__cb_btn._danger {
        background: #ffffff;
        color: #b91c1c;
        border-color: #fca5a5;
      }
      #${PANEL_ID} .__cb_btn._danger:hover { background: #fef2f2; }
      #${PANEL_ID} .__cb_btn:disabled { opacity: .5; cursor: not-allowed; }
      #${PANEL_ID} .__cb_btn._small { padding: 4px 10px; font-size: 12px; }
      #${PANEL_ID} .__cb_btn._picking {
        background: ${HL_COLOR};
        color: #ffffff;
        border-color: ${HL_COLOR};
        font-weight: 600;
        box-shadow: 0 0 0 2px rgba(15,118,110,0.25);
      }
      #${PANEL_ID} .__cb_btn._picking:hover { background: #115e59; border-color: #115e59; }

      #${PANEL_ID} .__cb_btn_row { display: flex; gap: 6px; }

      #${PANEL_ID} .__cb_preview {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        background: #1c1917;
        color: #f5f4f1;
        padding: 8px 10px;
        border-radius: 6px;
        white-space: pre-wrap;
        word-break: break-all;
        margin-bottom: 8px;
        min-height: 38px;
      }
      #${PANEL_ID} .__cb_preview._empty { color: #a8a29e; font-family: inherit; font-style: italic; }

      #${PANEL_ID} .__cb_status {
        padding: 7px 12px;
        border-top: 1px solid #ddd8d0;
        font-size: 12px;
      }
      #${PANEL_ID} .__cb_status._error { color: #b91c1c; background: #fef2f2; }
      #${PANEL_ID} .__cb_status._info  { color: #115e59; background: #e4f2f0; }

      #${PANEL_ID} .__cb_saved_item {
        border: 1px solid #ddd8d0;
        border-radius: 6px;
        padding: 8px 10px;
        margin-bottom: 6px;
      }
      #${PANEL_ID} .__cb_saved_head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      #${PANEL_ID} .__cb_saved_idx {
        font-size: 11px;
        color: #6b6560;
        font-weight: 600;
      }
      #${PANEL_ID} .__cb_saved_formula {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        word-break: break-all;
      }
      #${PANEL_ID} .__cb_saved_labels {
        font-size: 11px;
        color: #6b6560;
        margin-top: 4px;
      }

      .__cb_highlight {
        outline: 3px solid #0f766e !important;
        outline-offset: 2px !important;
        background-color: rgba(15,118,110,0.14) !important;
        box-shadow: 0 0 0 4px rgba(15,118,110,0.14) !important;
        transition: outline-color 0.08s, background-color 0.08s !important;
      }

      /* Visualization overlay — highlights action + target elements while
         a saved constraint is being visualized. */
      .__cb_viz_hl {
        outline-offset: 2px !important;
        transition: outline-color 0.1s, background-color 0.1s !important;
      }
      .__cb_viz_hl._action {
        outline: 3px solid #0f766e !important;
        background-color: rgba(15,118,110,0.12) !important;
      }
      .__cb_viz_hl._target {
        outline: 3px solid #44403c !important;
        background-color: rgba(68,64,60,0.10) !important;
      }

      /* ── Detected APIs / Storage lanes ─────────────────────────────── */
      #${PANEL_ID} .__cb_lane_row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border: 1px solid #ddd8d0;
        border-radius: 5px;
        margin-bottom: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        background: #fbfaf7;
        cursor: pointer;
        word-break: break-all;
      }
      #${PANEL_ID} .__cb_lane_row:hover { background: #f0eeea; border-color: #c5bfb4; }
      #${PANEL_ID} .__cb_lane_row._disabled {
        opacity: .6;
        cursor: not-allowed;
        font-style: italic;
      }
      #${PANEL_ID} .__cb_lane_icon {
        font-size: 12px;
        flex-shrink: 0;
      }
      #${PANEL_ID} .__cb_lane_method {
        font-size: 10px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 3px;
        background: #e4f2f0;
        color: #115e59;
        flex-shrink: 0;
      }
      #${PANEL_ID} .__cb_lane_method._GET    { background: #dcfce7; color: #166534; }
      #${PANEL_ID} .__cb_lane_method._POST   { background: #fef3c7; color: #92400e; }
      #${PANEL_ID} .__cb_lane_method._PUT    { background: #e4f2f0; color: #115e59; }
      #${PANEL_ID} .__cb_lane_method._DELETE { background: #fee2e2; color: #991b1b; }
      #${PANEL_ID} .__cb_lane_id {
        color: #1c1917;
        font-weight: 600;
      }
      #${PANEL_ID} .__cb_lane_path {
        color: #6b6560;
        flex: 1;
        text-align: right;
      }
      #${PANEL_ID} .__cb_lane_note {
        font-size: 11px;
        color: #a8a29e;
        margin: 0 0 6px 0;
        font-style: italic;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Panel construction ────────────────────────────────────────────────
  let panel;
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }

  // ── Rendering ─────────────────────────────────────────────────────────
  function render() {
    if (!panel) return;
    panel.innerHTML = `
      <div class="__cb_header" data-role="drag">
        <span>Flowcheck</span>
        <span class="__cb_close" data-action="close" title="Close">×</span>
      </div>
      <div class="__cb_tabs">
        <button data-action="mode" data-mode="build"  class="${state.mode === 'build'  ? '_active' : ''}">Build</button>
        <button data-action="mode" data-mode="review" class="${state.mode === 'review' ? '_active' : ''}">Review (${state.saved.length})</button>
      </div>
      <div class="__cb_body">
        ${state.mode === 'build' ? renderBuild() : renderReview()}
      </div>
      ${renderStatus()}
    `;

    // Wire up event delegation each render (innerHTML wipes listeners).
    panel.addEventListener('click',  onPanelClick);
    panel.addEventListener('change', onPanelChange);
    panel.addEventListener('input',  onPanelInput);
    const header = panel.querySelector('.__cb_header');
    if (header) header.addEventListener('mousedown', startDrag);
  }

  // Fires on every keystroke for text inputs. We only care about the
  // literal value input — update state and refresh just the preview so
  // the input retains focus.
  function onPanelInput(e) {
    if (e.target.tagName !== 'INPUT') return;
    if (e.target.dataset.action !== 'change_literal') return;
    const idx = Number(e.target.dataset.idx);
    const t = state.targets[idx];
    if (!t) return;
    t.source_literal = e.target.value;
    renderPreviewOnly();
  }

  function renderBuild() {
    const a  = state.action;
    const ts = state.targets;
    const preview = buildConstraint(a && a.id, ts);

    const actionRow = a
      ? `<div class="__cb_chip">
           <span>${escapeHtml(a.label)}</span>
           <span class="_remove" data-action="clear_action" title="Remove">×</span>
         </div>`
      : `<div class="__cb_empty">No action selected.</div>`;

    const opSelect = (idx, current) => `
      <div class="__cb_op_row">
        <select class="__cb_op_select" data-action="change_op" data-idx="${idx}">
          <option value="AND" ${current === 'AND' ? 'selected' : ''}>AND</option>
          <option value="OR"  ${current === 'OR'  ? 'selected' : ''}>OR</option>
          <option value="XOR" ${current === 'XOR' ? 'selected' : ''}>XOR</option>
        </select>
      </div>`;

    const targetRows = ts.length
      ? ts.map((t, i) => `
          ${i > 0 ? opSelect(i, t.op || 'AND') : ''}
          ${renderTargetBlock(t, i)}`).join('')
      : `<div class="__cb_empty">No targets yet — pick something that should update.</div>`;

    const canSave = !!(a && ts.length);
    const previewBlock = preview
      ? `<div class="__cb_preview">${escapeHtml(preview)}</div>`
      : `<div class="__cb_preview _empty">Pick an action and at least one target to see the preview.</div>`;

    const selecting = state.selecting;
    return `
      <div class="__cb_section">
        <div class="__cb_section_label">When I do this</div>
        ${actionRow}
        <div class="__cb_btn_row" style="margin-top:6px;">
          <button class="__cb_btn _small${state.pickingKind === 'action' ? ' _picking' : ''}"
                  data-action="pick_action"
                  ${selecting && state.pickingKind !== 'action' ? 'disabled' : ''}>
            ${state.pickingKind === 'action' ? 'Selecting action…' : (a ? 'Replace action' : 'Pick action')}
          </button>
        </div>
      </div>

      <div class="__cb_section">
        <div class="__cb_section_label">These should update</div>
        ${targetRows}
        <div class="__cb_btn_row" style="margin-top:6px;">
          <button class="__cb_btn _small${state.pickingKind === 'target' ? ' _picking' : ''}"
                  data-action="pick_target"
                  ${selecting && state.pickingKind !== 'target' ? 'disabled' : ''}>
            ${state.pickingKind === 'target' ? 'Selecting target…' : '+ Add target'}
          </button>
        </div>
      </div>

      <div class="__cb_section">
        <div class="__cb_section_label">Constraint preview</div>
        ${previewBlock}
        <button class="__cb_btn _primary" data-action="save" ${canSave ? '' : 'disabled'}>Save constraint</button>
      </div>

      ${renderLanes()}
    `;
  }

  // Render one target: its chip + (for UI targets) a value-source picker
  // beneath it. API targets have no value picker — they're system events.
  function renderTargetBlock(t, idx) {
    const chip = `
      <div class="__cb_chip">
        <span>${escapeHtml(t.label)}</span>
        <span class="_remove" data-action="remove_target" data-idx="${idx}" title="Remove">×</span>
      </div>`;
    if (t.kind === 'api') {
      return `<div class="__cb_target_block">${chip}
        <div class="__cb_value_row __cb_value_row_api">
          <span>(API call — no value claim)</span>
        </div>
      </div>`;
    }
    return `
      <div class="__cb_target_block">
        ${chip}
        <div class="__cb_value_row">
          <span class="__cb_value_label">value:</span>
          <select class="__cb_value_source"
                  data-action="change_source" data-idx="${idx}">
            <option value="any"     ${(!t.source || t.source === 'any') ? 'selected' : ''}>any value</option>
            <option value="literal" ${t.source === 'literal' ? 'selected' : ''}>specific literal…</option>
            <option value="element" ${t.source === 'element' ? 'selected' : ''}>read from another element…</option>
            <option value="api"     ${t.source === 'api'     ? 'selected' : ''}>from an API response</option>
          </select>
          ${renderValueSubInput(t, idx)}
        </div>
      </div>`;
  }

  function renderValueSubInput(t, idx) {
    if (t.source === 'literal') {
      const v = (t.source_literal == null) ? '' : String(t.source_literal);
      return `<input class="__cb_value_input"
                     data-action="change_literal" data-idx="${idx}"
                     type="text" placeholder='e.g. "Hi Alice" or 0'
                     value="${escapeAttr(v)}"/>`;
    }
    if (t.source === 'element') {
      const opts = state.elements.length
        ? state.elements.map(e => {
            const sel = e.id === t.source_element_id ? 'selected' : '';
            return `<option value="${escapeAttr(e.id)}" ${sel}>${escapeHtml(e.id)}${e.label ? ' — ' + escapeHtml(String(e.label)) : ''}</option>`;
          }).join('')
        : '<option value="">(no elements — run Scan IDs)</option>';
      return `<select class="__cb_value_input"
                     data-action="change_source_element" data-idx="${idx}">
                <option value="">choose element…</option>${opts}
              </select>`;
    }
    return '';
  }

  // Detected APIs + storage. Sourced from /mapping/elements on init.
  // Clicking an API row adds it as a target via `call(<id>)`. Storage
  // is shown for visibility but isn't yet a target — the constraint
  // grammar has no storage event.
  function renderLanes() {
    const apiRows = state.apis.length === 0
      ? `<div class="__cb_empty">No APIs detected. Re-run "Scan IDs" in the Element Mapping tab if you expect some.</div>`
      : state.apis.map(a => {
          const method = (a.method || 'GET').toUpperCase();
          return `
            <div class="__cb_lane_row"
                 data-action="pick_api"
                 data-id="${escapeAttr(a.id)}"
                 title="${escapeAttr((a.file || '') + ':' + (a.line || ''))}">
              <span class="__cb_lane_icon">📡</span>
              <span class="__cb_lane_method _${method}">${escapeHtml(method)}</span>
              <span class="__cb_lane_id">${escapeHtml(a.id)}</span>
              <span class="__cb_lane_path">${escapeHtml(a.endpoint || '')}</span>
            </div>`;
        }).join('');

    const storageRows = state.storage.length === 0
      ? `<div class="__cb_empty">No storage usage detected.</div>`
      : state.storage.map(s => `
            <div class="__cb_lane_row"
                 data-action="pick_storage"
                 data-id="${escapeAttr(s.id)}"
                 title="${escapeAttr((s.file || '') + ':' + (s.line || ''))}">
              <span class="__cb_lane_icon">💾</span>
              <span class="__cb_lane_id">${escapeHtml(s.id)}</span>
              <span class="__cb_lane_path">${escapeHtml(s.area)}["${escapeHtml(s.key)}"]</span>
            </div>`).join('');

    return `
      <div class="__cb_section">
        <div class="__cb_section_label">APIs your app uses</div>
        <p class="__cb_lane_note">Click to add as a target. Renders as <code>call(name)</code>.</p>
        ${apiRows}
      </div>

      <div class="__cb_section">
        <div class="__cb_section_label">Storage your app uses</div>
        <p class="__cb_lane_note">Click to add as a target. Renders as <code>w(name)</code> — pick a value source to express <code>w(name, r(input))</code> etc.</p>
        ${storageRows}
      </div>
    `;
  }

  function renderReview() {
    if (state.saved.length === 0) {
      return `<div class="__cb_empty">No saved constraints yet. Build one in the Build tab.</div>`;
    }
    const items = state.saved.map((c, i) => {
      const labelLine = c.targets.map(t => t.label).join(', ');
      const isViz = state.visualizingIdx === i;
      return `
        <div class="__cb_saved_item">
          <div class="__cb_saved_head">
            <span class="__cb_saved_idx">#${i + 1}</span>
            <span style="display:flex; gap:6px; align-items:center;">
              <button class="__cb_btn _small${isViz ? ' _picking' : ''}"
                      data-action="visualize" data-idx="${i}"
                      title="Show arrows from action to targets on the page">
                ${isViz ? 'Hide' : 'Show'}
              </button>
              <span class="_remove" data-action="remove_saved" data-idx="${i}" title="Delete">×</span>
            </span>
          </div>
          <div class="__cb_saved_formula">${escapeHtml(c.constraint)}</div>
          <div class="__cb_saved_labels">action: ${escapeHtml(c.action.label)} → ${escapeHtml(labelLine)}</div>
        </div>`;
    }).join('');
    const clearLabel = state.confirmClear ? 'Confirm clear' : 'Clear all';
    return `
      ${items}
      <div class="__cb_btn_row" style="margin-top:8px;">
        <button class="__cb_btn _primary" data-action="send">Send to app</button>
        <button class="__cb_btn"          data-action="export">Export JSON</button>
        <button class="__cb_btn _danger"  data-action="clear">${clearLabel}</button>
      </div>
    `;
  }

  function renderStatus() {
    const s = state.status;
    if (!s) return '';
    return `<div class="__cb_status _${s.kind}">${escapeHtml(s.text)}</div>`;
  }

  function setStatus(kind, text) {
    state.status = { kind, text };
    render();
    // Auto-clear info messages after a few seconds; keep errors until next action.
    if (kind === 'info') {
      setTimeout(() => {
        if (state.status && state.status.text === text) {
          state.status = null;
          render();
        }
      }, 2500);
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────
  function onPanelChange(e) {
    const action = e.target.dataset && e.target.dataset.action;
    if (!action) return;
    const idx = Number(e.target.dataset.idx);
    const t   = state.targets[idx];

    if (action === 'change_op' && t) {
      t.op = e.target.value;
      render();
    } else if (action === 'change_source' && t) {
      t.source = e.target.value;
      if (t.source !== 'literal') t.source_literal = undefined;
      if (t.source !== 'element') {
        t.source_element_id = undefined;
        t.source_element_label = undefined;
      }
      render();
    } else if (action === 'change_literal' && t) {
      t.source_literal = e.target.value;
      // Don't re-render on every keystroke — just update the preview formula
      // by re-rendering. (Preview update is the main reason to render.)
      renderPreviewOnly();
    } else if (action === 'change_source_element' && t) {
      t.source_element_id = e.target.value || undefined;
      const el = state.elements.find(x => x.id === e.target.value);
      t.source_element_label = el ? (el.label || el.id) : undefined;
      render();
    }
  }

  // Lightweight preview update — only re-renders the preview block + the
  // save button enabled-state. Avoids losing focus on the literal text input.
  function renderPreviewOnly() {
    if (!panel) return;
    const a = state.action;
    const ts = state.targets;
    const preview = buildConstraint(a && a.id, ts);
    const block = panel.querySelector('.__cb_preview');
    if (!block) return;
    if (preview) {
      block.classList.remove('_empty');
      block.textContent = preview;
    } else {
      block.classList.add('_empty');
      block.textContent = 'Pick an action and at least one target to see the preview.';
    }
  }

  function onPanelClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    switch (action) {
      case 'close':
        panel.style.display = 'none';
        break;
      case 'mode':
        state.mode = target.dataset.mode;
        state.status = null;
        render();
        break;
      case 'pick_action':
        startSelection('action', el => {
          if (!el) return;                                 // cancelled
          state.action = { id: el.id, label: getDisplayLabel(el) };
          render();
        });
        break;
      case 'clear_action':
        state.action = null;
        render();
        break;
      case 'pick_target':
        startSelection('target', el => {
          if (!el) return;
          if (state.targets.some(t => t.id === el.id)) {
            setStatus('error', `Target ${el.id} is already in the list.`);
            return;
          }
          // New target joins the previous one with AND by default — the
          // user can change it via the dropdown that renders above the chip.
          // Default value source is "any" (emits w(id) with no value_expr).
          state.targets.push({
            id:     el.id,
            label:  getDisplayLabel(el),
            op:     'AND',
            kind:   'ui',
            source: 'any',
          });
          render();
        });
        break;
      case 'remove_target':
        state.targets.splice(Number(target.dataset.idx), 1);
        render();
        break;
      case 'pick_api': {
        const id = target.dataset.id;
        if (!id) break;
        if (state.targets.some(t => t.id === id && t.kind === 'api')) {
          setStatus('error', `API ${id} is already a target.`);
          break;
        }
        const api = state.apis.find(a => a.id === id);
        const label = api ? `${id} (${(api.method || 'GET')} ${api.endpoint || ''})` : id;
        state.targets.push({ id, label, op: 'AND', kind: 'api' });
        render();
        break;
      }
      case 'pick_storage': {
        const id = target.dataset.id;
        if (!id) break;
        if (state.targets.some(t => t.id === id && t.kind === 'storage')) {
          setStatus('error', `Storage ${id} is already a target.`);
          break;
        }
        const s = state.storage.find(x => x.id === id);
        const label = s ? `${id} (${s.area}["${s.key}"])` : id;
        state.targets.push({ id, label, op: 'AND', kind: 'storage' });
        render();
        break;
      }
      case 'save':
        saveConstraint();
        break;
      case 'change_op':
        // Handled in onPanelChange — capture-phase click on the <select> would
        // arrive here too, but ignore it to avoid double-handling.
        break;
      case 'visualize': {
        const idx = Number(target.dataset.idx);
        if (state.visualizingIdx === idx) {
          clearVisualization();
          state.visualizingIdx = null;
        } else {
          clearVisualization();
          state.visualizingIdx = idx;
          drawVisualization(state.saved[idx]);
        }
        render();
        break;
      }
      case 'remove_saved':
        if (state.visualizingIdx === Number(target.dataset.idx)) {
          clearVisualization();
          state.visualizingIdx = null;
        }
        state.saved.splice(Number(target.dataset.idx), 1);
        persist();
        render();
        break;
      case 'export':
        exportJSON();
        break;
      case 'send':
        sendToApp();
        break;
      case 'clear':
        clearAll();
        break;
    }
  }

  // Two-click confirmation (no alert/prompt/confirm allowed).
  let _clearTimer = null;
  function clearAll() {
    if (state.saved.length === 0) {
      setStatus('error', 'Nothing to clear.');
      return;
    }
    if (!state.confirmClear) {
      state.confirmClear = true;
      setStatus('info', 'Click "Confirm clear" again to delete every saved constraint.');
      clearTimeout(_clearTimer);
      _clearTimer = setTimeout(() => {
        state.confirmClear = false;
        render();
      }, 4000);
      render();
      return;
    }
    clearTimeout(_clearTimer);
    state.confirmClear = false;
    state.saved = [];
    persist();
    setStatus('info', 'All saved constraints cleared.');
  }

  function saveConstraint() {
    const a  = state.action;
    const ts = state.targets;
    const formula = buildConstraint(a && a.id, ts);
    if (!formula) {
      setStatus('error', 'Pick an action and at least one target before saving.');
      return;
    }
    state.saved.push({
      constraint: formula,
      action:     { id: a.id, label: a.label },
      targets:    ts.map(t => ({ id: t.id, label: t.label, op: t.op || null })),
      created_at: new Date().toISOString(),
    });
    persist();
    state.action  = null;
    state.targets = [];
    setStatus('info', 'Saved. Switch to Review to see all constraints.');
  }

  function exportJSON() {
    const payload = JSON.stringify({ version: 1, constraints: state.saved }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `constraints-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Same-origin POST — overlay runs on /preview/* served by the same Flask app
  // that exposes /constraints/import, so no CORS config is needed.
  function sendToApp() {
    if (state.saved.length === 0) {
      setStatus('error', 'No saved constraints to send.');
      return;
    }
    fetch('/constraints/import', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ version: 1, constraints: state.saved }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          setStatus('info', `Sent ${data.added} new constraint(s) · inbox total ${data.total}.`);
        } else {
          setStatus('error', data.error || 'Server rejected the payload.');
        }
      })
      .catch(() => setStatus('error', 'Network error — is the app server reachable?'));
  }

  // ── Selection mode ────────────────────────────────────────────────────
  let selectionContext = null;

  function startSelection(kind, callback) {
    if (state.selecting) return;
    state.selecting = true;
    state.pickingKind = kind;   // 'action' | 'target' — drives button highlight
    state.status = { kind: 'info', text: 'Click an element to select it · Esc to cancel.' };
    render();

    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';

    let lastHL = null;
    const clearHL = () => {
      if (lastHL) { lastHL.classList.remove('__cb_highlight'); lastHL = null; }
    };

    function onMouseOver(e) {
      if (panel.contains(e.target)) { clearHL(); return; }
      clearHL();
      lastHL = e.target;
      lastHL.classList.add('__cb_highlight');
    }

    function onClick(e) {
      if (panel.contains(e.target)) return;       // let panel clicks work normally
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const el = e.target;
      if (!el.id) {
        setStatus('error', `Element <${(el.tagName || '').toLowerCase()}> has no id. Run inject_ids on your source first.`);
        // stay in selection mode so the user can try another element
        return;
      }
      cleanup();
      callback(el);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        cleanup();
        callback(null);                            // signal cancellation
      }
    }

    function cleanup() {
      document.body.style.cursor = prevCursor;
      clearHL();
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('click',     onClick,     true);
      document.removeEventListener('keydown',   onKey,       true);
      state.selecting = false;
      state.pickingKind = null;
      state.status = null;
      selectionContext = null;
      render();
    }

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click',     onClick,     true);
    document.addEventListener('keydown',   onKey,       true);
    selectionContext = { cleanup };
  }

  // ── Visualization (arrows from action to targets) ─────────────────────
  const VIZ_LAYER_ID = '__cb_viz_layer';
  const VIZ_HL_CLASS = '__cb_viz_hl';

  function drawVisualization(saved) {
    clearVisualization();
    if (!saved) return;

    // Resolve the action + target DOM elements.
    const actionEl = document.getElementById(saved.action.id);
    if (!actionEl) return;
    const targetEls = saved.targets
      .map(t => ({ el: document.getElementById(t.id), meta: t }))
      .filter(x => x.el);

    // Highlight the action (green) and targets (blue), skipping any that
    // are inside the panel itself.
    if (!panel.contains(actionEl)) {
      actionEl.classList.add(VIZ_HL_CLASS, '_action');
    }
    targetEls.forEach(({ el }) => {
      if (!panel.contains(el)) el.classList.add(VIZ_HL_CLASS, '_target');
    });

    // Full-viewport SVG layer, pointer-events off so it doesn't block clicks.
    const svgns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgns, 'svg');
    svg.id = VIZ_LAYER_ID;
    Object.assign(svg.style, {
      position: 'fixed', top: '0', left: '0',
      width: '100vw', height: '100vh',
      pointerEvents: 'none', zIndex: '999998',
      overflow: 'visible',
    });

    // Arrowhead marker for the line ends.
    const defs = document.createElementNS(svgns, 'defs');
    const marker = document.createElementNS(svgns, 'marker');
    marker.setAttribute('id', '__cb_viz_arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(svgns, 'path');
    path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    path.setAttribute('fill', '#44403c');
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.appendChild(defs);

    // One line from action center → each target center.
    const actionRect = actionEl.getBoundingClientRect();
    const ax = actionRect.left + actionRect.width  / 2;
    const ay = actionRect.top  + actionRect.height / 2;

    targetEls.forEach(({ el, meta }) => {
      const r = el.getBoundingClientRect();
      const tx = r.left + r.width  / 2;
      const ty = r.top  + r.height / 2;
      const line = document.createElementNS(svgns, 'line');
      line.setAttribute('x1', ax); line.setAttribute('y1', ay);
      line.setAttribute('x2', tx); line.setAttribute('y2', ty);
      line.setAttribute('stroke', '#44403c');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-dasharray', '6,4');
      line.setAttribute('marker-end', 'url(#__cb_viz_arrow)');
      svg.appendChild(line);

      // Optional midpoint label with the target's op (AND / OR / XOR / NOT).
      if (meta.op) {
        const mx = (ax + tx) / 2, my = (ay + ty) / 2;
        const label = document.createElementNS(svgns, 'text');
        label.setAttribute('x', mx);
        label.setAttribute('y', my - 6);
        label.setAttribute('font-size', '11');
        label.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
        label.setAttribute('font-weight', '600');
        label.setAttribute('fill', '#44403c');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('paint-order', 'stroke');
        label.setAttribute('stroke', '#ffffff');
        label.setAttribute('stroke-width', '3');
        label.textContent = meta.op;
        svg.appendChild(label);
      }
    });

    document.body.appendChild(svg);

    // Redraw on scroll/resize so the arrows follow the elements.
    const redraw = () => { if (state.visualizingIdx !== null) drawVisualization(saved); };
    window.__cb_viz_redraw = redraw;
    window.addEventListener('scroll',  redraw, true);
    window.addEventListener('resize',  redraw);
  }

  function clearVisualization() {
    const svg = document.getElementById(VIZ_LAYER_ID);
    if (svg) svg.remove();
    document.querySelectorAll('.' + VIZ_HL_CLASS).forEach(el => {
      el.classList.remove(VIZ_HL_CLASS, '_action', '_target');
    });
    if (window.__cb_viz_redraw) {
      window.removeEventListener('scroll',  window.__cb_viz_redraw, true);
      window.removeEventListener('resize',  window.__cb_viz_redraw);
      window.__cb_viz_redraw = null;
    }
  }

  // ── Drag ─────────────────────────────────────────────────────────────
  function startDrag(e) {
    // Don't start a drag from the close button or anything else with an action.
    if (e.target.closest('[data-action]')) return;

    const rect = panel.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;

    function move(ev) {
      const x = Math.max(0, Math.min(window.innerWidth  - rect.width,  ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - rect.height, ev.clientY - offY));
      panel.style.left  = x + 'px';
      panel.style.top   = y + 'px';
      panel.style.right = 'auto';
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup',   up);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup',   up);
    e.preventDefault();
  }

  // ── Utilities ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  // Fetch detected APIs + storage from the same Flask host that serves
  // /preview. Same-origin — no CORS config. Quietly tolerates failure
  // (e.g. mapping not yet scanned) so the panel still renders.
  function loadMapping() {
    fetch('/mapping/elements')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => {
        if (data && data.available) {
          state.apis     = Array.isArray(data.apis)     ? data.apis     : [];
          state.storage  = Array.isArray(data.storage)  ? data.storage  : [];
          state.elements = Array.isArray(data.elements) ? data.elements : [];
          render();
        }
      })
      .catch(() => { /* offline or no mapping — leave lanes empty */ });
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildPanel();
    restore();
    render();
    loadMapping();
    // Re-fetch mapping when the parent flow signals the active app changed
    // (e.g. after "Build / rebuild DB" in Step 6). Keeps the storage/APIs
    // lane and the elements dropdown in sync without a manual reload.
    window.addEventListener("cv:app-changed", () => loadMapping());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // ── Public hooks (testing / programmatic use) ─────────────────────────
  window.__constraintBuilder = {
    state,
    render,
    save:   saveConstraint,
    export: exportJSON,
    reset:  () => { state.saved = []; persist(); render(); },
    cancelSelection: () => selectionContext && selectionContext.cleanup(),
  };
})();
