/* ── Element reference ────────────────────────────────────────────────── */

async function loadElementReference() {
  try {
    const res  = await fetch("/mapping/elements");
    const data = await res.json();

    const refPanel      = document.getElementById("element-ref");
    const noMappingHint = document.getElementById("no-mapping-hint");
    const refElements   = document.getElementById("ref-elements");
    const refApis       = document.getElementById("ref-apis");
    const refApisRow    = document.getElementById("ref-apis-row");

    const elements = (data.available && data.elements) ? data.elements : [];
    const apis     = (data.available && data.apis)     ? data.apis     : [];

    if (elements.length === 0 && apis.length === 0) {
      refPanel.classList.add("hidden");
      refElements.innerHTML = "";
      refApis.innerHTML = "";
      refApisRow.classList.add("hidden");
      noMappingHint.classList.remove("hidden");
      return;
    }

    noMappingHint.classList.add("hidden");

    // Elements chips — id is the canonical handle, label shown for humans.
    refElements.innerHTML = elements.map(e => {
      const text = e.label && e.label !== e.id ? `${e.id} (${e.label})` : e.id;
      return `<button class="ref-chip ref-chip-element"
                       data-insert="${escapeAttr(e.id)}"
                       title="${escapeAttr(e.label || '')}">${escapeHtml(text)}</button>`;
    }).join("");

    // API chips
    if (apis.length) {
      refApis.innerHTML = apis.map(a => {
        const text = a.label && a.label !== a.id ? `${a.id} (${a.label})` : a.id;
        return `<button class="ref-chip ref-chip-api"
                         data-insert="${escapeAttr(a.id)}"
                         title="${escapeAttr(a.label || '')}">${escapeHtml(text)}</button>`;
      }).join("");
      refApisRow.classList.remove("hidden");
    } else {
      refApis.innerHTML = "";
      refApisRow.classList.add("hidden");
    }

    refPanel.classList.remove("hidden");

    // Click to insert at cursor
    refPanel.querySelectorAll(".ref-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const name  = chip.dataset.insert;
        const start = input.selectionStart;
        const end   = input.selectionEnd;
        const val   = input.value;
        input.value = val.slice(0, start) + name + val.slice(end);
        input.selectionStart = input.selectionEnd = start + name.length;
        input.focus();
      });
    });

  } catch {
    const refPanel      = document.getElementById("element-ref");
    const noMappingHint = document.getElementById("no-mapping-hint");
    if (refPanel) refPanel.classList.add("hidden");
    if (noMappingHint) noMappingHint.classList.remove("hidden");
  }
}

loadElementReference();

/* ── DOM refs ─────────────────────────────────────────────────────────── */
const input          = document.getElementById("constraint-input");
const parseBtn       = document.getElementById("parse-btn");
const resultsArea    = document.getElementById("results");
const errorBox       = document.getElementById("error-box");
const tokenCard      = document.getElementById("token-card");
const parseTreeCard  = document.getElementById("parse-tree-card");
const astCard        = document.getElementById("ast-card");
const semanticsCard  = document.getElementById("semantics-card");
const typeCard       = document.getElementById("type-card");
const verifyCard     = document.getElementById("verify-card");
const verifyBtn      = document.getElementById("verify-btn");
const verifyUrlInput = document.getElementById("verify-url-input");
const verifyNInput   = document.getElementById("verify-n-input");
const verifyResult   = document.getElementById("verify-result");

/* ── Bootstrap ────────────────────────────────────────────────────────── */
parseBtn.addEventListener("click", runParse);
input.addEventListener("keydown", e => { if (e.key === "Enter") runParse(); });

/* ── Main action ──────────────────────────────────────────────────────── */
async function runParse() {
  const source = input.value.trim();
  if (!source) return;

  setLoading(true);
  clearResults();

  try {
    const res  = await fetch("/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ constraint: source }),
    });
    const data = await res.json();

    if (!data.success) {
      showError(data.error);
    } else {
      renderTokens(data.tokens);
      renderParseTree(data.parse_tree);
      renderAST(data.ast);
      renderConstraintType(data.type, data.classification_trace, data.dispatch_plan);
      renderSemantics(data.semantics);
      renderVerifyCard(data.verifiable);
      resultsArea.classList.remove("hidden");
    }
  } catch (err) {
    showError("Network error — is the server running?");
  } finally {
    setLoading(false);
  }
}

/* ── Loading state ────────────────────────────────────────────────────── */
function setLoading(on) {
  parseBtn.disabled = on;
  parseBtn.innerHTML = on
    ? `<span class="spinner"></span>Parsing…`
    : "Parse";
}

/* ── Error display ────────────────────────────────────────────────────── */
function showError(msg) {
  errorBox.innerHTML = `
    <div class="error-header">
      <span class="error-badge">Invalid</span>
      <span class="error-title">Could not parse constraint</span>
    </div>
    <div class="error-message">${escapeHtml(msg)}</div>
  `;
  errorBox.classList.remove("hidden");
}

function clearResults() {
  errorBox.classList.add("hidden");
  verifyCard.classList.add("hidden");
  verifyResult.classList.add("hidden");
  resultsArea.classList.add("hidden");
  tokenCard.querySelector(".token-table tbody").innerHTML = "";
  parseTreeCard.querySelector(".parse-tree").textContent = "";
  astCard.querySelector(".ast-root").innerHTML = "";
  semanticsCard.querySelector(".semantics-body").innerHTML = "";
  typeCard.querySelector(".type-body").innerHTML = "";
  typeCard.classList.remove("hidden");
  stage1Result.classList.add("hidden");
  stage1Result.innerHTML = "";
}

/* ── Step 4: Semantic analysis (Visitor 2) ────────────────────────────── */
function renderSemantics(sem) {
  const body = semanticsCard.querySelector(".semantics-body");

  if (!sem) {
    body.innerHTML = `
      <div class="semantics-skipped">
        Semantic analysis skipped — no AST.
      </div>`;
    return;
  }

  if (sem.valid) {
    body.innerHTML = `
      <div class="semantics-pass">
        <span class="semantics-pass-badge">Pass</span>
        <span class="semantics-pass-msg">All semantic rules satisfied.</span>
      </div>`;
    return;
  }

  const n = sem.issues.length;
  const rows = sem.issues.map(i => `
    <li>
      <span class="semantic-issue-code">${escapeHtml(i.code)}</span>
      <span class="semantic-issue-msg">${escapeHtml(i.message)}</span>
    </li>
  `).join("");

  body.innerHTML = `
    <div class="semantics-fail-header">
      <span class="semantics-fail-badge">Fail</span>
      <span class="semantics-fail-title">${n} issue${n > 1 ? "s" : ""} found</span>
    </div>
    <ul class="semantic-issues">${rows}</ul>
  `;
}

/* ── Step 1: Tokens ───────────────────────────────────────────────────── */
function renderTokens(tokens) {
  const tbody = tokenCard.querySelector(".token-table tbody");
  tbody.innerHTML = tokens.map(tok => `
    <tr>
      <td><span class="tok-badge tok-${tok.category}">${escapeHtml(tok.kind)}</span></td>
      <td class="tok-value">${escapeHtml(tok.value || "—")}</td>
      <td class="tok-pos">${tok.pos}</td>
    </tr>
  `).join("");
}

/* ── Step 2: Parse tree ───────────────────────────────────────────────── */
function renderParseTree(treeStr) {
  parseTreeCard.querySelector(".parse-tree").textContent = treeStr || "";
}

/* ── Step 3: AST ──────────────────────────────────────────────────────── */
function renderAST(node) {
  const root = astCard.querySelector(".ast-root");
  root.innerHTML = renderASTNode(node, null);
}

/**
 * Recursively render the dict AST as an indented tree.
 * `label` is the field name from the parent (e.g. "event", "condition").
 */
function renderASTNode(node, label) {
  if (node === null || node === undefined) {
    return renderLeaf(label, "none", "null");
  }

  // Plain scalars (string element refs, numbers, booleans inside fields)
  if (typeof node !== "object") {
    const cls = typeof node === "boolean" ? "bool"
              : typeof node === "number"  ? "number"
              : "string";
    const text = typeof node === "string" ? `"${escapeHtml(node)}"` : String(node);
    return renderLeaf(label, text, cls);
  }

  if (Array.isArray(node)) {
    return node.map((item, i) => renderASTNode(item, `${label ?? ""}[${i}]`)).join("");
  }

  const { type, ...fields } = node;

  // LiteralExpr collapses to a single inline value
  if (type === "LiteralExpr") {
    const v = fields.value;
    if (v === "null")           return renderLeaf(label, "null", "null");
    if (typeof v === "boolean") return renderLeaf(label, String(v), "bool");
    if (typeof v === "number")  return renderLeaf(label, String(v), "number");
    return renderLeaf(label, `"${escapeHtml(String(v))}"`, "string");
  }

  // Composite node — header + children
  const labelHtml = label
    ? `<span class="ast-field-label">${escapeHtml(label)}</span> `
    : "";

  const childrenHtml = Object.entries(fields).map(([key, val]) => {
    if (val === false && key !== "negated") return "";
    if (val === null && key !== "guard" && key !== "value_expr" && key !== "params") return "";
    return renderASTNode(val, key);
  }).join("");

  return `
    <div class="ast-node">
      <div class="ast-node-header">
        ${labelHtml}<span class="ast-node-type">${escapeHtml(type ?? "Unknown")}</span>
      </div>
      ${childrenHtml}
    </div>
  `;
}

function renderLeaf(label, value, cls) {
  const labelHtml = label
    ? `<span class="ast-leaf-label">${escapeHtml(label)}</span>`
    : "";
  return `
    <div class="ast-leaf">
      ${labelHtml}
      <span class="ast-val-${cls}">${value}</span>
    </div>
  `;
}

/* ── Step 4: Constraint type ──────────────────────────────────────────── */
function renderConstraintType(t, trace, plan) {
  if (!t) {
    typeCard.classList.add("hidden");
    return;
  }
  typeCard.classList.remove("hidden");
  const body = typeCard.querySelector(".type-body");
  body.innerHTML = `
    <span class="type-badge type-${t.color}">${escapeHtml(t.label)}</span>

    <div class="type-info-grid">
      <div class="type-info-block">
        <span class="type-info-label">Verification approach</span>
        <span class="type-info-value">${escapeHtml(t.summary)}</span>
      </div>
      <div class="type-info-block">
        <span class="type-info-label">Checker function</span>
        <div class="type-checker-box">${escapeHtml(t.checker)}</div>
      </div>
    </div>

    <p class="type-detail">${escapeHtml(t.detail)}</p>

    ${renderClassificationTrace(trace)}
    ${renderDispatchPlan(plan)}
  `;
}

// Show every rule the classifier evaluated, with ✓/✗ and the type each
// rule would have selected. The matched (winning) rule is highlighted;
// rules that came after are dimmed because the classifier short-circuits.
function renderClassificationTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return "";
  const rows = trace.map(s => {
    const cls = (s.skipped ? "trace-row-skipped"
                : s.matched ? "trace-row-matched"
                :             "trace-row-no")
              + (s.indented ? " trace-row-indent" : "");
    const icon = s.skipped ? "·"
               : s.matched ? "✓"
               :             "✗";
    return `
      <div class="trace-row ${cls}">
        <span class="trace-icon">${icon}</span>
        <span class="trace-rule">${escapeHtml(s.rule)}</span>
        <span class="trace-arrow">→</span>
        <span class="trace-would">${escapeHtml(s.would_give)}</span>
        ${s.detail ? `<div class="trace-detail">${escapeHtml(s.detail)}</div>` : ""}
      </div>`;
  }).join("");
  return `
    <div class="type-section">
      <span class="type-section-label">Classifier decision trace</span>
      <p class="type-section-hint">
        Each rule maps to one branch in <code>classify(ast)</code>. First match wins; later rules are skipped.
      </p>
      <div class="trace-list">${rows}</div>
    </div>`;
}

// Show the primitive(s) the dispatcher will run for this AST, with the
// rendered slot bindings. Each row corresponds to one (primitive, target)
// pair that the for-loop in stage1_check will execute.
function renderDispatchPlan(plan) {
  if (!Array.isArray(plan)) return "";
  if (plan.length === 0) {
    return `
      <div class="type-section">
        <span class="type-section-label">Static-analysis dispatch plan</span>
        <p class="type-section-hint">No static primitives will run for this constraint type.</p>
      </div>`;
  }
  const rows = plan.map(p => {
    const slots = p.slots && Object.keys(p.slots).length
      ? `<div class="plan-slots">
           ${Object.entries(p.slots).map(([k, v]) =>
             `<span class="plan-slot"><code>__${k}__</code> = <code>${escapeHtml(String(v))}</code></span>`
           ).join("")}
         </div>`
      : "";
    const skipped = !p.applies
      ? `<div class="plan-skipped">SKIP — ${escapeHtml(p.skip_reason || "")}</div>`
      : "";
    return `
      <div class="plan-row ${p.applies ? "" : "plan-row-skip"}">
        <div class="plan-head">
          <span class="plan-prim">${escapeHtml(p.primitive)}</span>
          <span class="plan-target">target = <code>${escapeHtml(p.target)}</code></span>
          <span class="plan-file"><code>${escapeHtml(p.query_file || "")}</code></span>
        </div>
        <div class="plan-desc">${escapeHtml(p.description || "")}</div>
        ${slots}
        ${skipped}
      </div>`;
  }).join("");
  return `
    <div class="type-section">
      <span class="type-section-label">Static-analysis dispatch plan</span>
      <p class="type-section-hint">
        For each row, the dispatcher fills the listed slots into the <code>.ql</code>
        file and runs CodeQL. Output appears in Step 6.
      </p>
      <div class="plan-list">${rows}</div>
    </div>`;
}

/* ── Step 5: Verify ───────────────────────────────────────────────────── */

function renderVerifyCard(verifiable) {
  if (verifiable) {
    prefillVerifyUrl();
    verifyCard.classList.remove("hidden");
    verifyResult.classList.add("hidden");
  } else {
    verifyCard.classList.add("hidden");
  }
}

// Pre-fill the URL field from the user's last-used value. Defaults to
// the bundled demo app served by our own Flask process (no second
// terminal required).
function prefillVerifyUrl() {
  if (verifyUrlInput.value.trim()) return;
  verifyUrlInput.value =
    localStorage.getItem("cv:verifyUrl") || `${window.location.origin}/run/`;
}

verifyBtn.addEventListener("click", async () => {
  const source   = input.value.trim();
  const url      = verifyUrlInput.value.trim();
  const n_traces = parseInt(verifyNInput.value, 10) || 30;
  if (!source) return;
  if (!url) {
    renderVerifyError("Enter your app's URL (e.g. http://localhost:8080/index.html) before running.");
    return;
  }
  localStorage.setItem("cv:verifyUrl", url);

  verifyBtn.disabled  = true;
  verifyBtn.innerHTML = `<span class="spinner"></span>Running ${n_traces} traces…`;
  verifyResult.classList.add("hidden");

  try {
    const res  = await fetch("/verify", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ constraint: source, url, n_traces }),
    });
    const data = await res.json();

    if (!data.success) {
      renderVerifyError(data.error);
    } else {
      renderDynamicResult(data);
    }
    verifyResult.classList.remove("hidden");
  } catch {
    renderVerifyError("Network error — is the server running?");
    verifyResult.classList.remove("hidden");
  } finally {
    verifyBtn.disabled  = false;
    verifyBtn.innerHTML = "Run Dynamic Analysis";
  }
});

function renderVerifyError(msg) {
  verifyResult.className = "verify-result verify-fail";
  verifyResult.innerHTML = `
    <div class="verify-header">
      <span class="verify-badge verify-badge-fail">Error</span>
      <span class="verify-title">${escapeHtml(msg)}</span>
    </div>`;
  verifyResult.classList.remove("hidden");
}

function renderDynamicResult(data) {
  const r = data.result;
  const badge = r === "PASSED" ? "verify-badge-pass"
              : r === "FAILED" ? "verify-badge-fail"
              :                  "verify-badge-skip";
  const className = r === "PASSED" ? "verify-pass"
                  : r === "FAILED" ? "verify-fail"
                  :                  "verify-skip";

  const observed = (data.observed != null) ? data.observed.toFixed(4) : "—";
  const expected = (data.expected != null) ? data.expected : "—";
  const op       = data.operator || "=";

  const stats = `
    <div class="verify-stats">
      <div><strong>Observed P:</strong> ${observed}</div>
      <div><strong>Expected:</strong> ${op} ${expected}</div>
      <div><strong>Traces:</strong> ${data.samples_total ?? 0}</div>
      <div><strong>Condition met:</strong> ${data.samples_condition_met ?? 0}</div>
      <div><strong>Event met:</strong> ${data.samples_event_met ?? 0}</div>
    </div>`;

  const reason = data.reason
    ? `<div class="verify-reason">${escapeHtml(data.reason)}</div>` : "";

  const failingExamples = (data.failing_examples || []).slice(0, 3).map(ex => `
    <li>
      <code>${escapeHtml(ex.id)}</code> —
      triggered: [${(ex.triggered || []).map(escapeHtml).join(", ")}],
      written: [${(ex.written || []).map(escapeHtml).join(", ")}]
    </li>`).join("");
  const examples = failingExamples
    ? `<details class="verify-examples"><summary>Failing trace examples</summary><ul>${failingExamples}</ul></details>` : "";

  verifyResult.className = `verify-result ${className}`;
  verifyResult.innerHTML = `
    <div class="verify-header">
      <span class="verify-badge ${badge}">${r}</span>
      <span class="verify-title">Dynamic analysis (${data.type || "PROBABILISTIC"})</span>
    </div>
    ${stats}
    ${reason}
    ${examples}`;
}

/* ── Step 6: Static analysis (CodeQL) ─────────────────────────────────── */

const stage1Btn       = document.getElementById("stage1-btn");
const stage1DbInput   = document.getElementById("stage1-db-input");
const stage1SrcInput  = document.getElementById("stage1-src-input");
const stage1Result    = document.getElementById("stage1-result");
const rebuildDbBtn    = document.getElementById("rebuild-db-btn");

stage1Btn.addEventListener("click", async () => {
  const source  = input.value.trim();
  const db_path = stage1DbInput.value.trim();
  if (!source) return;

  stage1Btn.disabled  = true;
  stage1Btn.innerHTML = `<span class="spinner"></span>Running…`;
  stage1Result.classList.add("hidden");

  try {
    const res  = await fetch("/verify/stage1", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ constraint: source, db_path }),
    });
    const data = await res.json();
    renderStage1(data);
  } catch {
    renderStage1({ success: false, error: "Network error — is the server running?" });
  } finally {
    stage1Btn.disabled  = false;
    stage1Btn.innerHTML = "Run static checks";
  }
});

rebuildDbBtn.addEventListener("click", async () => {
  const source_dir = stage1SrcInput.value.trim();
  const db_path    = stage1DbInput.value.trim();
  if (!source_dir) return;

  rebuildDbBtn.disabled  = true;
  rebuildDbBtn.innerHTML = `<span class="spinner"></span>Building…`;
  stage1Result.classList.add("hidden");

  try {
    const res  = await fetch("/codeql/rebuild", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ source_dir, db_path }),
    });
    const data = await res.json();
    if (data.success) {
      stage1Result.className = "stage1-result stage1-info";
      const appDir = data.app_dir ? ` Now serving <code>${escapeHtml(data.app_dir)}</code> at <code>/run/</code>.` : "";
      stage1Result.innerHTML = `<strong>CodeQL DB built</strong> at <code>${escapeHtml(data.db_path)}</code>.${appDir}`;
      // Ask any sibling tabs / overlays to refresh their data so the
      // constraint builder picks up the new mapping and the iframe
      // points at the new app.
      window.dispatchEvent(new CustomEvent("cv:app-changed", {
        detail: { app_dir: data.app_dir, db_path: data.db_path },
      }));
    } else {
      stage1Result.className = "stage1-result stage1-fail";
      stage1Result.innerHTML = `<strong>Build failed:</strong> ${escapeHtml(data.error || "unknown")}`;
    }
    stage1Result.classList.remove("hidden");
  } catch {
    stage1Result.className = "stage1-result stage1-fail";
    stage1Result.innerHTML = `<strong>Network error</strong> — is the server running?`;
    stage1Result.classList.remove("hidden");
  } finally {
    rebuildDbBtn.disabled  = false;
    rebuildDbBtn.innerHTML = "Build / rebuild DB";
  }
});

function renderStage1(data) {
  if (!data.success) {
    stage1Result.className = "stage1-result stage1-fail";
    stage1Result.innerHTML = `<strong>Error:</strong> ${escapeHtml(data.error || "unknown")}`;
    stage1Result.classList.remove("hidden");
    return;
  }

  const overall = data.result === "PASSED" ? "pass"
                 : data.result === "SKIP"   ? "skip"
                 : "fail";
  const overallLabel = data.result === "PASSED" ? "All static checks passed"
                     : data.result === "SKIP"   ? (data.reason || "Skipped")
                     : `${(data.checks || []).filter(c => !c.passed).length} of ${(data.checks || []).length} checks failed`;

  const header = `
    <div class="stage1-header">
      <span class="stage1-badge stage1-badge-${overall}">${data.result}</span>
      <span class="stage1-title">${escapeHtml(overallLabel)}</span>
    </div>`;

  const checks = (data.checks || []).map(renderStage1Check).join("");

  stage1Result.className = `stage1-result stage1-${overall}`;
  stage1Result.innerHTML = header + checks;
  stage1Result.classList.remove("hidden");

  // Wire up the "Show query" toggles on each check panel.
  stage1Result.querySelectorAll(".stage1-toggle-query").forEach(btn => {
    btn.addEventListener("click", () => {
      const pre = btn.parentElement.querySelector(".stage1-query");
      const open = pre.classList.toggle("hidden");
      btn.textContent = open ? "▶ Show query" : "▼ Hide query";
    });
  });
}

function renderStage1Check(c) {
  const cls = c.passed ? "pass" : "fail";
  const verb = c.passed ? "Found" : "No";

  let evidenceBlock = "";
  if (c.evidence && c.evidence.length) {
    const rows = c.evidence.map(e => `
      <li><code>${escapeHtml(e.file)}:${e.line}</code></li>`).join("");
    evidenceBlock = `
      <div class="stage1-check-evidence">
        <span class="stage1-check-label">${verb} ${c.evidence.length} location${c.evidence.length === 1 ? "" : "s"}:</span>
        <ul>${rows}</ul>
      </div>`;
  } else if (!c.passed) {
    evidenceBlock = `<div class="stage1-check-reason">${escapeHtml(c.reason || "no evidence")}</div>`;
  }

  return `
    <div class="stage1-check stage1-check-${cls}">
      <div class="stage1-check-head">
        <span class="stage1-check-name">${escapeHtml(c.name)}</span>
        <span class="stage1-check-args">
          <code>${escapeHtml(c.action)}</code>
          <span class="stage1-arrow">→</span>
          <code>${escapeHtml(c.target)}</code>
        </span>
        <span class="stage1-check-pill stage1-check-pill-${cls}">${c.passed ? "PASS" : "FAIL"}</span>
      </div>
      ${evidenceBlock}
      <button class="stage1-toggle-query" type="button">▶ Show query</button>
      <pre class="stage1-query hidden">${escapeHtml(c.query || "")}</pre>
    </div>`;
}


/* ── Utilities ────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}
