const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  site: null,
  leadId: sessionStorage.getItem("leadId") || "",
  leadName: sessionStorage.getItem("leadName") || "",
  token: sessionStorage.getItem("adminToken") || "",
  cursor: new Date(),
  selected: "",
  adminTab: "leads",
  adminData: null,
  dayMode: false,
};

const SLOT_LABELS = {
  hero: "Обложка",
  about: "Обо мне",
  p0: "Портфолио 1",
  p1: "Портфолио 2",
  p2: "Портфолио 3",
  p3: "Портфолио 4",
  p4: "Портфолио 5",
  p5: "Портфолио 6",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function money(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("ru-RU").format(number) + " ₽";
}

function todayISO() {
  const now = new Date();
  return iso(now.getFullYear(), now.getMonth(), now.getDate());
}

function iso(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthLabel(date) {
  return date.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (state.token) headers["X-Admin-Token"] = state.token;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Не получилось выполнить запрос");
  return data;
}

function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3200);
}

function applyTheme(theme = {}) {
  const root = document.documentElement;
  if (theme.bg) root.style.setProperty("--bg", theme.bg);
  if (theme.bg2) root.style.setProperty("--bg2", theme.bg2);
  if (theme.text) root.style.setProperty("--text", theme.text);
  if (theme.muted) root.style.setProperty("--muted", theme.muted);
  if (theme.accent) root.style.setProperty("--accent", theme.accent);
}

function photoUrl(slot) {
  const path = state.site?.photos?.[slot];
  if (!path) return "";
  return `${path}?v=${state.site.photoVersion || 1}`;
}

function mediaHtml(slot, mark) {
  const url = photoUrl(slot);
  if (url) return `<img src="${esc(url)}" alt="">`;
  return `<div class="placeholder">${mark ? `<span class="monogram">${esc(mark)}</span>` : ""}</div>`;
}

function renderContacts() {
  const phone = state.site.phone || "";
  const display = state.site.phoneDisplay || phone;
  ["navPhone", "heroCall", "footPhone", "modalCall"].forEach((id) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.href = `tel:${phone}`;
    if (id !== "heroCall" && id !== "modalCall") node.textContent = display;
  });
  $("#floatCall").onclick = () => { window.location.href = `tel:${phone}`; };
  $("#heroLocation").textContent = state.site.location || "";
  $("#cabinetBtn").hidden = !state.token;
}

function renderCourses() {
  $("#courseList").innerHTML = state.site.courses.map((course) => `
    <article class="course reveal">
      <em>${course.status === "open" ? "идёт набор" : "скоро"}</em>
      <h3>${esc(course.title)}</h3>
      <p>${esc(course.summary)}</p>
      <p>${esc(course.level)} · ${esc(course.duration)}</p>
    </article>`).join("");
}

function renderPrices() {
  const cards = [
    ...state.site.courses.map((course) => ({
      kicker: course.status === "open" ? "группа" : "скоро",
      title: course.title,
      price: course.status === "open" ? money(course.price) : "скоро",
      text: course.summary,
    })),
    { kicker: "знакомство", title: "Первое занятие", price: money(state.site.trialPrice), text: "Спокойный первый визит: понимаем уровень и знакомимся с залом." },
    { kicker: "лично", title: "Индивидуально", price: money(state.site.privatePrice), text: "Час только на вашу технику, задачу и комбинацию." },
  ];
  $("#priceList").innerHTML = cards.map((card) => `
    <article class="price reveal">
      <b>${esc(card.kicker)}</b>
      <h3>${esc(card.title)}</h3>
      <strong>${esc(card.price)}</strong>
      <p>${esc(card.text)}</p>
    </article>`).join("");
}

function renderPortfolio() {
  $("#heroMedia").innerHTML = mediaHtml("hero", "A");
  $("#aboutMedia").innerHTML = mediaHtml("about", "A");
  $("#portfolioGrid").innerHTML = ["p0", "p1", "p2", "p3", "p4", "p5"].map((slot, index) => {
    const url = photoUrl(slot);
    return `<article class="shot">${url ? `<img src="${esc(url)}" alt="">` : `<div class="placeholder">${index + 1}</div>`}</article>`;
  }).join("");
}

function dayState(dayISO) {
  const site = state.site;
  if (dayISO < todayISO()) return "past";
  if ((site.daysOff || []).includes(dayISO)) return "off";
  if ((site.counts?.[dayISO] || 0) >= Number(site.capacity || 8)) return "full";
  return "open";
}

function renderCalendar() {
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  const first = new Date(year, month, 1).getDay();
  const shift = (first + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(shift).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const weeks = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"].map((day) => `<span>${day}</span>`).join("");
  const days = cells.map((day) => {
    if (!day) return `<span class="day empty"></span>`;
    const dayISO = iso(year, month, day);
    const kind = dayState(dayISO);
    const left = Number(state.site.capacity || 8) - (state.site.counts?.[dayISO] || 0);
    const note = kind === "off" ? "выходной" : kind === "full" ? "набрано" : kind === "past" ? "" : `${left} мест`;
    const disabled = kind !== "open";
    return `<button class="day ${kind} ${state.selected === dayISO ? "selected" : ""}" type="button" data-date="${dayISO}" ${disabled ? "disabled" : ""}>${day}<small>${note}</small></button>`;
  }).join("");
  $("#calendar").innerHTML = `
    <div class="cal-head">
      <button class="mini" type="button" data-month="-1">←</button>
      <h3 class="cal-title">${esc(monthLabel(state.cursor))}</h3>
      <button class="mini" type="button" data-month="1">→</button>
    </div>
    <div class="cal-week">${weeks}</div>
    <div class="cal-grid">${days}</div>
    <div class="legend"><span><i class="dot"></i>есть места</span><span><i class="dot full"></i>набрано</span><span><i class="dot off"></i>выходной</span></div>`;
  renderBookCard();
}

function renderBookCard() {
  const openCourses = state.site.courses.filter((course) => course.status === "open");
  $("#bookCourse").innerHTML = openCourses.map((course) => `<option value="${esc(course.id)}">${esc(course.title)} · ${esc(money(course.price))}</option>`).join("");
  $("#bookPerson").textContent = state.leadId ? `Запись для ${state.leadName}` : "Сначала оставьте номер — затем дата сохранится за вами.";
  $("#bookHint").textContent = state.selected ? `Выбрано ${state.selected.split("-").reverse().join(".")}` : "Нажмите свободный день в календаре.";
}

function bindReveal() {
  const io = bindReveal.io || (bindReveal.io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("in");
      bindReveal.io.unobserve(entry.target);
    });
  }, { threshold: 0.16, rootMargin: "0px 0px -6% 0px" }));
  document.querySelectorAll(".reveal:not(.in)").forEach((node) => io.observe(node));
}

function renderAll() {
  applyTheme(state.site.theme);
  renderContacts();
  renderCourses();
  renderPrices();
  renderPortfolio();
  renderCalendar();
  bindReveal();
}

function openLead() {
  $("#leadHint").textContent = "";
  $("#leadModal").hidden = false;
  document.body.classList.add("locked");
  $("#leadName").focus();
}

function closeLead() {
  $("#leadModal").hidden = true;
  document.body.classList.remove("locked");
}

async function submitLead(event) {
  event.preventDefault();
  if (state.preview) {
    $("#leadHint").textContent = "На этой ссылке можно смотреть сайт. Номер сохранится, если открыть его на компьютере через «Открыть сайт.bat».";
    return;
  }
  $("#leadHint").textContent = "Сохраняю…";
  try {
    const data = await api("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        name: $("#leadName").value,
        phone: $("#leadPhone").value,
        comment: $("#leadComment").value,
      }),
    });
    if (data.admin) {
      state.token = data.token;
      sessionStorage.setItem("adminToken", data.token);
      closeLead();
      await openAdmin();
      return;
    }
    state.leadId = data.id;
    state.leadName = $("#leadName").value.trim();
    sessionStorage.setItem("leadId", data.id);
    sessionStorage.setItem("leadName", state.leadName);
    $("#bookComment").value = $("#leadComment").value;
    closeLead();
    renderBookCard();
    document.getElementById("booking").scrollIntoView({ behavior: "smooth" });
    toast("Номер сохранён. Теперь выберите дату.");
  } catch (error) {
    $("#leadHint").textContent = error.message;
  }
}

async function submitBook(event) {
  event.preventDefault();
  if (state.preview) {
    $("#bookHint").textContent = "На странице просмотра дата не сохраняется. Запись работает на локальном сайте.";
    return;
  }
  if (!state.leadId) {
    openLead();
    return;
  }
  if (!state.selected) {
    $("#bookHint").textContent = "Выберите свободную дату.";
    return;
  }
  try {
    await api("/api/book", {
      method: "POST",
      body: JSON.stringify({
        id: state.leadId,
        date: state.selected,
        courseId: $("#bookCourse").value,
        comment: $("#bookComment").value,
      }),
    });
    toast("Дата предварительно забронирована. Я подтвержу её лично.");
    state.site = await api("/api/state");
    renderCalendar();
  } catch (error) {
    $("#bookHint").textContent = error.message;
  }
}

function adminShell() {
  return `
    <div class="admin">
      <aside class="admin-side">
        <strong style="font-family:var(--serif);font-size:32px;font-weight:500">Кабинет</strong>
        <button type="button" data-tab="leads">Заявки</button>
        <button type="button" data-tab="calendar">Календарь</button>
        <button type="button" data-tab="prices">Цены</button>
        <button type="button" data-tab="courses">Направления</button>
        <button type="button" data-tab="photos">Фотографии</button>
        <button type="button" data-tab="colors">Цвета</button>
        <button type="button" data-tab="money">Бухгалтерия</button>
        <button type="button" id="closeAdmin">На сайт</button>
      </aside>
      <div class="admin-main" id="adminMain"></div>
    </div>`;
}

async function openAdmin() {
  $("#admin").hidden = false;
  $("#admin").innerHTML = adminShell();
  document.body.classList.add("locked");
  $("#cabinetBtn").hidden = false;
  await refreshAdmin();
}

function closeAdmin() {
  $("#admin").hidden = true;
  $("#admin").innerHTML = "";
  document.body.classList.remove("locked");
}

async function refreshAdmin() {
  state.adminData = await api("/api/admin/data");
  state.site = await api("/api/state");
  renderAll();
  paintAdmin();
}

function paintAdmin() {
  $$(".admin-side button[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.adminTab);
  });
  const views = { leads: viewLeads, calendar: viewCalendar, prices: viewPrices, courses: viewCourses, photos: viewPhotos, colors: viewColors, money: viewMoney };
  $("#adminMain").innerHTML = views[state.adminTab]();
  bindAdmin();
}

function viewLeads() {
  const courses = Object.fromEntries(state.site.courses.map((course) => [course.id, course.title]));
  const rows = [...state.adminData.leads].reverse().map((lead) => `
    <tr>
      <td>${esc(lead.name)}<br>${esc(lead.phone)}</td>
      <td><input data-lead="${esc(lead.id)}" data-field="date" type="date" value="${esc(lead.date || "")}"></td>
      <td><select data-lead="${esc(lead.id)}" data-field="courseId">
        <option value="">—</option>
        ${state.site.courses.map((course) => `<option value="${esc(course.id)}" ${lead.courseId === course.id ? "selected" : ""}>${esc(course.title)}</option>`).join("")}
      </select></td>
      <td><textarea data-lead="${esc(lead.id)}" data-field="comment" rows="2">${esc(lead.comment || "")}</textarea></td>
      <td>${esc(lead.createdAt || "")}<br><span class="row-actions"><button class="mini" data-save-lead="${esc(lead.id)}" type="button">Сохранить</button><button class="mini danger" data-del-lead="${esc(lead.id)}" type="button">Удалить</button></span></td>
    </tr>`).join("");
  return `<h2>Кто оставил номер</h2><p class="prose">Имя, телефон, дата и комментарий. Удаление заявки освобождает место в этот день.</p>
    <table><thead><tr><th>Человек</th><th>Дата</th><th>Направление</th><th>Комментарий</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan='5'>Пока пусто</td></tr>"}</tbody></table>`;
}

function viewCalendar() {
  const year = state.cursor.getFullYear();
  const month = state.cursor.getMonth();
  const shift = (new Date(year, month, 1).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const cells = [...Array(shift).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const days = cells.map((day) => {
    if (!day) return `<span class="day empty"></span>`;
    const dayISO = iso(year, month, day);
    const booked = state.site.counts?.[dayISO] || 0;
    const off = (state.site.daysOff || []).includes(dayISO);
    const full = booked >= Number(state.site.capacity);
    return `<button class="day ${off ? "off" : ""} ${full ? "full" : ""}" type="button" data-off="${dayISO}">${day}<small>${off ? "выходной" : `${booked}/${state.site.capacity}`}</small></button>`;
  }).join("");
  return `<h2>Календарь</h2><p class="prose">Когда записавшихся становится столько же, сколько мест в группе, день закрывается сам. Выходной ставится нажатием на дату.</p>
    <label>Мест в группе<input id="capacity" type="number" min="1" max="100" value="${esc(state.site.capacity)}"></label>
    <button class="btn btn-primary" id="saveCapacity" type="button">Сохранить вместимость</button>
    <div class="calendar" style="margin-top:18px">
      <div class="cal-head"><button class="mini" type="button" data-month="-1">←</button><h3 class="cal-title">${esc(monthLabel(state.cursor))}</h3><button class="mini" type="button" data-month="1">→</button></div>
      <div class="cal-grid">${days}</div>
    </div>`;
}

function viewPrices() {
  return `<h2>Цены</h2><div class="admin-grid">
    ${state.site.courses.map((course) => `<label>${esc(course.title)}<input data-price="${esc(course.id)}" type="number" min="0" value="${esc(course.price)}"></label>`).join("")}
    <label>Первое занятие<input id="trialPrice" type="number" min="0" value="${esc(state.site.trialPrice)}"></label>
    <label>Индивидуально<input id="privatePrice" type="number" min="0" value="${esc(state.site.privatePrice)}"></label>
  </div><button class="btn btn-primary" id="savePrices" type="button">Сохранить цены</button>`;
}

function viewCourses() {
  const cards = state.site.courses.map((course, index) => `
    <article class="course" data-course="${index}">
      <label>Название<input data-f="title" value="${esc(course.title)}"></label>
      <label>Статус<select data-f="status"><option value="open" ${course.status === "open" ? "selected" : ""}>Открыто</option><option value="soon" ${course.status === "soon" ? "selected" : ""}>Скоро</option></select></label>
      <label>Цена<input data-f="price" type="number" min="0" value="${esc(course.price)}"></label>
      <label>Уровень<input data-f="level" value="${esc(course.level)}"></label>
      <label>Длительность<input data-f="duration" value="${esc(course.duration)}"></label>
      <label>Описание<textarea data-f="summary" rows="3">${esc(course.summary)}</textarea></label>
      <button class="mini danger" type="button" data-remove-course="${index}">Убрать направление</button>
    </article>`).join("");
  return `<h2>Направления</h2><div class="cards">${cards}</div>
    <div class="row-actions" style="margin-top:16px"><button class="btn btn-ghost" id="addCourse" type="button">Добавить направление</button><button class="btn btn-primary" id="saveCourses" type="button">Сохранить направления</button></div>
    <h3 style="margin-top:28px">Студия и телефон на сайте</h3>
    <label>Как писать номер<input id="phoneDisplay" value="${esc(state.site.phoneDisplay || "")}"></label>
    <label>Адрес или статус студии<input id="location" value="${esc(state.site.location || "")}"></label>
    <button class="btn btn-primary" id="savePlace" type="button">Сохранить текст</button>`;
}

function viewPhotos() {
  return `<h2>Фотографии</h2><p class="prose">Новый кадр заменяет текущий в этом месте. Пустая рамка на сайте остаётся, пока фото не выбрано.</p><div class="admin-grid">${Object.keys(SLOT_LABELS).map((slot) => {
    const url = photoUrl(slot);
    return `<article class="photo-card"><h3>${SLOT_LABELS[slot]}</h3>${url ? `<img src="${esc(url)}" alt="">` : `<div class="placeholder"></div>`}<input data-file="${slot}" type="file" accept="image/jpeg,image/png,image/webp,image/gif"><button class="mini danger" type="button" data-clear="${slot}">Убрать фото</button></article>`;
  }).join("")}</div>`;
}

function viewColors() {
  const theme = state.site.theme || {};
  const fields = [["bg", "Фон"], ["bg2", "Карточки"], ["text", "Текст"], ["muted", "Приглушённый"], ["accent", "Золото"]];
  return `<h2>Цветовая гамма</h2><p class="prose">Чёрный и тёплое золото уже стоят. Оттенок можно сдвинуть и сразу увидеть на сайте под этой панелью после сохранения.</p>
    <div class="admin-grid">${fields.map(([key, label]) => `<label class="color-row">${label}<input data-color="${key}" type="color" value="${esc(theme[key] || "#000000")}"></label>`).join("")}</div>
    <button class="btn btn-primary" id="saveColors" type="button">Сохранить цвета</button>
    <button class="btn btn-ghost" id="resetColors" type="button">Вернуть чёрное золото</button>`;
}

function viewMoney() {
  const rows = state.adminData.finance || [];
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
  const body = [...rows].reverse().map((row) => `<tr><td>${esc(row.date)}</td><td>${esc(row.courseTitle || "")}</td><td>${esc(row.people)}</td><td>${esc(money(row.revenue))}</td><td>${esc(money(row.rent))}</td><td>${esc(money(row.extra))}</td><td>${esc(money(row.profit))}</td><td>${esc(row.note || "")}<br><button class="mini danger" data-del-fin="${esc(row.id)}" type="button">Удалить</button></td></tr>`).join("");
  return `<h2>Бухгалтерия</h2><p class="prose">Перед записью нужно указать, сколько человек пришло и сколько стоила аренда. После этого строка попадает в Excel: лист «Касса», а заявки — на лист «Заявки».</p>
    <div class="statline"><div>Выручка<strong>${money(sum("revenue"))}</strong></div><div>Затраты<strong>${money(sum("rent") + sum("extra"))}</strong></div><div>Прибыль<strong>${money(sum("profit"))}</strong></div></div>
    <div class="admin-grid">
      <label>Дата занятия<input id="finDate" type="date" value="${todayISO()}"></label>
      <label>Направление<select id="finCourse">${state.site.courses.map((course) => `<option value="${esc(course.id)}" data-price="${esc(course.price)}">${esc(course.title)}</option>`).join("")}</select></label>
      <label>Сколько человек пришло<input id="finPeople" type="number" min="0" placeholder="обязательно"></label>
      <label>Аренда помещения<input id="finRent" type="number" min="0" placeholder="обязательно"></label>
      <label>Цена с человека<input id="finPrice" type="number" min="0" value="${esc(state.site.courses[0]?.price || 0)}"></label>
      <label>Прочие затраты<input id="finExtra" type="number" min="0" value="0"></label>
    </div>
    <label>Комментарий<input id="finNote" placeholder="свет, вода, такси — если нужно"></label>
    <p class="calc" id="finCalc">Укажите людей и аренду — здесь появится расчёт.</p>
    <div class="row-actions"><button class="btn btn-primary" id="saveFinance" type="button">Записать в Excel</button><button class="btn btn-ghost" id="downloadExcel" type="button">Скачать Excel</button></div>
    <table style="margin-top:18px"><thead><tr><th>Дата</th><th>Направление</th><th>Люди</th><th>Выручка</th><th>Аренда</th><th>Прочее</th><th>Прибыль</th><th></th></tr></thead><tbody>${body || "<tr><td colspan='8'>Записей пока нет</td></tr>"}</tbody></table>`;
}

function collectCourses() {
  return $$("[data-course]").map((card, index) => ({
    id: state.site.courses[index]?.id || "",
    title: $("[data-f=title]", card).value,
    status: $("[data-f=status]", card).value,
    price: $("[data-f=price]", card).value,
    level: $("[data-f=level]", card).value,
    duration: $("[data-f=duration]", card).value,
    summary: $("[data-f=summary]", card).value,
  }));
}

function bindAdmin() {
  $$("[data-tab]").forEach((button) => button.onclick = async () => {
    if (state.adminTab === "courses") state.site.courses = collectCourses();
    state.adminTab = button.dataset.tab;
    paintAdmin();
  });
  $("#closeAdmin").onclick = closeAdmin;
  $("#adminMain").onclick = onAdminClick;
  $("#adminMain").onchange = onAdminChange;
  $("#adminMain").oninput = onAdminInput;
}

async function onAdminClick(event) {
  try {
    await onAdminClickInner(event);
  } catch (error) {
    toast(error.message);
  }
}

async function onAdminClickInner(event) {
  const monthBtn = event.target.closest("[data-month]");
  if (monthBtn) {
    state.cursor.setMonth(state.cursor.getMonth() + Number(monthBtn.dataset.month));
    paintAdmin();
    return;
  }
  const off = event.target.closest("[data-off]");
  if (off) {
    const day = off.dataset.off;
    const days = new Set(state.site.daysOff || []);
    if (days.has(day)) days.delete(day); else days.add(day);
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ daysOff: [...days] }) });
    await refreshAdmin();
    return;
  }
  if (event.target.id === "saveCapacity") {
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ capacity: $("#capacity").value }) });
    await refreshAdmin();
    toast("Вместимость обновлена");
  }
  if (event.target.id === "savePrices") {
    const courses = state.site.courses.map((course) => ({ ...course, price: $(`[data-price="${course.id}"]`).value }));
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ courses, trialPrice: $("#trialPrice").value, privatePrice: $("#privatePrice").value }) });
    await refreshAdmin();
    toast("Цены сохранены");
  }
  if (event.target.id === "addCourse") {
    state.site.courses = collectCourses();
    state.site.courses.push({ id: "", title: "Новое направление", status: "soon", price: 1500, level: "", duration: "60 минут", summary: "" });
    paintAdmin();
  }
  if (event.target.id === "saveCourses") {
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ courses: collectCourses() }) });
    await refreshAdmin();
    toast("Направления сохранены");
  }
  const remove = event.target.closest("[data-remove-course]");
  if (remove) {
    state.site.courses = collectCourses();
    state.site.courses.splice(Number(remove.dataset.removeCourse), 1);
    paintAdmin();
  }
  if (event.target.id === "savePlace") {
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ phoneDisplay: $("#phoneDisplay").value, location: $("#location").value }) });
    await refreshAdmin();
    toast("Текст на сайте обновлён");
  }
  if (event.target.id === "saveColors" || event.target.id === "resetColors") {
    const theme = event.target.id === "resetColors"
      ? { bg: "#070707", bg2: "#121212", text: "#f6f1e8", muted: "#b1a79b", accent: "#d7b98a" }
      : Object.fromEntries($$("[data-color]").map((input) => [input.dataset.color, input.value]));
    await api("/api/admin/settings", { method: "POST", body: JSON.stringify({ theme }) });
    await refreshAdmin();
    toast("Цвета сохранены");
  }
  const saveLead = event.target.closest("[data-save-lead]");
  if (saveLead) {
    const id = saveLead.dataset.saveLead;
    const field = (name) => $(`[data-lead="${id}"][data-field="${name}"]`).value;
    await api("/api/admin/lead", { method: "POST", body: JSON.stringify({ id, date: field("date"), courseId: field("courseId"), comment: field("comment") }) });
    await refreshAdmin();
    toast("Заявка обновлена");
  }
  const delLead = event.target.closest("[data-del-lead]");
  if (delLead) {
    await api("/api/admin/lead", { method: "POST", body: JSON.stringify({ id: delLead.dataset.delLead, delete: true }) });
    await refreshAdmin();
  }
  const clear = event.target.closest("[data-clear]");
  if (clear) {
    await api("/api/admin/photo", { method: "POST", body: JSON.stringify({ slot: clear.dataset.clear, clear: true }) });
    await refreshAdmin();
  }
  if (event.target.id === "saveFinance") await saveFinance();
  if (event.target.id === "downloadExcel") await downloadExcel();
  const delFin = event.target.closest("[data-del-fin]");
  if (delFin) {
    await api("/api/admin/finance", { method: "POST", body: JSON.stringify({ id: delFin.dataset.delFin, delete: true }) });
    await refreshAdmin();
  }
}

function onAdminChange(event) {
  if (event.target.id === "finCourse") {
    const option = event.target.selectedOptions[0];
    $("#finPrice").value = option.dataset.price || 0;
    updateCalc();
    return;
  }
  const file = event.target.dataset.file;
  if (!file || !event.target.files?.[0]) return;
  const selected = event.target.files[0];
  const reader = new FileReader();
  reader.onload = async () => {
    const data = String(reader.result).split(",")[1];
    try {
      await api("/api/admin/photo", { method: "POST", body: JSON.stringify({ slot: file, name: selected.name, data }) });
      await refreshAdmin();
      toast("Фото заменено");
    } catch (error) {
      toast(error.message);
    }
  };
  reader.readAsDataURL(selected);
}

function onAdminInput(event) {
  if (event.target.dataset?.color) {
    document.documentElement.style.setProperty(`--${event.target.dataset.color === "bg2" ? "bg2" : event.target.dataset.color}`, event.target.value);
  }
  if (["finPeople", "finRent", "finPrice", "finExtra"].includes(event.target.id)) updateCalc();
}

function updateCalc() {
  const node = $("#finCalc");
  if (!node) return;
  const people = $("#finPeople").value;
  const rent = $("#finRent").value;
  if (people === "" || rent === "") {
    node.textContent = "Сначала напишите, сколько человек пришло и сколько стоила аренда.";
    return;
  }
  const price = Number($("#finPrice").value || 0);
  const extra = Number($("#finExtra").value || 0);
  const revenue = Number(people) * price;
  node.textContent = `${people} × ${money(price)} = ${money(revenue)}. Аренда ${money(rent)}, прочее ${money(extra)}. Прибыль ${money(revenue - Number(rent) - extra)}.`;
}

async function saveFinance() {
  const people = $("#finPeople").value;
  const rent = $("#finRent").value;
  if (people === "" || rent === "") {
    $("#finCalc").textContent = "Запись в Excel начнётся после числа людей и стоимости аренды.";
    return;
  }
  const course = $("#finCourse");
  await api("/api/admin/finance", {
    method: "POST",
    body: JSON.stringify({
      date: $("#finDate").value,
      courseId: course.value,
      courseTitle: course.selectedOptions[0]?.textContent || "",
      people,
      rent,
      price: $("#finPrice").value,
      extra: $("#finExtra").value,
      note: $("#finNote").value,
    }),
  });
  await refreshAdmin();
  toast("Строка записана в Excel");
}

async function downloadExcel() {
  const response = await fetch("/api/admin/excel", { headers: { "X-Admin-Token": state.token } });
  if (!response.ok) {
    toast("Не удалось собрать Excel");
    return;
  }
  const blob = await response.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "Касса.xlsx";
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindPublic() {
  $$("[data-open-lead]").forEach((button) => button.onclick = openLead);
  $("#leadForm").onsubmit = submitLead;
  $("#bookForm").onsubmit = submitBook;
  $("[data-close]").onclick = closeLead;
  $("#leadModal").onclick = (event) => { if (event.target.id === "leadModal") closeLead(); };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeLead();
      if (!$("#admin").hidden) closeAdmin();
    }
  });
  $("#calendar").onclick = (event) => {
    const monthBtn = event.target.closest("[data-month]");
    if (monthBtn) {
      state.cursor.setMonth(state.cursor.getMonth() + Number(monthBtn.dataset.month));
      renderCalendar();
      return;
    }
    const day = event.target.closest("[data-date]");
    if (!day) return;
    state.selected = day.dataset.date;
    if (!state.leadId) openLead();
    renderCalendar();
  };
  $("#cabinetBtn").onclick = openAdmin;
}

async function boot() {
  try {
    state.site = await api("/api/state");
  } catch (error) {
    try {
      const response = await fetch("data/site.json");
      state.site = await response.json();
      state.site.counts = state.site.counts || {};
      state.preview = true;
    } catch (previewError) {
      document.body.insertAdjacentHTML("beforeend", `<p class="toast">Откройте файл «Открыть сайт.bat», чтобы запись сохранилась.</p>`);
      return;
    }
  }
  bindPublic();
  renderAll();
  if (state.preview) {
    const note = document.createElement("p");
    note.className = "preview-note";
    note.textContent = "Это страница для просмотра. Запись и кабинет сохраняются там, где сайт открыт через «Открыть сайт.bat».";
    document.querySelector(".footer").before(note);
  }
  if (state.token && !state.preview) {
    try { await api("/api/admin/data"); $("#cabinetBtn").hidden = false; }
    catch { state.token = ""; sessionStorage.removeItem("adminToken"); }
  }
}

boot();
