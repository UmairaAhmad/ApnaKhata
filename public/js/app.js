(() => {
  "use strict";

  const CATEGORIES = [
    "Sales", "Purchases", "Rent", "Utilities", "Salaries",
    "Transport", "Supplies", "Maintenance", "Loan", "Other",
  ];

  const LS_TRANSACTIONS = "apnakhata_transactions";
  const LS_SETTINGS = "apnakhata_settings";
  const SS_UNLOCKED = "apnakhata_unlocked"; // sessionStorage: cleared when the tab/browser closes
  const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000; // re-lock after 12 hours, same as before

  const state = {
    transactions: [],
    editingId: null,
  };

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

  // ================= Local storage helpers =================
  function loadAll() {
    try {
      const raw = localStorage.getItem(LS_TRANSACTIONS);
      state.transactions = raw ? JSON.parse(raw) : [];
    } catch {
      state.transactions = [];
    }
    state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  function saveAll() {
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(state.transactions));
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
      // First time on this browser: this PIN becomes the lock.
      const { hashHex, saltHex } = await derivePin(pin);
      setSettings({ hashHex, saltHex });
      markUnlocked();
      $("#lock-screen").hidden = true;
      startApp();
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
    startApp();
  });

  $("#lock-now").addEventListener("click", () => lock());

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
  function startApp() {
    $("#app").hidden = false;
    populateCategoryOptions();
    loadAll();
    renderDashboard();
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

  function rowHtml(t) {
    const d = new Date(t.date);
    const dateStr = d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    const sign = t.type === "in" ? "+" : "−";
    const cls = t.type === "in" ? "figure-in" : "figure-out";
    const note = t.note ? ` · ${escapeHtml(t.note)}` : "";
    return `
      <div class="ledger-row" data-id="${t._id}">
        <div class="ledger-main">
          <span class="ledger-category">${escapeHtml(t.category)}</span>
          <span class="ledger-meta">${dateStr}${note}</span>
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

  $("#entry-form").addEventListener("submit", (e) => {
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

    if (id) {
      const idx = state.transactions.findIndex((t) => t._id === id);
      if (idx !== -1) {
        state.transactions[idx] = { ...state.transactions[idx], ...payload, date: new Date(payload.date).toISOString() };
      }
      showToast("Entry updated");
    } else {
      state.transactions.unshift({
        _id: uid(),
        ...payload,
        date: new Date(payload.date).toISOString(),
        createdAt: new Date().toISOString(),
      });
      showToast("Entry added");
    }

    loadAllFromMemorySortAndSave();
    closeEntryModal();
    refreshCurrentView();
  });

  function loadAllFromMemorySortAndSave() {
    state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date) || (b.createdAt || "").localeCompare(a.createdAt || ""));
    saveAll();
  }

  $("#entry-delete").addEventListener("click", () => {
    const id = $("#entry-id").value;
    if (!id) return;
    if (!confirm("Delete this entry? This can't be undone.")) return;
    state.transactions = state.transactions.filter((t) => t._id !== id);
    saveAll();
    showToast("Entry deleted");
    closeEntryModal();
    refreshCurrentView();
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
    setSettings(next);
    status.hidden = false;
    status.classList.add("is-success");
    status.textContent = "PIN updated.";
    $("#change-pin-form").reset();
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

      state.transactions = state.transactions.concat(withIds);
      loadAllFromMemorySortAndSave();
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

  $("#reset-all").addEventListener("click", () => {
    if (!confirm("Erase every entry and PIN stored in this browser? This cannot be undone.")) return;
    localStorage.removeItem(LS_TRANSACTIONS);
    localStorage.removeItem(LS_SETTINGS);
    sessionStorage.removeItem(SS_UNLOCKED);
    location.reload();
  });

  // ================= Init =================
  initLock();
})();
