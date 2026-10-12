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
  let activeView = "overview";
  let activeThreadID = "";
  let threads = [];
  let schedules = [];
  let editingCommand = "";

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
      showLogin("انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.");
      throw new Error("يلزم تسجيل الدخول");
    }
    if (!response.ok || data.ok === false) throw new Error(data.error || `فشل الطلب (${response.status})`);
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
    if (days) return `${days} يوم · ${hours} س`;
    if (hours) return `${hours} س · ${minutes} د`;
    return `${minutes} دقيقة`;
  }

  function formatTime(value) {
    const date = new Date(Number(value || 0));
    if (!Number.isFinite(date.getTime()) || !Number(value)) return "";
    return new Intl.DateTimeFormat("ar", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(date);
  }

  function setConnection(online) {
    const state = $("#connectionState");
    state.classList.toggle("online", online);
    state.classList.toggle("offline", !online);
    state.querySelector("span").textContent = online ? "متصل" : "غير متصل";
  }

  async function loadOverview() {
    try {
      const [status, stats] = await Promise.all([apiRequest("/api/status"), apiRequest("/api/stats")]);
      const online = Boolean(status.online);
      $("#botStatus").textContent = online ? "متصل" : "متوقف";
      $("#botIdentity").textContent = status.botName || status.botID || "لا توجد جلسة نشطة";
      $("#uptimeValue").textContent = formatUptime(stats.uptime);
      $("#memoryValue").textContent = Number.isFinite(Number(stats.memMB)) ? `${stats.memMB} MB` : "—";
      $("#commandCount").textContent = Number.isFinite(Number(stats.commands)) ? String(stats.commands) : "—";
      setConnection(online);
      notice("#overviewMessage", online ? "مستمع Facebook يعمل على محرك Djamel-Fca." : "اللوحة تعمل، لكن لا توجد جلسة Facebook متصلة.", online ? "success" : "");
    } catch (error) {
      notice("#overviewMessage", error.message, "error");
      setConnection(false);
    }
  }

  function tableMessage(message, kind = "muted") {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = kind;
    cell.textContent = message;
    row.append(cell);
    return row;
  }

  async function loadCommands() {
    const rows = $("#commandRows");
    rows.replaceChildren(tableMessage("جارٍ تحميل الأوامر…"));
    try {
      const data = await apiRequest("/api/commands");
      const commands = Array.isArray(data.commands) ? data.commands : [];
      rows.replaceChildren();
      if (!commands.length) {
        rows.append(tableMessage("لا توجد أوامر محمّلة."));
        return;
      }
      commands.sort((a, b) => String(a.name).localeCompare(String(b.name), "ar"));
      for (const command of commands) {
        const row = document.createElement("tr");
        const name = document.createElement("td");
        name.className = "command-name";
        name.textContent = `/${command.name || ""}`;
        const category = document.createElement("td");
        category.textContent = command.category || "أخرى";
        const access = document.createElement("td");
        access.textContent = ["الجميع", "مشرف المجموعة", "مشرف البوت", "المالك"][Number(command.role)] || "مقيّدة";
        const description = document.createElement("td");
        description.textContent = command.description || (command.aliases || []).join("، ");
        const action = document.createElement("td");
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "button subtle table-action";
        edit.dataset.commandEdit = command.name || "";
        edit.textContent = "فتح المصدر";
        action.append(edit);
        row.append(name, category, access, description, action);
        rows.append(row);
      }
    } catch (error) {
      rows.replaceChildren(tableMessage(error.message, "notice error"));
    }
  }

  async function openCommandEditor(name) {
    editingCommand = String(name || "");
    notice("#editorMessage", "جارٍ تحميل المصدر…");
    $("#editorTitle").textContent = `تعديل /${editingCommand}`;
    $("#commandEditor").hidden = false;
    try {
      const data = await apiRequest(`/api/commands/${encodeURIComponent(editingCommand)}/source`);
      $("#commandSource").value = data.code || "";
      notice("#editorMessage", "");
      $("#commandEditor").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      $("#commandEditor").hidden = true;
      notice("#newCommandMessage", error.message, "error");
    }
  }

  async function loadAdmins() {
    try {
      const data = await apiRequest("/api/admins");
      $("#ownerID").value = data.ownerID || "";
      $("#adminIDs").value = (data.adminBot || []).join("\n");
      $("#superAdminIDs").value = (data.superAdminBot || []).join("\n");
    } catch (error) { notice("#adminsMessage", error.message, "error"); }
  }

  async function loadSettings() {
    try {
      const data = await apiRequest("/api/config");
      $("#configValue").value = JSON.stringify(data.config || {}, null, 2);
    } catch (error) { notice("#settingsMessage", error.message, "error"); }
  }

  async function loadLogs() {
    const output = $("#logOutput");
    output.textContent = "جارٍ التحميل…";
    try {
      const data = await apiRequest("/api/logs");
      const entries = data.logs || data.entries || data.items || [];
      const lines = Array.isArray(entries)
        ? entries.map(entry => typeof entry === "string" ? entry : `${entry.ts ? `[${entry.ts}] ` : ""}${entry.line || entry.text || entry.message || JSON.stringify(entry)}`)
        : [typeof entries === "string" ? entries : JSON.stringify(entries, null, 2)];
      output.textContent = lines.join("\n") || "لا توجد سجلات بعد.";
      output.scrollTop = output.scrollHeight;
    } catch (error) { output.textContent = error.message; }
  }

  function switchView(name) {
    activeView = name;
    document.querySelectorAll(".nav-item[data-view]").forEach(item => item.classList.toggle("active", item.dataset.view === name));
    document.querySelectorAll(".view").forEach(view => { view.hidden = view.id !== `view-${name}`; });
    if (name === "overview") loadOverview();
    if (name === "messenger") { loadThreads(); if (activeThreadID) loadMessages(activeThreadID); }
    if (name === "angel") { loadThreads(); loadAngel(); }
    if (name === "commands") loadCommands();
    if (name === "admins") loadAdmins();
    if (name === "settings") loadSettings();
    if (name === "logs") loadLogs();
  }

  async function loadThreads() {
    try {
      const data = await apiRequest("/api/messenger/threads");
      threads = Array.isArray(data.threads) ? data.threads : [];
      $("#threadCount").textContent = String(threads.length);
      populateAngelThreadSelect();
      renderThreads();
    } catch (error) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = error.message;
      $("#threadList").replaceChildren(empty);
    }
  }

  function renderThreads() {
    const list = $("#threadList");
    list.replaceChildren();
    const query = $("#threadSearch").value.trim().toLocaleLowerCase();
    const filtered = threads.filter(thread => `${thread.name || ""} ${thread.tid || ""}`.toLocaleLowerCase().includes(query));
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = query ? "لا توجد نتائج مطابقة." : "لا توجد محادثات ظاهرة حالياً.";
      list.append(empty);
      return;
    }
    for (const thread of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `thread-item${String(thread.tid) === activeThreadID ? " active" : ""}`;
      button.dataset.threadID = String(thread.tid || "");
      const name = document.createElement("strong");
      name.textContent = thread.name || `محادثة ${thread.tid}`;
      const snippet = document.createElement("span");
      snippet.className = "snippet";
      snippet.textContent = thread.lastBody || `${thread.type === "group" ? "مجموعة" : "محادثة"} · ${thread.tid}`;
      const meta = document.createElement("small");
      meta.textContent = `${thread.type === "group" ? "مجموعة" : "فردية"}${thread.memberCount ? ` · ${thread.memberCount} أعضاء` : ""}${thread.lastTs ? ` · ${formatTime(thread.lastTs)}` : ""}`;
      button.append(name, snippet, meta);
      list.append(button);
    }
  }

  async function selectThread(threadID) {
    activeThreadID = String(threadID || "");
    const thread = threads.find(item => String(item.tid) === activeThreadID);
    $("#conversationEmpty").hidden = Boolean(thread);
    $("#conversationBody").hidden = !thread;
    renderThreads();
    if (!thread) return;
    $("#conversationName").textContent = thread.name || `محادثة ${thread.tid}`;
    $("#conversationMeta").textContent = `${thread.type === "group" ? "مجموعة" : "محادثة فردية"} · ${thread.tid}`;
    $("#groupTitle").value = thread.name || "";
    await Promise.all([loadMessages(activeThreadID), loadThreadInfo(activeThreadID)]);
  }

  async function loadMessages(threadID) {
    if (!threadID) return;
    const list = $("#messageList");
    try {
      const data = await apiRequest(`/api/messenger/thread/${encodeURIComponent(threadID)}/messages`);
      list.replaceChildren();
      const messages = Array.isArray(data.messages) ? data.messages : [];
      if (!messages.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "لا توجد رسائل محفوظة منذ بدء تشغيل البوت.";
        list.append(empty);
      } else {
        for (const message of messages) {
          const bubble = document.createElement("div");
          bubble.className = `message-bubble${message.isFromBot ? " from-bot" : ""}`;
          const body = document.createElement("span");
          body.textContent = message.body || (message.attachments?.length ? "[مرفق]" : "");
          const meta = document.createElement("small");
          meta.className = "message-meta";
          meta.textContent = `${message.senderName || (message.isFromBot ? "البوت" : message.senderID || "مستخدم")}${message.ts ? ` · ${formatTime(message.ts)}` : ""}`;
          bubble.append(body, meta);
          list.append(bubble);
        }
      }
      list.scrollTop = list.scrollHeight;
    } catch (error) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = error.message;
      list.replaceChildren(empty);
    }
  }

  async function loadThreadInfo(threadID) {
    try {
      const data = await apiRequest(`/api/messenger/thread/${encodeURIComponent(threadID)}/info`);
      const info = data.info || {};
      const count = Array.isArray(info.participantIDs) ? info.participantIDs.length : 0;
      $("#conversationMeta").textContent = count ? `مجموعة · ${count} أعضاء · ${threadID}` : `المعرّف: ${threadID}`;
      if (info.threadName) {
        $("#groupTitle").value = info.threadName;
        const selected = threads.find(item => String(item.tid) === threadID);
        if (selected) selected.name = info.threadName;
        renderThreads();
      }
    } catch (_) {
      // Thread details are optional; the selected conversation remains usable.
    }
  }

  function populateAngelThreadSelect() {
    const select = $("#angelThreadSelect");
    const previous = select.value;
    select.replaceChildren(new Option("اكتب المعرّف يدوياً", ""));
    for (const thread of threads) {
      select.append(new Option(`${thread.name || thread.tid} · ${thread.tid}`, String(thread.tid)));
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  async function loadAngel() {
    const list = $("#angelSchedules");
    const loading = document.createElement("p");
    loading.className = "empty-state";
    loading.textContent = "جارٍ تحميل الجداول…";
    list.replaceChildren(loading);
    try {
      const data = await apiRequest("/api/angel/schedules");
      schedules = Array.isArray(data.schedules) ? data.schedules : [];
      $("#angelCount").textContent = String(schedules.length);
      renderAngelSchedules();
    } catch (error) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = error.message;
      list.replaceChildren(empty);
    }
  }

  function renderAngelSchedules() {
    const list = $("#angelSchedules");
    list.replaceChildren();
    if (!schedules.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "لا توجد جداول محفوظة.";
      list.append(empty);
      return;
    }
    for (const schedule of schedules) {
      const card = document.createElement("article");
      card.className = "schedule-card";
      const head = document.createElement("div");
      head.className = "schedule-head";
      const textGroup = document.createElement("div");
      const thread = threads.find(item => String(item.tid) === String(schedule.threadID));
      const threadName = document.createElement("div");
      threadName.className = "schedule-thread";
      threadName.textContent = thread?.name || `محادثة ${schedule.threadID}`;
      const meta = document.createElement("div");
      meta.className = "schedule-meta";
      meta.textContent = `${schedule.threadID} · كل ${schedule.intervalMinutes} دقيقة`;
      textGroup.append(threadName, meta);
      const badge = document.createElement("span");
      badge.className = `status-pill ${schedule.active ? "active" : "paused"}`;
      badge.textContent = schedule.active ? (schedule.running ? "يعمل" : "مفعّل") : "متوقف";
      head.append(textGroup, badge);
      const message = document.createElement("p");
      message.className = "schedule-text";
      message.textContent = schedule.message || "لم تُضبط رسالة.";
      const actions = document.createElement("div");
      actions.className = "schedule-actions";
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "button subtle"; edit.textContent = "تعديل"; edit.dataset.angelEdit = schedule.threadID;
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "button subtle"; toggle.textContent = schedule.active ? "إيقاف" : "تفعيل"; toggle.dataset.angelToggle = schedule.threadID;
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "button subtle"; remove.textContent = "حذف"; remove.dataset.angelDelete = schedule.threadID;
      actions.append(edit, toggle, remove);
      card.append(head, message, actions);
      list.append(card);
    }
  }

  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    notice("#loginMessage", "جارٍ تسجيل الدخول…");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: $("#loginPassword").value }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.token) throw new Error(data.error || "تعذر تسجيل الدخول.");
      token = data.token;
      tokenStore.set(token);
      $("#loginPassword").value = "";
      showApp();
    } catch (error) { notice("#loginMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });

  $("#logoutButton").addEventListener("click", async () => {
    try { await apiRequest("/api/logout", { method: "POST" }); } catch (_) {}
    showLogin();
  });
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#refreshAll").addEventListener("click", () => {
    loadOverview();
    if (activeView === "messenger") loadThreads();
    if (activeView === "angel") { loadThreads(); loadAngel(); }
  });

  $("#restartButton").addEventListener("click", async () => {
    const button = $("#restartButton");
    button.disabled = true;
    notice("#overviewMessage", "جارٍ طلب إعادة الاتصال…");
    try {
      await apiRequest("/api/control", { method: "POST", body: JSON.stringify({ action: "restart" }) });
      notice("#overviewMessage", "بدأت إعادة الاتصال. ستتحدث الحالة بعد تسجيل الدخول.", "success");
      setTimeout(loadOverview, 2500);
    } catch (error) { notice("#overviewMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });

  $("#reloadCommands").addEventListener("click", loadCommands);
  $("#refreshLogs").addEventListener("click", loadLogs);
  $("#commandRows").addEventListener("click", event => {
    const button = event.target.closest("[data-command-edit]");
    if (button) openCommandEditor(button.dataset.commandEdit);
  });
  $("#closeEditor").addEventListener("click", () => { $("#commandEditor").hidden = true; });
  $("#commandEditor").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await apiRequest(`/api/commands/${encodeURIComponent(editingCommand)}/source`, {
        method: "POST", body: JSON.stringify({ code: $("#commandSource").value }),
      });
      notice("#editorMessage", "تم حفظ الأمر وتحميله.", "success");
      await loadCommands();
    } catch (error) { notice("#editorMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#newCommandForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const data = await apiRequest("/api/commands/new", { method: "POST", body: JSON.stringify({ name: $("#newCommandName").value.trim() }) });
      $("#newCommandName").value = "";
      notice("#newCommandMessage", data.message || "تم إنشاء الأمر.", "success");
      await loadCommands();
    } catch (error) { notice("#newCommandMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });

  $("#adminsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const lines = selector => $(selector).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    button.disabled = true;
    try {
      await apiRequest("/api/admins", { method: "POST", body: JSON.stringify({
        ownerID: $("#ownerID").value.trim(), adminBot: lines("#adminIDs"), superAdminBot: lines("#superAdminIDs"),
      }) });
      notice("#adminsMessage", "تم حفظ الصلاحيات.", "success");
    } catch (error) { notice("#adminsMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#sessionForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const data = await apiRequest("/api/cookies", { method: "POST", body: JSON.stringify({ cookies: $("#sessionValue").value.trim() }) });
      $("#sessionValue").value = "";
      notice("#sessionMessage", `تم حفظ ${data.count || "الكوكيز"} وبدأت إعادة الاتصال.`, "success");
    } catch (error) { notice("#sessionMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#settingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const config = JSON.parse($("#configValue").value);
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("يجب أن تكون الإعدادات كائن JSON.");
      await apiRequest("/api/config", { method: "POST", body: JSON.stringify(config) });
      notice("#settingsMessage", "تم حفظ الإعدادات وتطبيقها.", "success");
    } catch (error) { notice("#settingsMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });

  $("#refreshThreads").addEventListener("click", loadThreads);
  $("#threadSearch").addEventListener("input", renderThreads);
  $("#threadList").addEventListener("click", event => {
    const button = event.target.closest("[data-thread-id]");
    if (button) selectThread(button.dataset.threadID);
  });
  $("#refreshMessages").addEventListener("click", () => loadMessages(activeThreadID));
  $("#messageForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeThreadID) return;
    const button = event.currentTarget.querySelector("button[type=submit]");
    const body = $("#messageText").value.trim();
    if (!body) return;
    button.disabled = true;
    try {
      await apiRequest("/api/messenger/send", { method: "POST", body: JSON.stringify({ threadID: activeThreadID, body }) });
      $("#messageText").value = "";
      await loadMessages(activeThreadID);
    } catch (error) { $("#conversationMeta").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#groupTitleForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!activeThreadID) return;
    const title = $("#groupTitle").value.trim();
    try {
      await apiRequest("/api/messenger/set-title", { method: "POST", body: JSON.stringify({ threadID: activeThreadID, title }) });
      const thread = threads.find(item => String(item.tid) === activeThreadID);
      if (thread) thread.name = title;
      $("#conversationName").textContent = title;
      renderThreads();
      notice("#groupTitleMessage", "تم تحديث اسم المجموعة.", "success");
    } catch (error) { notice("#groupTitleMessage", error.message, "error"); }
  });

  $("#refreshAngel").addEventListener("click", () => { loadThreads(); loadAngel(); });
  $("#angelThreadSelect").addEventListener("change", event => {
    if (event.currentTarget.value) $("#angelThreadID").value = event.currentTarget.value;
  });
  $("#clearAngelForm").addEventListener("click", () => {
    $("#angelForm").reset();
    $("#angelInterval").value = "10";
    $("#angelFormTitle").textContent = "إضافة رسالة دورية";
    notice("#angelMessage", "");
  });
  $("#angelForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await apiRequest("/api/angel/schedules", { method: "POST", body: JSON.stringify({
        threadID: $("#angelThreadID").value.trim(),
        message: $("#angelMessage").value.trim(),
        intervalMinutes: Number($("#angelInterval").value),
        active: $("#angelActive").checked,
      }) });
      notice("#angelMessage", "تم حفظ جدول Angel.", "success");
      await loadAngel();
    } catch (error) { notice("#angelMessage", error.message, "error"); }
    finally { button.disabled = false; }
  });
  $("#angelSchedules").addEventListener("click", async event => {
    const edit = event.target.closest("[data-angel-edit]");
    const toggle = event.target.closest("[data-angel-toggle]");
    const remove = event.target.closest("[data-angel-delete]");
    if (edit) {
      const schedule = schedules.find(item => String(item.threadID) === edit.dataset.angelEdit);
      if (!schedule) return;
      $("#angelThreadID").value = schedule.threadID;
      $("#angelThreadSelect").value = schedule.threadID;
      $("#angelMessage").value = schedule.message || "";
      $("#angelInterval").value = schedule.intervalMinutes || 10;
      $("#angelActive").checked = Boolean(schedule.active);
      $("#angelFormTitle").textContent = `تعديل جدول ${schedule.threadID}`;
      $("#angelForm").scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (toggle) {
      const schedule = schedules.find(item => String(item.threadID) === toggle.dataset.angelToggle);
      if (!schedule) return;
      try {
        await apiRequest("/api/angel/schedules", { method: "POST", body: JSON.stringify({ ...schedule, active: !schedule.active }) });
        notice("#angelMessage", !schedule.active ? "تم تفعيل الإرسال الدوري." : "تم إيقاف الإرسال الدوري.", "success");
        await loadAngel();
      } catch (error) { notice("#angelMessage", error.message, "error"); }
    } else if (remove) {
      const id = remove.dataset.angelDelete;
      if (!window.confirm(`حذف جدول Angel للمحادثة ${id}؟`)) return;
      try {
        await apiRequest(`/api/angel/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
        notice("#angelMessage", "تم حذف الجدول.", "success");
        await loadAngel();
      } catch (error) { notice("#angelMessage", error.message, "error"); }
    }
  });

  async function checkSavedToken() {
    if (!token) return;
    try { await apiRequest("/api/auth-check"); showApp(); }
    catch (_) { showLogin(); }
  }
  checkSavedToken();
  setInterval(() => {
    if (appView.hidden) return;
    loadOverview();
    if (activeView === "messenger") {
      loadThreads();
      if (activeThreadID) loadMessages(activeThreadID);
    }
    if (activeView === "angel") loadAngel();
  }, 15000);
})();
