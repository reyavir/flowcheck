/* ── Tab switching ─────────────────────────────────────────────────────── */

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
  document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add("active");
  document.getElementById("tab-" + tabName).classList.remove("hidden");
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// "Go to mapping tab" link in the no-mapping hint
document.getElementById("go-to-mapping-btn")?.addEventListener("click", () => {
  switchTab("mapping");
});

/* ── Setup checklist ─────────────────────────────────────────────────── */

document.getElementById("setup-steps")?.addEventListener("click", e => {
  const check = e.target.closest(".setup-num");
  if (check) {
    const on = check.classList.toggle("is-done");
    check.setAttribute("aria-pressed", on ? "true" : "false");
    return;
  }
  const goto = e.target.closest(".setup-goto");
  if (!goto) return;
  switchTab(goto.dataset.tab);
  const target = document.getElementById(goto.dataset.target);
  if (target) {
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
});

/* ── Element list scan ─────────────────────────────────────────────────── */

const scanSourceInput = document.getElementById("scan-source-input");
const scanBtn         = document.getElementById("scan-btn");
const scanResult      = document.getElementById("scan-result");
const mappingErrorBox = document.getElementById("mapping-error-box");

scanBtn.addEventListener("click", async () => {
  const source_dir = scanSourceInput.value.trim();
  if (!source_dir) return;

  scanBtn.disabled  = true;
  scanBtn.innerHTML = `<span class="spinner"></span>Scanning…`;
  scanResult.classList.add("hidden");
  mappingErrorBox.classList.add("hidden");

  try {
    const res  = await fetch("/mapping/scan", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ source_dir }),
    });
    const data = await res.json();

    if (!data.success) {
      mappingErrorBox.innerHTML = `
        <div class="error-header">
          <span class="error-badge">Error</span>
          <span class="error-title">Scan failed</span>
        </div>
        <div class="error-message">${escapeHtml(data.error || "Unknown error.")}</div>`;
      mappingErrorBox.classList.remove("hidden");
      return;
    }

    scanResult.className = "inject-result inject-pass";
    scanResult.innerHTML = `
      <strong>Done.</strong>
      Found ${data.elements} element${data.elements === 1 ? "" : "s"};
      wrote <code>${escapeHtml(data.path)}</code>.`;
    scanResult.classList.remove("hidden");

    // Reload the chip reference panel on the parser tab so it picks up new ids.
    if (typeof loadElementReference === "function") loadElementReference();

  } catch {
    mappingErrorBox.innerHTML = `
      <div class="error-header">
        <span class="error-badge">Error</span>
        <span class="error-title">Network error</span>
      </div>
      <div class="error-message">Is the server running?</div>`;
    mappingErrorBox.classList.remove("hidden");
  } finally {
    scanBtn.disabled  = false;
    scanBtn.innerHTML = "Refresh element list";
  }
});


/* ── Build CodeQL database ───────────────────────────────────────────── */
const mappingDbSrcInput   = document.getElementById("mapping-db-src-input");
const mappingDbPathInput  = document.getElementById("mapping-db-path-input");
const mappingBuildDbBtn   = document.getElementById("mapping-build-db-btn");
const mappingBuildDbResult = document.getElementById("mapping-build-db-result");

mappingBuildDbBtn?.addEventListener("click", async () => {
  const source_dir = mappingDbSrcInput.value.trim();
  const db_path    = mappingDbPathInput.value.trim();
  if (!source_dir) return;

  mappingBuildDbBtn.disabled  = true;
  mappingBuildDbBtn.innerHTML = `<span class="spinner"></span>Building…`;
  mappingBuildDbResult.classList.add("hidden");

  try {
    const res  = await fetch("/codeql/rebuild", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ source_dir, db_path }),
    });
    const data = await res.json();

    if (data.success) {
      const appDir = data.app_dir
        ? ` Now serving <code>${escapeHtml(data.app_dir)}</code> at <code>/run/</code>.`
        : "";
      mappingBuildDbResult.className = "inject-result inject-pass";
      mappingBuildDbResult.innerHTML =
        `<strong>CodeQL DB built</strong> at <code>${escapeHtml(data.db_path)}</code>.${appDir}`;
      // Tell the constraint builder overlay (and any other listeners) to
      // refresh, so the lanes/dropdowns pick up the new mapping.
      window.dispatchEvent(new CustomEvent("cv:app-changed", {
        detail: { app_dir: data.app_dir, db_path: data.db_path },
      }));
    } else {
      mappingBuildDbResult.className = "inject-result inject-fail";
      mappingBuildDbResult.innerHTML =
        `<strong>Build failed:</strong> ${escapeHtml(data.error || "unknown")}`;
    }
    mappingBuildDbResult.classList.remove("hidden");

  } catch {
    mappingBuildDbResult.className = "inject-result inject-fail";
    mappingBuildDbResult.innerHTML =
      `<strong>Network error</strong> — is the server running?`;
    mappingBuildDbResult.classList.remove("hidden");
  } finally {
    mappingBuildDbBtn.disabled  = false;
    mappingBuildDbBtn.innerHTML = "Build / rebuild DB";
  }
});


/* ── Inject IDs into source ──────────────────────────────────────────── */
const sourceInput   = document.getElementById("source-path-input");
const injectBtn     = document.getElementById("inject-btn");
const injectWarning = document.getElementById("inject-warning");
const injectResult  = document.getElementById("inject-result");

injectBtn.addEventListener("click", () => runInject(false));

async function runInject(confirmed) {
  const source_dir = sourceInput.value.trim();
  if (!source_dir) return;

  injectBtn.disabled  = true;
  injectBtn.innerHTML = `<span class="spinner"></span>Working…`;
  injectWarning.classList.add("hidden");
  injectResult.classList.add("hidden");

  try {
    const res  = await fetch("/instrument", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ source_dir, confirmed }),
    });
    const data = await res.json();

    if (data.needs_confirmation && data.reason === "no_git") {
      injectWarning.innerHTML = `
        <div class="inject-warning-title">No git repository found</div>
        <div class="inject-warning-body">
          The script will modify your source files directly at
          <code>${escapeHtml(data.path)}</code>.
          A <code>.bak</code> copy will be written alongside every modified
          file before changes are applied.
        </div>
        <div class="inject-warning-actions">
          <button id="inject-cancel"  class="btn-cancel">Cancel</button>
          <button id="inject-proceed" class="btn-parse">Proceed</button>
        </div>`;
      injectWarning.classList.remove("hidden");
      document.getElementById("inject-cancel").onclick  = () => injectWarning.classList.add("hidden");
      document.getElementById("inject-proceed").onclick = () => runInject(true);
      return;
    }

    if (!data.success) {
      injectResult.className = "inject-result inject-fail";
      injectResult.innerHTML = `<strong>Error:</strong> ${escapeHtml(data.error || "Unknown error.")}`;
      injectResult.classList.remove("hidden");
      return;
    }

    const fileList = data.files_changed.length
      ? `<ul class="inject-file-list">${
          data.files_changed.map(f => `<li>${escapeHtml(f)}</li>`).join("")
        }</ul>`
      : `<p>No files needed changes.</p>`;

    const backupNote = data.backups_made && data.backups_made.length
      ? `<p class="inject-backup-note">${data.backups_made.length} backup file(s) written.</p>`
      : "";

    injectResult.className = "inject-result inject-pass";
    injectResult.innerHTML = `
      <strong>Done.</strong>
      Added ${data.html_ids_added} HTML id${data.html_ids_added === 1 ? "" : "s"}
      and ${data.js_ids_added} JS id${data.js_ids_added === 1 ? "" : "s"}
      across ${data.files_changed.length} file${data.files_changed.length === 1 ? "" : "s"}.
      ${backupNote}
      ${fileList}`;
    injectResult.classList.remove("hidden");

  } catch {
    injectResult.className = "inject-result inject-fail";
    injectResult.innerHTML = `<strong>Network error</strong> — is the server running?`;
    injectResult.classList.remove("hidden");
  } finally {
    injectBtn.disabled  = false;
    injectBtn.innerHTML = "Add IDs";
  }
}


/* ── Helpers ──────────────────────────────────────────────────────────── */
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
