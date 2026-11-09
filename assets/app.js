/* =========================================================================
   Daily 365
   A photograph a day, stamped with date, day number, what you earned and
   what you spent, plus running totals.

   Design notes
   ------------
   * Everything is local-first. IndexedDB holds the photographs and numbers.
     Saving to Drive uses the phone's own share sheet, so the app never needs
     Google credentials or permission to your Drive.
   * Day numbers are derived from a fixed start date, so a skipped day never
     renumbers the rest of the year.
   * Running totals are always recomputed from the full ledger after any
     mutation. Editing an old day therefore corrects every day after it —
     storing totals at write time would silently go stale.
   * The stamp is burned into the JPEG. It cannot be edited afterwards, so
     every irreversible step is preceded by a confirmation.
   ========================================================================= */

(function () {
  "use strict";

  /* ------------------------------------------------------------- config */

  const OUTPUT = { width: 1080, height: 1440 };       // 3:4
  const JPEG_QUALITY = 0.93;
  const DB_NAME = "daily365";
  const DB_VERSION = 1;
  const STORE = "entries";
  const SETTINGS_KEY = "daily365.settings.v1";
  const DRAFT_KEY = "daily365.draft.v1";

  const DEFAULTS = {
    startDate: null,          // set on first run to today
    dateFormat: "long",
    guides: true,
    ghost: true,
    mirror: true,
    deviceId: ""
  };

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* -------------------------------------------------------------- state */

  let settings = { ...DEFAULTS };
  let entries = [];            // sorted by day, ascending
  let draft = null;            // the photograph waiting to be saved
  let stream = null;
  let activeDeviceId = null;
  let facing = "user";
  let db = null;
  let busy = false;

  /* ---------------------------------------------------------- selectors */

  const $ = (id) => document.getElementById(id);

  const el = {};

  function cacheElements() {
    el.viewfinder = $("viewfinder");
    el.camera = $("camera");
    el.ghost = $("ghost");
    el.guides = $("guides");
    el.vfStatus = $("vfStatus");
    el.camFallback = $("camFallback");
    el.camMessage = $("camMessage");
    el.dayMark = $("dayMark");
    el.captureDay = $("captureDay");
    el.earn = $("earn");
    el.spend = $("spend");
    el.tallyEarn = $("tallyEarn");
    el.tallySpend = $("tallySpend");
    el.tallyNet = $("tallyNet");
    el.reviewImage = $("reviewImage");
    el.reviewCaption = $("reviewCaption");
    el.savedFlag = $("savedFlag");
    el.savedFile = $("savedFile");
    el.ledgerList = $("ledgerList");
    el.ledgerCount = $("ledgerCount");
    el.startDate = $("startDate");
    el.dateFormat = $("dateFormat");
    el.deviceName = $("deviceName");
    el.fileInput = $("fileInput");
    el.csvInput = $("csvInput");
    el.dialog = $("dialog");
    el.dialogTitle = $("dialogTitle");
    el.dialogBody = $("dialogBody");
    el.dialogActions = $("dialogActions");
    el.alert = $("alert");
  }

  /* ------------------------------------------------------------- dates */

  function todayISO(dateObj) {
    const d = dateObj ? new Date(dateObj) : new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function parseISO(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function daysBetween(aISO, bISO) {
    // Integer calendar days. Using UTC noon avoids daylight-saving drift.
    const a = parseISO(aISO);
    const b = parseISO(bISO);
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  function dayNumberFor(iso) {
    const start = settings.startDate || todayISO();
    return daysBetween(start, iso) + 1;
  }

  function formatDate(iso) {
    const d = parseISO(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    if (settings.dateFormat === "slash") return `${dd}/${mm}/${d.getFullYear()}`;
    if (settings.dateFormat === "iso") return `${d.getFullYear()}-${mm}-${dd}`;
    return `${dd} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function pad(n, width) {
    const s = String(n);
    return s.length >= width ? s : "0".repeat(width - s.length) + s;
  }

  function fileNameFor(day, iso) {
    return `day-${pad(day, 3)}-${iso}.jpg`;
  }

  /* ------------------------------------------------------------- money */

  function toAmount(value) {
    if (value === null || value === undefined || value === "") return 0;
    const n = parseFloat(String(value).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function group(n) {
    const abs = Math.abs(n);
    const whole = Math.floor(abs);
    const paise = Math.round((abs - whole) * 100);
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return paise ? `${grouped}.${pad(paise, 2)}` : grouped;
  }

  function money(n) {
    const v = toAmount(n);
    return (v < 0 ? "−₹" : "₹") + group(Math.abs(v));
  }

  function amountOnly(n) {
    const v = toAmount(n);
    return (v < 0 ? "−" : "") + group(Math.abs(v));
  }

  function escapeHTML(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------------------------------------------------------- settings */

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      settings = { ...DEFAULTS, ...parsed };
    } catch (e) {
      settings = { ...DEFAULTS };
    }
    if (!settings.startDate) {
      settings.startDate = todayISO();
      persistSettings();
    }
  }

  function persistSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      /* storage full or blocked — the app still works for this session */
    }
  }

  /* -------------------------------------------------------- IndexedDB */

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("This browser has no IndexedDB."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: "day" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open storage."));
      request.onblocked = () => reject(new Error("Storage is blocked by another tab."));
    });
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function store(mode) {
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async function readAllEntries() {
    const records = await promisify(store("readonly").getAll());
    records.sort((a, b) => a.day - b.day);
    return records;
  }

  async function writeEntry(record) {
    await promisify(store("readwrite").put(record));
  }

  async function deleteEntry(day) {
    await promisify(store("readwrite").delete(day));
  }

  async function clearEntries() {
    await promisify(store("readwrite").clear());
  }

  /* ------------------------------------------------- running totals
     Stored totals are a cache. This rebuilds them from the ledger in day
     order and persists anything that changed, so replacing day 3 fixes
     days 4, 5, 6 … instead of leaving them wrong.
  ---------------------------------------------------------------------- */

  async function recomputeTotals() {
    let earnTotal = 0;
    let spendTotal = 0;
    const dirty = [];

    entries.sort((a, b) => a.day - b.day);
    for (const entry of entries) {
      earnTotal += toAmount(entry.earn);
      spendTotal += toAmount(entry.spend);
      const e = Math.round(earnTotal * 100) / 100;
      const s = Math.round(spendTotal * 100) / 100;
      if (entry.earnTotal !== e || entry.spendTotal !== s) {
        entry.earnTotal = e;
        entry.spendTotal = s;
        dirty.push(entry);
      }
    }
    for (const entry of dirty) await writeEntry(entry);
    return { earnTotal, spendTotal };
  }

  function totalsBefore(day) {
    let earn = 0;
    let spend = 0;
    for (const entry of entries) {
      if (entry.day >= day) break;
      earn += toAmount(entry.earn);
      spend += toAmount(entry.spend);
    }
    return { earn, spend };
  }

  /* -------------------------------------------------------------- misc */

  let alertTimer = null;

  function say(message, ms) {
    el.alert.textContent = message;
    el.alert.classList.add("is-on");
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => el.alert.classList.remove("is-on"), ms || 2400);
  }

  function ask({ title, body, actions }) {
    return new Promise((resolve) => {
      el.dialogTitle.textContent = title || "";
      el.dialogBody.textContent = body || "";
      el.dialogActions.innerHTML = "";

      actions.forEach((action) => {
        const button = document.createElement("button");
        button.className = "btn " + (action.style === "primary" ? "" : "quiet");
        if (action.style === "danger") button.className = "btn danger";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          closeDialog(action.id);
        });
        el.dialogActions.appendChild(button);
      });

      const onCancel = (event) => {
        event.preventDefault();
        closeDialog(null);
      };
      el.dialog.addEventListener("cancel", onCancel, { once: true });

      function closeDialog(id) {
        if (el.dialog.open) el.dialog.close();
        resolve(id);
      }

      if (typeof el.dialog.showModal === "function") el.dialog.showModal();
      else el.dialog.setAttribute("open", "");
    });
  }

  /* ------------------------------------------------------------- stamp */

  function drawCover(ctx, source, sourceWidth, sourceHeight, targetWidth, targetHeight, mirror) {
    const sourceRatio = sourceWidth / sourceHeight;
    const targetRatio = targetWidth / targetHeight;

    let cropWidth;
    let cropHeight;
    let cropX;
    let cropY;

    if (sourceRatio > targetRatio) {
      cropHeight = sourceHeight;
      cropWidth = sourceHeight * targetRatio;
      cropX = (sourceWidth - cropWidth) / 2;
      cropY = 0;
    } else {
      cropWidth = sourceWidth;
      cropHeight = sourceWidth / targetRatio;
      cropX = 0;
      cropY = (sourceHeight - cropHeight) / 2;
    }

    if (mirror) {
      ctx.save();
      ctx.translate(targetWidth, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
      ctx.restore();
    } else {
      ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, targetWidth, targetHeight);
    }
  }

  function drawStamp(ctx, meta) {
    const W = OUTPUT.width;
    const H = OUTPUT.height;

    const base = Math.round(H * 0.0235);
    const labelSize = Math.round(base * 0.66);
    const lineHeight = Math.round(base * 1.44);
    const dividerHeight = Math.round(base * 0.95);
    const padX = Math.round(W * 0.058);
    const padBottom = Math.round(H * 0.046);
    const ruleInset = padX;

    const rows = [
      { label: "DATE", value: formatDate(meta.date) },
      { label: "DAY", value: pad(meta.day, 3) },
      { label: "EARN", value: amountOnly(meta.earn) },
      { label: "SPEND", value: amountOnly(meta.spend) },
      { divider: true },
      { label: "EARN TOTAL", value: amountOnly(meta.earnTotal), accent: true },
      { label: "SPEND TOTAL", value: amountOnly(meta.spendTotal), accent: true }
    ];

    const contentHeight = rows.reduce(
      (total, row) => total + (row.divider ? dividerHeight : lineHeight), 0
    );
    const stripTop = H - padBottom - contentHeight;

    // One gradient, so white type survives a bright background.
    const fade = ctx.createLinearGradient(0, stripTop - H * 0.14, 0, H);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(0.45, "rgba(0,0,0,0.5)");
    fade.addColorStop(1, "rgba(0,0,0,0.92)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, stripTop - H * 0.14, W, H - stripTop + H * 0.14);

    ctx.textBaseline = "middle";

    let y = stripTop;

    for (const row of rows) {
      if (row.divider) {
        ctx.strokeStyle = "rgba(216,166,87,0.5)";
        ctx.lineWidth = Math.max(1, Math.round(H * 0.0012));
        ctx.beginPath();
        ctx.moveTo(ruleInset, y + dividerHeight / 2);
        ctx.lineTo(W - ruleInset, y + dividerHeight / 2);
        ctx.stroke();
        y += dividerHeight;
        continue;
      }

      const centreY = y + lineHeight / 2;

      // Label hard left, value hard right: a ledger, not a caption.
      ctx.textAlign = "left";
      ctx.font = `500 ${labelSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
      ctx.fillStyle = "rgba(242,237,228,0.55)";
      ctx.fillText(row.label, padX, centreY);

      ctx.textAlign = "right";
      ctx.font = `600 ${base}px -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = row.accent ? "#d8a657" : "rgba(255,255,255,0.97)";
      ctx.fillText(row.value, W - padX, centreY);

      y += lineHeight;
    }

    ctx.textAlign = "left";
  }

  function composeStamped(source, sourceWidth, sourceHeight, meta) {
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT.width;
    canvas.height = OUTPUT.height;

    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    drawCover(ctx, source, sourceWidth, sourceHeight, OUTPUT.width, OUTPUT.height, shouldMirror());
    drawStamp(ctx, meta);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve({ canvas, blob }) : reject(new Error("Could not encode the photograph."))),
        "image/jpeg",
        JPEG_QUALITY
      );
    });
  }

  function shouldMirror() {
    // Mirroring only makes sense for a live selfie stream, not for a file
    // that was already saved the right way round.
    return settings.mirror && draft && draft.fromLiveCamera;
  }

  /* ------------------------------------------------------------ camera */

  const CAMERA_ERRORS = {
    NotAllowedError: "Camera permission is blocked. Allow it from the address bar, then try again.",
    SecurityError: "Camera permission is blocked. Allow it from the address bar, then try again.",
    NotFoundError: "No camera was found. If you are using a virtual camera, make sure it is running.",
    OverconstrainedError: "The requested camera is not available. Pick a different device.",
    NotReadableError: "The camera is busy. Another application is using it.",
    AbortError: "The camera stopped unexpectedly. Try again.",
    TypeError: "This page cannot reach a camera. Open it over https:// or localhost in a browser tab."
  };

  function describeCameraError(error) {
    if (!error) return "Camera unavailable.";
    if (!window.isSecureContext) {
      return "Cameras need a secure page. Open this over https:// or localhost.";
    }
    return CAMERA_ERRORS[error.name] || `${error.name || "Error"}: ${error.message || "unknown"}`;
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    el.camera.srcObject = null;
  }

  async function listVideoDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "videoinput");
    } catch (e) {
      return [];
    }
  }

  async function startCamera() {
    stopCamera();
    el.viewfinder.classList.remove("is-dead");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      failCamera("This browser has no camera API. Use the gallery instead.");
      return;
    }
    if (!window.isSecureContext) {
      failCamera("Cameras need a secure page. Open this over https:// or localhost.");
      return;
    }

    // Try the chosen device first, then the requested facing, then anything.
    // Virtual cameras (Camo, OBS, EpocCam) often report no facingMode, which
    // is exactly why the last attempt allows any device at all.
    const attempts = [];
    if (settings.deviceId) attempts.push({ video: { deviceId: { exact: settings.deviceId } } });
    attempts.push({ video: { facingMode: { ideal: facing }, width: { ideal: 1440 }, height: { ideal: 1920 } } });
    attempts.push({ video: true });

    let lastError = null;
    for (const constraints of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!stream) {
      failCamera(describeCameraError(lastError));
      return;
    }

    el.camera.srcObject = stream;
    el.camera.classList.toggle("is-unmirrored", !settings.mirror);
    try {
      await el.camera.play();
    } catch (e) {
      /* autoplay policy can defer this; the stream is still attached */
    }

    const track = stream.getVideoTracks()[0];
    const trackSettings = track && track.getSettings ? track.getSettings() : {};
    activeDeviceId = trackSettings.deviceId || null;

    await refreshDeviceLabel();
    el.vfStatus.textContent = track && track.label ? track.label : "camera ready";
  }

  function failCamera(message) {
    el.camMessage.textContent = message;
    el.viewfinder.classList.add("is-dead");
    el.vfStatus.textContent = "no camera";
  }

  async function refreshDeviceLabel() {
    const devices = await listVideoDevices();
    if (!devices.length) {
      el.deviceName.textContent = "no camera detected";
      return;
    }
    if (!devices.some((d) => d.label)) {
      el.deviceName.textContent = "names hidden until camera access is allowed";
      return;
    }
    const match = devices.find((d) => d.deviceId === activeDeviceId);
    el.deviceName.textContent = match ? match.label : (devices[0].label || "default camera");
  }

  async function pickDevice() {
    let devices = await listVideoDevices();

    if (!devices.length) {
      if (!window.isSecureContext) {
        await ask({
          title: "Secure page needed",
          body: "Browsers only expose cameras on https:// or localhost.",
          actions: [{ id: "ok", label: "Understood", style: "primary" }]
        });
        return;
      }
      // Permission may not have been granted yet; a first request reveals labels.
      await startCamera();
      devices = await listVideoDevices();
      if (!devices.length) {
        await ask({
          title: "No camera found",
          body: "The browser cannot see any video device.\n\nIf you are using a virtual camera, open its host application, confirm it is running, and restart the browser afterwards.",
          actions: [{ id: "ok", label: "Understood", style: "primary" }]
        });
        return;
      }
    }

    if (!devices.some((d) => d.label)) {
      const answer = await ask({
        title: "Allow camera first",
        body: "The browser hides camera names until access has been granted once.",
        actions: [
          { id: "grant", label: "Allow camera", style: "primary" },
          { id: "cancel", label: "Cancel" }
        ]
      });
      if (answer === "grant") await startCamera();
      return;
    }

    const actions = devices.map((device, index) => ({
      id: "device:" + device.deviceId,
      label: (device.deviceId === activeDeviceId ? "✓ " : "") + (device.label || `Camera ${index + 1}`),
      style: device.deviceId === activeDeviceId ? "quiet" : "primary"
    }));
    actions.push({ id: "default", label: "Use the system default", style: "quiet" });

    const choice = await ask({
      title: "Choose camera",
      body: "Pick the device you want each photograph to come from.",
      actions
    });

    if (!choice) return;
    settings.deviceId = choice === "default" ? "" : choice.replace(/^device:/, "");
    persistSettings();
    await startCamera();
    say(settings.deviceId ? "Camera changed" : "Using the system default");
  }

  /* ------------------------------------------------------- capture flow */

  function buildMeta() {
    const date = todayISO();
    const day = dayNumberFor(date);
    const earn = toAmount(el.earn.value);
    const spend = toAmount(el.spend.value);
    const previous = totalsBefore(day);

    return {
      date,
      day,
      earn,
      spend,
      earnTotal: Math.round((previous.earn + earn) * 100) / 100,
      spendTotal: Math.round((previous.spend + spend) * 100) / 100
    };
  }

  async function captureFromCamera() {
    if (!stream || !el.camera.videoWidth) {
      say("No camera — use “From gallery” instead");
      return;
    }
    const meta = buildMeta();
    const result = await composeStamped(
      el.camera, el.camera.videoWidth, el.camera.videoHeight, meta
    );
    setDraft({ ...result, meta, fromLiveCamera: true });
  }

  async function captureFromFile(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = objectUrl;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("That file could not be read as an image."));
      });

      const meta = buildMeta();
      const result = await composeStamped(image, image.naturalWidth, image.naturalHeight, meta);
      setDraft({ ...result, meta, fromLiveCamera: false });
    } catch (error) {
      say(error.message || "Could not read that photograph", 3400);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function setDraft(next) {
    if (draft && draft.objectUrl) URL.revokeObjectURL(draft.objectUrl);
    draft = next;
    draft.objectUrl = URL.createObjectURL(next.blob);

    el.reviewImage.src = draft.objectUrl;
    el.savedFlag.classList.remove("is-on");
    el.reviewCaption.textContent =
      `Day ${pad(draft.meta.day, 3)} · ${formatDate(draft.meta.date)}. ` +
      `Checking in with ${money(draft.meta.earn)} earned and ${money(draft.meta.spend)} spent — ` +
      `totals ${money(draft.meta.earnTotal)} and ${money(draft.meta.spendTotal)}.`;

    setSaveEnabled(true);
    showView("view-review");
  }

  function setSaveEnabled(enabled) {
    $("btnSave").disabled = !enabled;
    $("btnSaveDrive").disabled = !enabled;
  }

  /* --------------------------------------------------- pre-save review */

  async function confirmMeta(meta) {
    const working = { ...meta };
    const existing = entries.find((entry) => entry.day === working.day);

    /* 1 — this day is already recorded */
    if (existing) {
      const answer = await ask({
        title: `Day ${pad(working.day, 3)} is already recorded`,
        body:
          `Saved:  ${money(existing.earn)} earned · ${money(existing.spend)} spent\n` +
          `Now:    ${money(working.earn)} earned · ${money(working.spend)} spent`,
        actions: [
          { id: "replace", label: "Replace with these numbers", style: "primary" },
          { id: "add", label: "Add to the existing numbers" },
          { id: "cancel", label: "Cancel" }
        ]
      });

      if (!answer || answer === "cancel") return null;

      if (answer === "add") {
        working.earn = Math.round((toAmount(existing.earn) + working.earn) * 100) / 100;
        working.spend = Math.round((toAmount(existing.spend) + working.spend) * 100) / 100;
        const previous = totalsBefore(working.day);
        working.earnTotal = Math.round((previous.earn + working.earn) * 100) / 100;
        working.spendTotal = Math.round((previous.spend + working.spend) * 100) / 100;
      }
    }

    /* 2 — a gap before this day */
    if (!existing && working.day > 1) {
      const missing = [];
      for (let day = Math.max(1, working.day - 10); day < working.day; day++) {
        if (!entries.some((entry) => entry.day === day)) missing.push(pad(day, 3));
      }
      if (missing.length) {
        const range = missing.length === 1
          ? `Day ${missing[0]} has no entry.`
          : `Days ${missing[0]}–${missing[missing.length - 1]} have no entries.`;
        const answer = await ask({
          title: "There is a gap",
          body: `${range}\n\nSave this as day ${pad(working.day, 3)} anyway? The numbering is fixed to your start date, so nothing after this shifts.`,
          actions: [
            { id: "save", label: `Save as day ${pad(working.day, 3)}`, style: "primary" },
            { id: "cancel", label: "Go back" }
          ]
        });
        if (answer !== "save") return null;
      }
    }

    /* 3 — nothing entered */
    if (working.earn === 0 && working.spend === 0) {
      const answer = await ask({
        title: "Both amounts are zero",
        body: `Save day ${pad(working.day, 3)} with ₹0 earned and ₹0 spent?\n\nThe stamp is permanent once written.`,
        actions: [
          { id: "save", label: "Save with zeros", style: "primary" },
          { id: "cancel", label: "Go back" }
        ]
      });
      if (answer !== "save") return null;
    }

    /* 4 — an implausible number, before it becomes permanent */
    const history = entries.filter((entry) => toAmount(entry.earn) > 0);
    if (history.length >= 3 && working.earn > 0) {
      const average = history.reduce((sum, entry) => sum + toAmount(entry.earn), 0) / history.length;
      if (working.earn > average * 6 && working.earn > 1000) {
        const answer = await ask({
          title: "That figure looks unusual",
          body:
            `${money(working.earn)} is about ${(working.earn / average).toFixed(1)}× your average of ` +
            `${money(Math.round(average))}.\n\nOnce it is stamped into the photograph it cannot be edited.`,
          actions: [
            { id: "save", label: "It is correct — save", style: "primary" },
            { id: "cancel", label: "Go back and fix it" }
          ]
        });
        if (answer !== "save") return null;
      }
    }

    return working;
  }

  /* ------------------------------------------------------------- save */

  async function saveDraft(mode) {
    if (!draft || busy) return;
    const share = mode === "drive";
    busy = true;
    setSaveEnabled(false);

    // Already stored: hand the existing JPEG straight to the share sheet,
    // with no dialogs in the way (keeps the user gesture intact).
    if (share && draft.saved) {
      try {
        const outcome = await sharePhoto(draft.saved.blob, draft.saved.filename);
        reportShare(outcome);
      } catch (error) {
        say(error.message || "Could not open the share sheet", 3600);
      } finally {
        busy = false;
        setSaveEnabled(true);
      }
      return;
    }

    try {
      const confirmed = await confirmMeta({ ...draft.meta });
      if (!confirmed) {
        setSaveEnabled(true);
        return;
      }

      // Numbers may have changed in the "add" branch, so restamp.
      const recomposed = await composeStamped(draft.canvas, OUTPUT.width, OUTPUT.height, confirmed);
      const filename = fileNameFor(confirmed.day, confirmed.date);

      const record = {
        day: confirmed.day,
        date: confirmed.date,
        earn: confirmed.earn,
        spend: confirmed.spend,
        earnTotal: confirmed.earnTotal,
        spendTotal: confirmed.spendTotal,
        filename,
        notes: "",
        blob: recomposed.blob,
        created: Date.now()
      };

      await writeEntry(record);
      entries = await readAllEntries();
      await recomputeTotals();
      entries = await readAllEntries();

      draft.saved = { blob: recomposed.blob, filename };

      el.reviewImage.src = URL.createObjectURL(recomposed.blob);
      el.savedFile.textContent = filename;
      el.savedFlag.classList.add("is-on");
      el.reviewCaption.textContent =
        `Stored on this device. Totals are now ${money(record.earnTotal)} earned and ` +
        `${money(record.spendTotal)} spent.`;

      clearDraftInputs();
      await refreshAll();

      if (share) {
        const outcome = await sharePhoto(recomposed.blob, filename);
        reportShare(outcome);
      }
    } catch (error) {
      say(error.message || "Could not save", 3600);
      setSaveEnabled(true);
    } finally {
      busy = false;
    }
  }

  function clearDraftInputs() {
    el.earn.value = "";
    el.spend.value = "";
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (e) { /* ignore */ }
    refreshTally();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ------------------------------------------------------------ views */

  function showView(id) {
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("is-active", view.id === id);
    });
    document.querySelectorAll(".tabbar button").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === id));
    });

    if (id === "view-camera") {
      startCamera();
      refreshGhost();
    } else {
      stopCamera();
    }
    window.scrollTo({ top: 0 });
  }

  /* ------------------------------------------------------------- tally */

  function refreshTally() {
    const meta = buildMeta();
    el.tallyEarn.textContent = money(meta.earnTotal);
    el.tallySpend.textContent = money(meta.spendTotal);
    const net = meta.earnTotal - meta.spendTotal;
    el.tallyNet.textContent = money(net);
    el.tallyNet.classList.toggle("neg", net < 0);

    const label = meta.day >= 1 ? pad(meta.day, 3) : "—";
    el.dayMark.textContent = "DAY " + label;
    el.captureDay.textContent = label;
  }

  function refreshGhost() {
    const latest = entries.length ? entries[entries.length - 1] : null;
    const usable = settings.ghost && latest && latest.blob && latest.day !== dayNumberFor(todayISO());

    if (latest && latest.blob) {
      // Prefer the most recent photograph that is not today's.
      const previous = [...entries].reverse().find((entry) => entry.blob && entry.date !== todayISO());
      if (settings.ghost && previous) {
        if (el.ghost.dataset.url) URL.revokeObjectURL(el.ghost.dataset.url);
        const url = URL.createObjectURL(previous.blob);
        el.ghost.dataset.url = url;
        el.ghost.src = url;
        el.ghost.classList.add("is-on");
      } else {
        el.ghost.classList.remove("is-on");
      }
    } else {
      el.ghost.classList.remove("is-on");
    }

    el.guides.hidden = !settings.guides;
    $("btnGuides").classList.toggle("is-off", !settings.guides);
    $("btnGuides").setAttribute("aria-pressed", String(settings.guides));
    $("btnGhost").classList.toggle("is-off", !settings.ghost);
    $("btnGhost").setAttribute("aria-pressed", String(settings.ghost));
  }

  function refreshLedger() {
    el.ledgerCount.textContent = entries.length === 1 ? "1 day" : `${entries.length} days`;

    if (!entries.length) {
      el.ledgerList.innerHTML =
        '<div class="blank"><em>Nothing recorded yet</em>Your first photograph will appear here.</div>';
      return;
    }

    const rows = [...entries].reverse().map((entry) => {
      const thumb = entry.blob ? URL.createObjectURL(entry.blob) : "";
      const net = toAmount(entry.earn) - toAmount(entry.spend);
      return `
        <div class="entry-row">
          ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : '<div class="thumb"></div>'}
          <div class="body">
            <div class="line1">
              <span class="day-no">DAY ${pad(entry.day, 3)}</span>
              <span class="date">${escapeHTML(formatDate(entry.date))}</span>
            </div>
            <div class="line2">
              <span class="up">+${money(entry.earn)}</span>
              <span class="sep">·</span>
              <span class="down">−${money(entry.spend)}</span>
              <span class="sep">·</span>
              <span>${money(net)}</span>
            </div>
          </div>
          <button class="remove" data-remove="${entry.day}" aria-label="Delete day ${entry.day}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18"/>
            </svg>
          </button>
        </div>`;
    }).join("");

    el.ledgerList.innerHTML = rows;

    el.ledgerList.querySelectorAll("[data-remove]").forEach((button) => {
      button.addEventListener("click", async () => {
        const day = Number(button.dataset.remove);
        const answer = await ask({
          title: `Delete day ${pad(day, 3)}?`,
          body: "The photograph and its numbers are removed from this device. Later totals will be recalculated.",
          actions: [
            { id: "cancel", label: "Keep it" },
            { id: "delete", label: "Delete", style: "danger" }
          ]
        });
        if (answer !== "delete") return;

        await deleteEntry(day);
        entries = await readAllEntries();
        await recomputeTotals();
        entries = await readAllEntries();
        await refreshAll();
        say(`Day ${pad(day, 3)} deleted`);
      });
    });
  }

  async function refreshAll() {
    refreshTally();
    refreshGhost();
    refreshLedger();
  }

  /* -------------------------------------------------------------- CSV */

  const CSV_COLUMNS = [
    "date", "day", "earn", "spend", "net",
    "earn_total", "spend_total", "photo_file", "notes"
  ];

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function exportCSV() {
    if (!entries.length) {
      say("There is nothing to export yet");
      return;
    }

    const lines = [CSV_COLUMNS.join(",")];
    for (const entry of entries) {
      lines.push([
        entry.date,
        entry.day,
        toAmount(entry.earn),
        toAmount(entry.spend),
        Math.round((toAmount(entry.earn) - toAmount(entry.spend)) * 100) / 100,
        toAmount(entry.earnTotal),
        toAmount(entry.spendTotal),
        entry.filename || fileNameFor(entry.day, entry.date),
        entry.notes || ""
      ].map(csvCell).join(","));
    }

    const blob = new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `daily365-${todayISO()}.csv`);
    say("CSV exported");
  }

  function splitCSVLine(line) {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (quoted) {
        if (character === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            quoted = false;
          }
        } else {
          current += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        cells.push(current);
        current = "";
      } else {
        current += character;
      }
    }
    cells.push(current);
    return cells;
  }

  async function importCSV(file) {
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length);
    if (lines.length < 2) {
      say("That CSV has no data rows");
      return;
    }

    const header = splitCSVLine(lines[0]).map((cell) => cell.trim().toLowerCase());
    const column = {
      date: header.indexOf("date"),
      day: header.indexOf("day"),
      earn: header.indexOf("earn"),
      spend: header.indexOf("spend"),
      notes: header.indexOf("notes")
    };

    if (column.date < 0 || column.day < 0 || column.earn < 0) {
      say("CSV needs at least date, day and earn columns", 3600);
      return;
    }

    let added = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const cells = splitCSVLine(lines[i]);
      const day = parseInt(cells[column.day], 10);
      const date = (cells[column.date] || "").slice(0, 10);

      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        skipped++;
        continue;
      }
      if (entries.some((entry) => entry.day === day)) {
        skipped++;
        continue;
      }

      entries.push({
        day,
        date,
        earn: toAmount(cells[column.earn]),
        spend: column.spend >= 0 ? toAmount(cells[column.spend]) : 0,
        earnTotal: 0,
        spendTotal: 0,
        filename: fileNameFor(day, date),
        notes: column.notes >= 0 ? (cells[column.notes] || "") : "",
        blob: null,
        created: Date.now()
      });
      added++;
    }

    entries.sort((a, b) => a.day - b.day);
    for (const entry of entries) await writeEntry(entry);
    entries = await readAllEntries();
    await recomputeTotals();
    entries = await readAllEntries();
    await refreshAll();

    say(`Imported ${added} ${added === 1 ? "day" : "days"}${skipped ? `, skipped ${skipped}` : ""}`, 3200);
  }

  /* ------------------------------------------------------- Save to Drive */

  /*
     No OAuth, no client ID, no Drive permission. The JPEG is handed to the
     operating system's share sheet; the user picks Google Drive (or anything
     else) and chooses the folder themselves. If the browser cannot share
     files, we fall back to the system save dialog, then to a download.
  */

  async function sharePhoto(blob, filename) {
    const file = new File([blob], filename, { type: "image/jpeg" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return "shared";
      } catch (error) {
        if (error && error.name === "AbortError") return "cancelled";
      }
    }

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "JPEG image", accept: { "image/jpeg": [".jpg"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return "saved";
      } catch (error) {
        if (error && error.name === "AbortError") return "cancelled";
      }
    }

    downloadBlob(blob, filename);
    return "downloaded";
  }

  function reportShare(outcome) {
    if (outcome === "shared") {
      say("Saved. Pick Google Drive in the share sheet, then choose a folder.", 4200);
    } else if (outcome === "saved") {
      say("Saved through the file picker.", 3200);
    } else if (outcome === "downloaded") {
      say("Saved to downloads — this browser cannot open a share sheet.", 4200);
    } else if (outcome === "cancelled") {
      say("Share cancelled. The photo is still saved on this device.", 3600);
    }
  }

  /* ---------------------------------------------------------- switches */

  function setSwitch(element, on) {
    element.setAttribute("aria-checked", String(Boolean(on)));
  }

  function bindSwitch(element, key, after) {
    setSwitch(element, settings[key]);
    element.addEventListener("click", () => {
      settings[key] = !settings[key];
      setSwitch(element, settings[key]);
      persistSettings();
      if (after) after();
    });
  }

  /* ------------------------------------------------------------- wiring */

  function bindEvents() {
    // tabs
    document.querySelectorAll(".tabbar button").forEach((tab) => {
      tab.addEventListener("click", () => showView(tab.dataset.tab));
    });

    // amounts
    el.earn.addEventListener("input", () => {
      refreshTally();
      saveDraftInputs();
    });
    el.spend.addEventListener("input", () => {
      refreshTally();
      saveDraftInputs();
    });
    el.earn.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        el.spend.focus();
      }
    });
    el.spend.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        el.spend.blur();
      }
    });

    // capture
    $("btnCapture").addEventListener("click", captureFromCamera);
    $("btnGallery").addEventListener("click", () => el.fileInput.click());
    $("btnCamGallery").addEventListener("click", () => el.fileInput.click());
    el.fileInput.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) captureFromFile(file);
      event.target.value = "";
    });

    $("btnFlip").addEventListener("click", () => {
      facing = facing === "user" ? "environment" : "user";
      settings.deviceId = "";
      persistSettings();
      startCamera();
    });

    $("btnSwitchDevice").addEventListener("click", pickDevice);
    $("btnPickDevice").addEventListener("click", pickDevice);
    $("btnCamRetry").addEventListener("click", startCamera);

    $("btnGuides").addEventListener("click", () => {
      settings.guides = !settings.guides;
      persistSettings();
      refreshGhost();
      say(settings.guides ? "Framing guides on" : "Framing guides off");
    });
    $("btnGhost").addEventListener("click", () => {
      settings.ghost = !settings.ghost;
      persistSettings();
      refreshGhost();
      say(
        settings.ghost
          ? (entries.length ? "Ghost overlay on" : "Ghost on — it appears once yesterday's photo exists")
          : "Ghost overlay off"
      );
    });

    // review
    $("btnRetake").addEventListener("click", () => {
      if (draft && draft.objectUrl) URL.revokeObjectURL(draft.objectUrl);
      draft = null;
      showView("view-camera");
    });
    $("btnSave").addEventListener("click", () => saveDraft("save"));
    $("btnSaveDrive").addEventListener("click", () => saveDraft("drive"));

    // settings
    el.startDate.addEventListener("change", (event) => {
      if (!event.target.value) return;
      settings.startDate = event.target.value;
      persistSettings();
      refreshAll();
      say("Day one set — today is day " + pad(dayNumberFor(todayISO()), 3));
    });

    el.dateFormat.addEventListener("change", (event) => {
      settings.dateFormat = event.target.value;
      persistSettings();
      refreshAll();
    });

    bindSwitch($("swGuides"), "guides", refreshGhost);
    bindSwitch($("swGhost"), "ghost", refreshGhost);
    bindSwitch($("swMirror"), "mirror", () => {
      el.camera.classList.toggle("is-unmirrored", !settings.mirror);
    });

    $("btnExport").addEventListener("click", exportCSV);
    $("btnImport").addEventListener("click", () => el.csvInput.click());
    el.csvInput.addEventListener("change", async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (!file) return;
      try {
        await importCSV(file);
      } catch (error) {
        say(error.message || "Import failed", 3600);
      }
    });

    $("btnWipe").addEventListener("click", async () => {
      const answer = await ask({
        title: "Delete everything?",
        body: `All ${entries.length} days — photographs and numbers — will be erased from this browser.\n\nExport a CSV first if you are unsure.`,
        actions: [
          { id: "cancel", label: "Cancel" },
          { id: "wipe", label: "Delete everything", style: "danger" }
        ]
      });
      if (answer !== "wipe") return;

      await clearEntries();
      entries = [];
      await refreshAll();
      showView("view-camera");
      say("Everything deleted");
    });

    // camera hot-plug (a virtual camera starting counts)
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener("devicechange", () => {
        if ($("view-camera").classList.contains("is-active")) startCamera();
      });
    }

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopCamera();
      else if ($("view-camera").classList.contains("is-active")) startCamera();
    });

    window.addEventListener("pagehide", stopCamera);
  }

  function saveDraftInputs() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        earn: el.earn.value,
        spend: el.spend.value
      }));
    } catch (e) { /* ignore */ }
  }

  function restoreDraftInputs() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved.earn === "string") el.earn.value = saved.earn;
      if (saved && typeof saved.spend === "string") el.spend.value = saved.spend;
    } catch (e) { /* ignore */ }
  }

  function refreshSettingsInputs() {
    el.startDate.value = settings.startDate;
    el.dateFormat.value = settings.dateFormat;
    setSwitch($("swGuides"), settings.guides);
    setSwitch($("swGhost"), settings.ghost);
    setSwitch($("swMirror"), settings.mirror);
  }

  /* --------------------------------------------------------------- boot */

  async function boot() {
    cacheElements();
    loadSettings();
    refreshSettingsInputs();
    bindEvents();
    restoreDraftInputs();
    refreshTally();

    try {
      db = await openDatabase();
      entries = await readAllEntries();
      await recomputeTotals();
      entries = await readAllEntries();
    } catch (error) {
      say("Storage is unavailable: " + error.message, 5000);
    }

    await refreshAll();
    refreshSettingsInputs();
    await refreshDeviceLabel();

    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is optional */ });
    }

    showView("view-camera");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
