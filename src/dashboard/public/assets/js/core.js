"use strict";

(() => {
  const $ = selector => document.querySelector(selector);
  const loginView = $("#loginView");
  const appView = $("#appView");
  const tokenStore = {
    get() { try { return sessionStorage.getItem("djamel-core-token") || ""; } catch (_) { return ""; } },
    set(value) { try { sessionStorage.setItem("djamel-core-token", value); } catch (_) {} },
    clear() { try { sessionStorage.removeItem("djamel-core-token"); } catch (_) {} },
  };
  let token = tokenStore.get();

  function notice(selector, message, kind = "") {
    const element = $(selector);
    if (!element) return;
    element.textContent = message || "";
    element.className = `notice${kind ? ` ${kind}` : ""}`;
  }

  function showLogin(message = "") {
    token = "";
    tokenStore.clear();
    loginView.hidden = false;
    appView.hidden = true;
    notice("#loginMessage", message, message ? "error" : "");
  }

  async function apiRequest(url, options = {}) {
    const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
    if (token) headers["x-core-token"] = token;
    const response = await fetch(url, { ...options, headers });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (response.status === 401) {
      showLogin("Your dashboard session expired. Sign in again.");
      throw new Error("Authentication required");
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    loadOverview();
  }

  function formatUptime(milliseconds) {
    const total = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  async function loadOverview() {
    try {
      const [status, stats] = await Promise.all([
        apiRequest("/api/status"),
        apiRequest("/api/stats"),
      ]);
      const online = Boolean(status.online);
      $("#botStatus").textContent = online ? "Online" : "Offline";
      $("#botIdentity").textContent = status.botName || status.botID || "No active session";
      $("#uptimeValue").textContent = formatUptime(stats.uptime);
      $("#memoryValue").textContent = Number.isFinite(Number(stats.memMB)) ? `${stats.memMB} MB` : "—";
      const state = $("#connectionState");
      state.classList.toggle("online", online);
      state.classList.toggle("offline", !online);
      state.lastChild.textContent = online ? " Online" : " Offline";
      const count = Number(stats.commands);
      $("#commandCount").textContent = Number.isFinite(count) ? String(count) : "—";
      notice("#overviewMessage", online ? "Facebook listener is active." : "Dashboard is running; no Facebook session is connected.", online ? "success" : "");
    } catch (error) {
      notice("#overviewMessage", error.message, "error");
    }
  }

  async function loadCommands() {
    const rows = $("#commandRows");
    rows.replaceChildren();
    try {
      const data = await apiRequest("/api/commands");
      const commands = Array.isArray(data.commands) ? data.commands : [];
      if (!commands.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 4;
        cell.className = "muted";
        cell.textContent = "No commands are currently loaded.";
        row.append(cell);
        rows.append(row);
        return;
      }
      for (const command of commands) {
        const row = document.createElement("tr");
        const name = document.createElement("td");
        name.className = "command-name";
        name.textContent = `/${command.name || ""}`;
        const category = document.createElement("td");
        category.textContent = command.category || "Other";
        const access = document.createElement("td");
        access.textContent = ["Everyone", "Group admin", "Bot admin", "Owner"][Number(command.role)] || "Restricted";
        const description = document.createElement("td");
        description.textContent = command.description || (command.aliases || []).join(", ");
        row.append(name, category, access, description);
        rows.append(row);
      }
    } catch (error) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.className = "notice error";
      cell.textContent = error.message;
      row.append(cell);
      rows.append(row);
    }
  }

  async function loadAdmins() {
    try {
      const data = await apiRequest("/api/admins");
      $("#ownerID").value = data.ownerID || "";
      $("#adminIDs").value = (data.adminBot || []).join("\n");
      $("#superAdminIDs").value = (data.superAdminBot || []).join("\n");
    } catch (error) {
      notice("#adminsMessage", error.message, "error");
    }
  }

  async function loadSettings() {
    try {
      const data = await apiRequest("/api/config");
      $("#configValue").value = JSON.stringify(data.config || {}, null, 2);
    } catch (error) {
      notice("#settingsMessage", error.message, "error");
    }
  }

  async function loadLogs() {
    const output = $("#logOutput");
    output.textContent = "Loading…";
    try {
      const data = await apiRequest("/api/logs");
      const entries = data.logs || data.entries || data.items || [];
      const lines = Array.isArray(entries)
        ? entries.map(entry => typeof entry === "string" ? entry : `${entry.ts ? `[${entry.ts}] ` : ""}${entry.line || entry.text || entry.message || JSON.stringify(entry)}`)
        : [typeof entries === "string" ? entries : JSON.stringify(entries, null, 2)];
      output.textContent = lines.join("\n") || "No log entries yet.";
      output.scrollTop = output.scrollHeight;
    } catch (error) {
      output.textContent = error.message;
    }
  }

  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const password = $("#loginPassword").value;
    button.disabled = true;
    notice("#loginMessage", "Signing in…");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.token) throw new Error(data.error || "Sign-in failed.");
      token = data.token;
      tokenStore.set(token);
      $("#loginPassword").value = "";
      notice("#loginMessage", "");
      showApp();
    } catch (error) {
      notice("#loginMessage", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#logoutButton").addEventListener("click", async () => {
    try { await apiRequest("/api/logout", { method: "POST" }); } catch (_) {}
    showLogin();
  });

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item === button));
      document.querySelectorAll(".view").forEach(view => { view.hidden = view.id !== `view-${button.dataset.view}`; });
      if (button.dataset.view === "commands") loadCommands();
      if (button.dataset.view === "admins") loadAdmins();
      if (button.dataset.view === "settings") loadSettings();
      if (button.dataset.view === "logs") loadLogs();
      if (button.dataset.view === "overview") loadOverview();
    });
  });

  $("#restartButton").addEventListener("click", async () => {
    const button = $("#restartButton");
    button.disabled = true;
    notice("#overviewMessage", "Requesting Facebook reconnect…");
    try {
      await apiRequest("/api/control", { method: "POST", body: JSON.stringify({ action: "restart" }) });
      notice("#overviewMessage", "Reconnect started. The status will update when login completes.", "success");
      setTimeout(loadOverview, 2500);
    } catch (error) {
      notice("#overviewMessage", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#reloadCommands").addEventListener("click", loadCommands);
  $("#refreshLogs").addEventListener("click", loadLogs);

  $("#adminsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    const lines = selector => $(selector).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    try {
      await apiRequest("/api/admins", {
        method: "POST",
        body: JSON.stringify({
          ownerID: $("#ownerID").value.trim(),
          adminBot: lines("#adminIDs"),
          superAdminBot: lines("#superAdminIDs"),
        }),
      });
      notice("#adminsMessage", "Admin settings saved.", "success");
    } catch (error) {
      notice("#adminsMessage", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#sessionForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const cookies = $("#sessionValue").value.trim();
    button.disabled = true;
    try {
      const data = await apiRequest("/api/cookies", { method: "POST", body: JSON.stringify({ cookies }) });
      $("#sessionValue").value = "";
      notice("#sessionMessage", `Saved ${data.count || "valid"} cookies; reconnect started.`, "success");
    } catch (error) {
      notice("#sessionMessage", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  $("#settingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const config = JSON.parse($("#configValue").value);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Configuration must be a JSON object.");
      await apiRequest("/api/config", { method: "POST", body: JSON.stringify(config) });
      notice("#settingsMessage", "Settings saved and applied.", "success");
    } catch (error) {
      notice("#settingsMessage", error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  async function checkSavedToken() {
    if (!token) return;
    try {
      await apiRequest("/api/auth-check");
      showApp();
    } catch (_) {
      showLogin();
    }
  }
  checkSavedToken();
  setInterval(() => { if (!appView.hidden) loadOverview(); }, 15000);
})();
