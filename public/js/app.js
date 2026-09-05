(() => {
  "use strict";

  const CATEGORIES = [
    "Sales", "Purchases", "Rent", "Utilities", "Salaries",
    "Transport", "Supplies", "Maintenance", "Loan", "Other",
  ];

  const LS_SETTINGS = "apnakhata_settings";
  const SS_UNLOCKED = "apnakhata_unlocked"; // sessionStorage: cleared when the tab/browser closes
  const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000; // re-lock after 12 hours, same as before

  // ================= Supabase =================
  const SUPABASE_URL = "https://fqaqrpyxcsjwyqobjclo.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZxYXFycHl4Y3Nqd3lxb2JqY2xvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MjkxOTgsImV4cCI6MjEwNDEwNTE5OH0.I5DdazrCXtsxLTPPUSCJpHId-EU6gJBPj7tmGGkG8OI";
  const TABLE = "transactions";
  const supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const state = {
    transactions: [],
    editingId: null,
  };

  // Recovery-key reveal flow: holds the plaintext code only in memory, briefly,
  // between generating it and the user confirming they've saved it.
  let pendingRecoveryCode = null;
  let recoveryModalContext = "setup"; // "setup" (first PIN) or "regenerate" (from Settings)

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const money = (n) => "Rs " + Math.round(n || 0).toLocaleString("en-IN");
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  function showToast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => (el.hidden = true), 2600);
  }

  // ================= Transaction row <-> DB row mapping =================
  // DB columns: id (uuid/text pk), type, amount, category, note, date, created_at
  function rowFromDb(r) {
    return {
      _id: r.id,
      type: r.type,
      amount: Number(r.amount),
      category: r.category,
      note: r.note || "",
      date: r.date,
      createdAt: r.created_at,
    };
  }

  function rowToDb(t) {
    return {
      id: t._id,
      type: t.type,
      amount: t.amount,
      category: t.category,
      note: t.note || "",
      date: t.date,
      created_at: t.createdAt,
    };
  }

  function sortTransactions() {
    state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  // ================= Supabase data helpers =================
  async function loadAll() {
    const { data, error } = await supa
      .from(TABLE)
      .select("*")
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error(error);
      showToast("Couldn't load entries — check your connection.");
      state.transactions = [];
      return;
    }
    state.transactions = (data || []).map(rowFromDb);
  }

  async function insertTransaction(t) {
    const { error } = await supa.from(TABLE).insert(rowToDb(t));
    if (error) {
      console.error(error);
      throw new Error("Couldn't save that entry. Check your connection and try again.");
    }
  }

  async function updateTransaction(t) {
    const { error } = await supa.from(TABLE).update(rowToDb(t)).eq("id", t._id);
    if (error) {
      console.error(error);
      throw new Error("Couldn't save changes. Check your connection and try again.");
    }
  }

  async function deleteTransaction(id) {
    const { error } = await supa.from(TABLE).delete().eq("id", id);
    if (error) {
      console.error(error);
      throw new Error("Couldn't delete that entry. Check your connection and try again.");
    }
  }

  async function insertTransactions(list) {
    const { error } = await supa.from(TABLE).insert(list.map(rowToDb));
    if (error) {
      console.error(error);
      throw new Error("Couldn't import entries. Check your connection and try again.");
    }
  }

  async function deleteAllTransactions() {
    // Supabase requires a filter on delete; this matches every real row since
    // no transaction will ever have this sentinel id.
    const { error } = await supa.from(TABLE).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) {
      console.error(error);
      throw new Error("Couldn't clear entries from the cloud.");
    }
  }

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null");
    } catch {
      return null;
    }
  }

  function setSettings(settings) {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }

  // ================= Recovery key helpers =================
  // Avoids visually ambiguous characters (0/O, 1/I) since this is hand-copied.
  const RECOVERY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function genRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let code = "";
    for (let i = 0; i < 12; i++) code += RECOVERY_CHARS[bytes[i] % RECOVERY_CHARS.length];
    return code; // 12 raw characters; hashed and displayed via the helpers below
  }

  function formatRecoveryCode(code) {
    return code.match(/.{1,4}/g).join("-");
  }

  function normalizeRecoveryCode(input) {
    return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  async function showRecoveryModal(code, context) {
    pendingRecoveryCode = code;
    recoveryModalContext = context;
    $("#recovery-code-text").textContent = formatRecoveryCode(code);
    $("#recovery-confirm-check").checked = false;
    $("#recovery-continue").disabled = true;
    $("#recovery-modal").hidden = false;
  }

  // ================= PIN hashing (Web Crypto, PBKDF2-SHA256) =================
  async function derivePin(pin, saltHex) {
    const enc = new TextEncoder();
    const saltBytes = saltHex
      ? Uint8Array.from(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
      : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
      key,
      256
    );
    const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const usedSaltHex = Array.from(saltBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return { hashHex, saltHex: usedSaltHex };
  }

  function isUnlocked() {
    const raw = sessionStorage.getItem(SS_UNLOCKED);
    if (!raw) return false;
    const expires = Number(raw);
    if (!expires || Date.now() > expires) {
      sessionStorage.removeItem(SS_UNLOCKED);
      return false;
    }
    return true;
  }

  function markUnlocked() {
    sessionStorage.setItem(SS_UNLOCKED, String(Date.now() + UNLOCK_TTL_MS));
  }

  // ================= Lock screen =================
  function initLock() {
    const settings = getSettings();
    const isSet = !!settings;
    $("#lock-hint").hidden = isSet;
    $("#lock-copy").hidden = !isSet;
    $("#forgot-pin-link").hidden = !isSet;

    if (isSet && isUnlocked()) {
      $("#lock-screen").hidden = true;
      startApp();
    } else {
      sessionStorage.removeItem(SS_UNLOCKED);
      $("#lock-screen").hidden = false;
      $("#lock-pin").focus();
    }
  }

  function lock(message) {
    sessionStorage.removeItem(SS_UNLOCKED);
    $("#app").hidden = true;
    $("#lock-screen").hidden = false;
    $("#lock-error").hidden = !message;
    if (message) $("#lock-error").textContent = message;
    $("#lock-pin").value = "";
    initLockCopy();
    $("#lock-pin").focus();
  }

  function initLockCopy() {
    const isSet = !!getSettings();
    $("#lock-hint").hidden = isSet;
    $("#lock-copy").hidden = !isSet;
    $("#forgot-pin-link").hidden = !isSet;
  }

  $("#lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("#lock-pin").value.trim();
    $("#lock-error").hidden = true;

    if (!/^\d{4,8}$/.test(pin)) {
      $("#lock-error").hidden = false;
      $("#lock-error").textContent = "PIN must be 4 to 8 digits.";
      return;
    }

    const settings = getSettings();

    if (!settings) {
      // First time on this browser: this PIN becomes the lock, and we mint a
      // recovery key at the same time so a forgotten PIN isn't a dead end.
      const { hashHex, saltHex } = await derivePin(pin);
      const recoveryCode = genRecoveryCode();
      const { hashHex: recoveryHashHex, saltHex: recoverySaltHex } = await derivePin(recoveryCode);
      setSettings({ hashHex, saltHex, recoveryHashHex, recoverySaltHex });
      markUnlocked();
      $("#lock-screen").hidden = true;
      await showRecoveryModal(recoveryCode, "setup");
      return;
    }

    const { hashHex } = await derivePin(pin, settings.saltHex);
    if (hashHex !== settings.hashHex) {
      $("#lock-error").hidden = false;
      $("#lock-error").textContent = "Incorrect PIN.";
      $("#lock-pin").value = "";
      return;
    }

    markUnlocked();
    $("#lock-screen").hidden = true;
    await startApp();
  });

  $("#lock-now").addEventListener("click", () => lock());

  $("#recovery-confirm-check").addEventListener("change", (e) => {
    $("#recovery-continue").disabled = !e.target.checked;
  });

  $("#recovery-copy").addEventListener("click", async () => {
    if (!pendingRecoveryCode) return;
    try {
      await navigator.clipboard.writeText(formatRecoveryCode(pendingRecoveryCode));
      showToast("Recovery key copied");
    } catch {
      showToast("Couldn't copy — select and copy it manually.");
    }
  });

  $("#recovery-continue").addEventListener("click", async () => {
    $("#recovery-modal").hidden = true;
    const context = recoveryModalContext;
    pendingRecoveryCode = null;
    if (context === "setup") {
      await startApp();
    } else {
      showToast("Recovery key updated");
    }
  });

  // ================= Forgot PIN (reset via recovery key) =================
  $("#forgot-pin-link").addEventListener("click", () => {
    $("#reset-pin-form").reset();
    $("#reset-pin-error").hidden = true;
    $("#reset-pin-modal").hidden = false;
    $("#reset-recovery-code").focus();
  });

  $("#reset-pin-cancel").addEventListener("click", () => {
    $("#reset-pin-modal").hidden = true;
  });
  $("#reset-pin-modal").addEventListener("click", (e) => {
    if (e.target.id === "reset-pin-modal") $("#reset-pin-modal").hidden = true;
  });

  $("#reset-pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = normalizeRecoveryCode($("#reset-recovery-code").value);
    const newPin = $("#reset-new-pin").value.trim();
    const errorEl = $("#reset-pin-error");
    errorEl.hidden = true;

    if (!/^\d{4,8}$/.test(newPin)) {
      errorEl.hidden = false;
      errorEl.textContent = "New PIN must be 4 to 8 digits.";
      return;
    }

    const settings = getSettings();
    if (!settings || !settings.recoveryHashHex) {
      errorEl.hidden = false;
      errorEl.textContent = "No recovery key was set up for this ledger. Use Settings > Erase all data to start over.";
      return;
    }

    const { hashHex: candidateHash } = await derivePin(code, settings.recoverySaltHex);
    if (candidateHash !== settings.recoveryHashHex) {
      errorEl.hidden = false;
      errorEl.textContent = "That recovery key doesn't match.";
      return;
    }

    const { hashHex, saltHex } = await derivePin(newPin);
    setSettings({ ...settings, hashHex, saltHex });
    $("#reset-pin-modal").hidden = true;
    lock("PIN reset. Enter your new PIN to continue.");
  });

  $("#lock-pin-toggle").addEventListener("click", () => {
    const input = $("#lock-pin");
    const btn = $("#lock-pin-toggle");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
    btn.setAttribute("aria-pressed", String(!showing));
    input.focus();
  });

  // ================= Navigation =================
  function switchView(name) {
    $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
    $$(".nav-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    if (name === "cashbook") renderCashbook();
    if (name === "reports") renderReports();
  }
  $$(".nav-link").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
  $$("[data-view-link]").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.viewLink)));

  // ================= App start =================
  async function startApp() {
    $("#app").hidden = false;
    populateCategoryOptions();
    renderDashboard(); // render immediately with whatever's cached, then refresh
    await loadAll();
    refreshCurrentView();
  }

  function populateCategoryOptions() {
    const list = $("#category-options");
    list.innerHTML = CATEGORIES.map((c) => `<option value="${c}"></option>`).join("");
  }

  // ================= Dashboard =================
  function renderDashboard() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let balanceIn = 0, balanceOut = 0, monthIn = 0, monthOut = 0;
    state.transactions.forEach((t) => {
      const d = new Date(t.date);
      if (t.type === "in") balanceIn += t.amount; else balanceOut += t.amount;
      if (d >= monthStart) {
        if (t.type === "in") monthIn += t.amount; else monthOut += t.amount;
      }
    });

    $("#balance-figure").textContent = money(balanceIn - balanceOut);
    $("#stat-in").textContent = money(monthIn);
    $("#stat-out").textContent = money(monthOut);
    $("#stat-net").textContent = money(monthIn - monthOut);

    const recent = state.transactions.slice(0, 6);
    $("#recent-list").innerHTML = recent.map(rowHtml).join("") ||
      `<p class="empty-note">No entries yet. Add your first cash in or cash out above.</p>`;
    attachRowHandlers("#recent-list");
  }

  const ICON_IN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 19V5M6 13l6 6 6-6"/></svg>`;
  const ICON_OUT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14M6 11l6-6 6 6"/></svg>`;

  function rowHtml(t) {
    const d = new Date(t.date);
    const dateStr = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const sign = t.type === "in" ? "+" : "−";
    const cls = t.type === "in" ? "figure-in" : "figure-out";
    const iconCls = t.type === "in" ? "icon-in" : "icon-out";
    const icon = t.type === "in" ? ICON_IN : ICON_OUT;
    const note = t.note ? ` · ${escapeHtml(t.note)}` : "";
    return `
      <div class="ledger-row" data-id="${t._id}">
        <div class="ledger-left">
          <span class="ledger-icon ${iconCls}">${icon}</span>
          <div class="ledger-main">
            <span class="ledger-category">${escapeHtml(t.category)}</span>
            <span class="ledger-meta">${dateStr}${note}</span>
          </div>
        </div>
        <span class="ledger-amount ${cls}">${sign} ${money(t.amount)}</span>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function attachRowHandlers(containerSel) {
    $$(`${containerSel} .ledger-row`).forEach((row) => {
      row.addEventListener("click", () => openEntryModal(row.dataset.id));
    });
  }

  // ================= Cash Book =================
  function filteredTransactions({ from, to, type, search } = {}) {
    return state.transactions.filter((t) => {
      const d = new Date(t.date);
      if (from && d < new Date(from)) return false;
      if (to && d > new Date(to + "T23:59:59")) return false;
      if (type && t.type !== type) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!t.category.toLowerCase().includes(s) && !(t.note || "").toLowerCase().includes(s)) return false;
      }
      return true;
    });
  }

  function renderCashbook() {
    const rows = filteredTransactions({
      from: $("#filter-from").value,
      to: $("#filter-to").value,
      type: $("#filter-type").value,
      search: $("#filter-search").value.trim(),
    });
    $("#cashbook-list").innerHTML = rows.map(rowHtml).join("");
    $("#cashbook-empty").hidden = rows.length !== 0;
    attachRowHandlers("#cashbook-list");
  }

  ["change"].forEach((evt) => {
    $("#filter-from").addEventListener(evt, renderCashbook);
    $("#filter-to").addEventListener(evt, renderCashbook);
    $("#filter-type").addEventListener(evt, renderCashbook);
  });
  $("#filter-search").addEventListener("input", renderCashbook);
  $("#filter-clear").addEventListener("click", () => {
    $("#filter-from").value = "";
    $("#filter-to").value = "";
    $("#filter-type").value = "";
    $("#filter-search").value = "";
    renderCashbook();
  });

  // ================= Reports =================
  function renderReports() {
    const range = $("#report-range").value;
    let from = null;
    if (range !== "all") {
      const d = new Date();
      d.setDate(d.getDate() - Number(range));
      from = d.toISOString().slice(0, 10);
    }
    const rows = filteredTransactions({ from });

    let cashIn = 0, cashOut = 0;
    const byCategory = new Map(); // key: type|category
    rows.forEach((t) => {
      if (t.type === "in") cashIn += t.amount; else cashOut += t.amount;
      const key = t.type + "|" + t.category;
      byCategory.set(key, (byCategory.get(key) || 0) + t.amount);
    });

    $("#report-in").textContent = money(cashIn);
    $("#report-out").textContent = money(cashOut);
    $("#report-net").textContent = money(cashIn - cashOut);

    const catRows = Array.from(byCategory.entries())
      .map(([key, total]) => {
        const [type, category] = key.split("|");
        return { type, category, total };
      })
      .sort((a, b) => b.total - a.total);

    $("#report-empty").hidden = catRows.length !== 0;
    const max = Math.max(1, ...catRows.map((r) => r.total));

    $("#category-bars").innerHTML = catRows
      .map((r) => {
        const pct = Math.round((r.total / max) * 100);
        const cls = r.type === "out" ? "is-out" : "";
        return `
        <div class="bar-row">
          <span class="bar-label">${escapeHtml(r.category)}</span>
          <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
          <span class="bar-value">${money(r.total)}</span>
        </div>`;
      })
      .join("");
  }
  $("#report-range").addEventListener("change", renderReports);

  $("#export-csv").addEventListener("click", () => {
    const header = "Date,Type,Category,Amount,Note\n";
    const rows = state.transactions
      .map((t) => {
        const d = new Date(t.date).toISOString().slice(0, 10);
        const note = (t.note || "").replace(/"/g, '""');
        return `${d},${t.type},"${t.category}",${t.amount},"${note}"`;
      })
      .join("\n");
    downloadFile("apnakhata-transactions.csv", header + rows, "text/csv");
  });

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ================= Add / edit entry modal =================
  function openEntryModal(id) {
    state.editingId = id || null;
    const modal = $("#entry-modal");
    $("#entry-error").hidden = true;
    $("#entry-delete").hidden = !id;

    if (id) {
      const t = state.transactions.find((x) => x._id === id);
      $("#entry-modal-title").textContent = "Edit entry";
      $("#entry-id").value = id;
      setType(t.type);
      $("#entry-amount").value = t.amount;
      $("#entry-category").value = t.category;
      $("#entry-date").value = new Date(t.date).toISOString().slice(0, 10);
      $("#entry-note").value = t.note || "";
    } else {
      $("#entry-modal-title").textContent = "Add entry";
      $("#entry-form").reset();
      $("#entry-id").value = "";
      setType("in");
      $("#entry-date").value = todayISO();
    }
    modal.hidden = false;
    $("#entry-amount").focus();
  }

  function closeEntryModal() {
    $("#entry-modal").hidden = true;
  }

  function setType(type) {
    $("#entry-type").value = type;
    $$(".type-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.type === type));
  }
  $$(".type-btn").forEach((b) => b.addEventListener("click", () => setType(b.dataset.type)));

  $$("[data-quick]").forEach((b) =>
    b.addEventListener("click", () => {
      openEntryModal(null);
      setType(b.dataset.quick);
    })
  );

  $("#entry-cancel").addEventListener("click", closeEntryModal);
  $("#entry-modal").addEventListener("click", (e) => {
    if (e.target.id === "entry-modal") closeEntryModal();
  });

  function validateEntry({ type, amount, category, date }) {
    if (type !== "in" && type !== "out") return "Type must be cash in or cash out.";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return "Enter a valid amount.";
    if (!category) return "Category is required.";
    if (isNaN(new Date(date).getTime())) return "Enter a valid date.";
    return null;
  }

  $("#entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#entry-id").value;
    const payload = {
      type: $("#entry-type").value,
      amount: Number($("#entry-amount").value),
      category: $("#entry-category").value.trim().slice(0, 40),
      date: $("#entry-date").value,
      note: $("#entry-note").value.trim().slice(0, 200),
    };

    const error = validateEntry(payload);
    if (error) {
      $("#entry-error").hidden = false;
      $("#entry-error").textContent = error;
      return;
    }

    const submitBtn = $("#entry-form [type=submit]");
    if (submitBtn) submitBtn.disabled = true;

    try {
      if (id) {
        const idx = state.transactions.findIndex((t) => t._id === id);
        const updated = { ...state.transactions[idx], ...payload, date: new Date(payload.date).toISOString() };
        await updateTransaction(updated);
        if (idx !== -1) state.transactions[idx] = updated;
        showToast("Entry updated");
      } else {
        const created = {
          _id: uid(),
          ...payload,
          date: new Date(payload.date).toISOString(),
          createdAt: new Date().toISOString(),
        };
        await insertTransaction(created);
        state.transactions.unshift(created);
        showToast("Entry added");
      }

      sortTransactions();
      closeEntryModal();
      refreshCurrentView();
    } catch (err) {
      $("#entry-error").hidden = false;
      $("#entry-error").textContent = err.message;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $("#entry-delete").addEventListener("click", async () => {
    const id = $("#entry-id").value;
    if (!id) return;
    if (!confirm("Delete this entry? This can't be undone.")) return;
    try {
      await deleteTransaction(id);
      state.transactions = state.transactions.filter((t) => t._id !== id);
      showToast("Entry deleted");
      closeEntryModal();
      refreshCurrentView();
    } catch (err) {
      $("#entry-error").hidden = false;
      $("#entry-error").textContent = err.message;
    }
  });

  function refreshCurrentView() {
    const active = $(".view.is-active").id.replace("view-", "");
    if (active === "dashboard") renderDashboard();
    if (active === "cashbook") renderCashbook();
    if (active === "reports") renderReports();
  }

  // ================= Settings =================
  $("#change-pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const currentPin = $("#current-pin").value.trim();
    const newPin = $("#new-pin").value.trim();
    const status = $("#pin-status");
    status.hidden = true;
    status.classList.remove("is-success");

    if (!/^\d{4,8}$/.test(newPin)) {
      status.hidden = false;
      status.textContent = "New PIN must be 4 to 8 digits.";
      return;
    }

    const settings = getSettings();
    if (settings) {
      const { hashHex } = await derivePin(currentPin, settings.saltHex);
      if (hashHex !== settings.hashHex) {
        status.hidden = false;
        status.textContent = "Current PIN is incorrect.";
        return;
      }
    }

    const next = await derivePin(newPin);
    setSettings({ ...settings, ...next });
    status.hidden = false;
    status.classList.add("is-success");
    status.textContent = "PIN updated.";
    $("#change-pin-form").reset();
  });

  $("#regen-recovery-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("#regen-recovery-pin").value.trim();
    const status = $("#regen-recovery-status");
    status.hidden = true;
    status.classList.remove("is-success");

    const settings = getSettings();
    if (!settings) return;

    const { hashHex } = await derivePin(pin, settings.saltHex);
    if (hashHex !== settings.hashHex) {
      status.hidden = false;
      status.textContent = "Current PIN is incorrect.";
      return;
    }

    const recoveryCode = genRecoveryCode();
    const { hashHex: recoveryHashHex, saltHex: recoverySaltHex } = await derivePin(recoveryCode);
    setSettings({ ...settings, recoveryHashHex, recoverySaltHex });
    $("#regen-recovery-form").reset();
    await showRecoveryModal(recoveryCode, "regenerate");
  });

  $("#backup-json").addEventListener("click", () => {
    downloadFile(
      "apnakhata-backup-" + todayISO() + ".json",
      JSON.stringify(state.transactions, null, 2),
      "application/json"
    );
  });

  $("#restore-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    const status = $("#restore-status");
    status.hidden = true;
    status.classList.remove("is-success");
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("That file doesn't look like an ApnaKhata backup.");

      const valid = parsed.filter((t) => t && (t.type === "in" || t.type === "out") && Number.isFinite(Number(t.amount)));
      const withIds = valid.map((t) => ({
        _id: t._id || uid(),
        type: t.type,
        amount: Number(t.amount),
        category: String(t.category || "Other").slice(0, 40),
        note: String(t.note || "").slice(0, 200),
        date: new Date(t.date).toISOString(),
        createdAt: t.createdAt || new Date().toISOString(),
      }));

      if (!confirm(`Import ${withIds.length} entries? They'll be added alongside what's already here (duplicates possible if you restore the same file twice).`)) {
        e.target.value = "";
        return;
      }

      await insertTransactions(withIds);
      state.transactions = state.transactions.concat(withIds);
      sortTransactions();
      status.hidden = false;
      status.classList.add("is-success");
      status.textContent = `Imported ${withIds.length} entries.`;
      refreshCurrentView();
    } catch (err) {
      status.hidden = false;
      status.textContent = "Couldn't read that file: " + err.message;
    } finally {
      e.target.value = "";
    }
  });

  $("#reset-all").addEventListener("click", async () => {
    if (!confirm("Erase every entry from the cloud and the PIN stored in this browser? This cannot be undone.")) return;
    try {
      await deleteAllTransactions();
    } catch (err) {
      showToast(err.message);
      return;
    }
    localStorage.removeItem(LS_SETTINGS);
    sessionStorage.removeItem(SS_UNLOCKED);
    location.reload();
  });

  // ================= Login (Supabase Auth) =================
  $("#login-password-toggle").addEventListener("click", () => {
    const input = $("#login-password");
    const btn = $("#login-password-toggle");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.textContent = showing ? "Show" : "Hide";
    btn.setAttribute("aria-pressed", String(!showing));
    input.focus();
  });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    $("#login-error").hidden = true;

    const submitBtn = $("#login-form [type=submit]");
    if (submitBtn) submitBtn.disabled = true;
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if (submitBtn) submitBtn.disabled = false;

    if (error) {
      $("#login-error").hidden = false;
      $("#login-error").textContent = "Couldn't log in — check your email and password.";
      return;
    }

    setAccountEmail(data.user && data.user.email);
    $("#login-screen").hidden = true;
    initLock();
  });

  function setAccountEmail(email) {
    $("#account-email").textContent = email || "—";
  }

  $("#logout-btn").addEventListener("click", async () => {
    if (!confirm("Log out of ApnaKhata? You'll need your email and password to log back in.")) return;
    await supa.auth.signOut();
    sessionStorage.removeItem(SS_UNLOCKED);
    $("#app").hidden = true;
    $("#lock-screen").hidden = true;
    $("#login-screen").hidden = false;
    $("#login-email").value = "";
    $("#login-password").value = "";
    $("#login-error").hidden = true;
    $("#login-email").focus();
  });

  // ================= Init =================
  // Real access control starts here: no Supabase session means no PIN screen,
  // no dashboard, and (once the RLS policy is updated) no data either.
  async function initAuth() {
    const { data: { session } } = await supa.auth.getSession();
    if (session) {
      setAccountEmail(session.user && session.user.email);
      $("#login-screen").hidden = true;
      initLock();
    } else {
      $("#login-screen").hidden = false;
      $("#login-email").focus();
    }
  }
  initAuth();
})();
