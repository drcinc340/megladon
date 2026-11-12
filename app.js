/* MEGLADON — Apex Home Improvement AI Sales Coach Frontend Engine
   Built for Adriano Vagnini & Dinverno Remodeling and Construction (+1 (248) 431-4609)
*/

const state = {
  apiBase: "",
  reps: [],
  activeRepId: localStorage.getItem("megladon_rep_id") || "rep_adriano",
  personas: [],
  selectedPersonaId: "price_grinder_frank",
  trades: [],
  objections: [],
  nepqArsenal: [],
  stages: [],
  pillars: [],
  masters: [],
  assignments: [],
  activeSession: null,
  currentAudio: null,
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  speechRec: null,
  sendingTurn: false,
};

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md) {
  let html = esc(md || "");
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code style='background:rgba(14,165,233,0.15);padding:2px 6px;border-radius:4px;color:#7dd3fc;'>$1</code>");
  const lines = html.split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[-•]\s+/.test(trimmed)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${trimmed.replace(/^[-•]\s+/, "")}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (trimmed === "") {
        out.push("");
      } else if (/^<h[1-3]>/.test(trimmed)) {
        out.push(trimmed);
      } else {
        out.push(`<p>${trimmed}</p>`);
      }
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

async function resolveApiBase() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("api")) {
    state.apiBase = params.get("api").replace(/\/+$/, "");
    return;
  }
  // If running directly on FastAPI/Starlette server
  try {
    const r = await fetch("/api/status", { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      state.apiBase = "";
      return;
    }
  } catch (_) {}

  // Otherwise check static tunnel_config.json (used when deployed on Surge / GitHub Pages)
  try {
    const cfgRes = await fetch(`./tunnel_config.json?t=${Date.now()}`, { cache: "no-store" });
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (cfg.api_url) {
        state.apiBase = cfg.api_url.replace(/\/+$/, "");
      }
    }
  } catch (_) {}
}

async function apiFetch(path, options = {}) {
  const url = `${state.apiBase}${path}`;
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ============================================================================
   NEURAL VOICE PLAYBACK (ELEVENLABS + BROWSER FALLBACK)
============================================================================ */

function stopActiveAudio() {
  if (state.currentAudio) {
    try {
      state.currentAudio.pause();
      state.currentAudio.currentTime = 0;
    } catch (_) {}
    state.currentAudio = null;
  }
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
  const orb = document.getElementById("liveVoiceOrb");
  if (orb) orb.classList.remove("speaking");
}

async function speakText(text, personaId = "coach_megladon") {
  if (!text) return;
  stopActiveAudio();
  const orb = document.getElementById("liveVoiceOrb");
  if (orb) orb.classList.add("speaking");

  try {
    const res = await fetch(`${state.apiBase}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, persona_id: personaId }),
    });
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.includes("audio/mpeg")) {
      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      state.currentAudio = audio;
      audio.onended = () => {
        if (orb) orb.classList.remove("speaking");
        URL.revokeObjectURL(audioUrl);
      };
      audio.onerror = () => {
        if (orb) orb.classList.remove("speaking");
      };
      await audio.play();
      return;
    }
  } catch (_) {}

  // Browser neural speech fallback
  if ("speechSynthesis" in window) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.02;
    utter.onend = () => {
      if (orb) orb.classList.remove("speaking");
    };
    window.speechSynthesis.speak(utter);
  } else if (orb) {
    orb.classList.remove("speaking");
  }
}

/* ============================================================================
   PUSH-TO-TALK VOICE RECORDING (MEDIARECORDER -> GEMINI STT + LIVE CAPTIONS)
============================================================================ */

async function toggleMicRecording() {
  const micBtn = document.getElementById("micToggleBtn");
  const banner = document.getElementById("recordingStatusBanner");
  const orb = document.getElementById("liveVoiceOrb");
  const input = document.getElementById("repMessageInput");

  // Barge-in: silence homeowner immediately when rep starts talking
  stopActiveAudio();

  if (state.isRecording) {
    state.isRecording = false;
    micBtn.classList.remove("recording");
    if (orb) orb.classList.remove("recording");
    banner.style.display = "none";

    if (state.speechRec) {
      try { state.speechRec.stop(); } catch (_) {}
      state.speechRec = null;
    }
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();
    }
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : "";

    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    state.mediaRecorder = recorder;
    state.isRecording = true;

    micBtn.classList.add("recording");
    if (orb) orb.classList.add("recording");
    banner.textContent = "🎙️ Listening... Speak naturally like you're at the kitchen table, then tap the red mic again to send!";
    banner.style.display = "block";

    // Optional live interim preview on desktop Chrome/Edge
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let interimText = "";
    if (SR) {
      try {
        const sr = new SR();
        sr.continuous = true;
        sr.interimResults = true;
        sr.lang = "en-US";
        sr.onresult = (ev) => {
          let built = "";
          for (let i = 0; i < ev.results.length; i++) {
            built += ev.results[i][0].transcript + " ";
          }
          interimText = built.trim();
          if (interimText) input.value = interimText;
        };
        sr.start();
        state.speechRec = sr;
      } catch (_) {}
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) state.audioChunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(state.audioChunks, { type: recorder.mimeType || "audio/webm" });
      if (blob.size < 600 && !input.value.trim()) return;

      banner.textContent = "⚡ Transcribing your pitch with Megladon Voice AI...";
      banner.style.display = "block";

      try {
        const fd = new FormData();
        fd.append("audio", blob, "rep_pitch.webm");
        const r = await fetch(`${state.apiBase}/api/stt`, { method: "POST", body: fd });
        const d = await r.json();
        if (d.ok && d.transcript && d.transcript.trim()) {
          input.value = d.transcript.trim();
        }
      } catch (_) {}

      banner.style.display = "none";
      if (input.value.trim()) {
        await submitRepTurn();
      }
    };

    recorder.start();
  } catch (err) {
    alert("Microphone permission is required for voice roleplay: " + err.message);
  }
}

/* ============================================================================
   UI RENDERING & BOOTSTRAP
============================================================================ */

function renderRepSelector() {
  const sel = document.getElementById("repSelect");
  const assignSel = document.getElementById("assignRepSelect");
  if (!state.reps.find((r) => r.id === state.activeRepId) && state.reps.length) {
    state.activeRepId = state.reps[0].id;
  }
  sel.innerHTML = state.reps
    .map((r) => `<option value="${esc(r.id)}" ${r.id === state.activeRepId ? "selected" : ""}>${esc(r.name)} (${esc(r.role.split("/")[0].trim())})</option>`)
    .join("");

  if (assignSel) {
    assignSel.innerHTML = state.reps
      .map((r) => `<option value="${esc(r.id)}">${esc(r.name)} — ${esc(r.role)}</option>`)
      .join("");
  }
  updateActiveRepBadge();
  renderPendingAssignments();
}

function updateActiveRepBadge() {
  const rep = state.reps.find((r) => r.id === state.activeRepId);
  if (!rep) return;
  const rk = rep.rank || { title: "Reef Pup", xp: 0, progress_pct: 10 };
  document.getElementById("repRankBadge").textContent = `🦈 ${rk.title}`;
  document.getElementById("repXpLabel").textContent = `${rk.xp} XP`;
  document.getElementById("repXpFill").style.width = `${Math.max(8, rk.progress_pct)}%`;
}

function renderPendingAssignments() {
  const box = document.getElementById("pendingAssignmentBanner");
  if (!box) return;
  const mine = (state.assignments || []).filter((a) => a.rep_id === state.activeRepId && a.status === "pending");
  if (!mine.length) {
    box.style.display = "none";
    return;
  }
  const top = mine[0];
  box.style.display = "block";
  box.innerHTML = `
    <div class="assignments-banner">
      <div>
        <div style="font-size:0.72rem;font-weight:800;color:var(--gold);text-transform:uppercase;letter-spacing:0.07em;">
          🎯 Assigned By ${esc(top.assigned_by)} (${mine.length} Pending Drill${mine.length > 1 ? "s" : ""})
        </div>
        <div style="font-weight:800;font-size:1rem;margin-top:2px;">${esc(top.title)} — ${esc(top.trade)}</div>
        ${top.notes ? `<div style="font-size:0.82rem;color:#fef3c7;margin-top:3px;">Coach Note: "${esc(top.notes)}"</div>` : ""}
      </div>
      <button class="btn btn-gold btn-sm" id="launchAssignedDrillBtn">⚡ Launch Assigned Drill Now</button>
    </div>
  `;
  document.getElementById("launchAssignedDrillBtn").onclick = () => {
    startSession({
      mode: top.mode,
      persona_id: top.persona_id,
      trade: top.trade,
      difficulty: top.difficulty,
      objection_focus: top.objection_focus,
      custom_context: top.notes,
    });
  };
}

function renderPersonaSetup() {
  const grid = document.getElementById("personaGrid");
  grid.innerHTML = state.personas
    .map((p) => {
      const isSel = p.id === state.selectedPersonaId;
      const bossTag = p.difficulty_default === "megladon_boss"
        ? `<span style="background:rgba(245,158,11,0.2);color:var(--gold);border:1px solid var(--border-gold);padding:2px 7px;border-radius:999px;font-size:0.66rem;font-weight:800;">BOSS</span>`
        : "";
      return `
        <div class="card persona-card ${isSel ? "selected" : ""}" data-pid="${esc(p.id)}">
          <div class="persona-top">
            <div class="persona-avatar">${esc(p.avatar_emoji)}</div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                <span class="persona-name">${esc(p.name)}</span>
                ${bossTag}
              </div>
              <div class="persona-arch">${esc(p.archetype)}</div>
              <div class="persona-loc">📍 ${esc(p.location)}</div>
            </div>
          </div>
          <p class="persona-desc">${esc(p.summary)}</p>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.74rem;color:var(--text-muted);margin-top:auto;padding-top:6px;border-top:1px solid rgba(148,163,184,0.1);">
            <span>Default: <strong style="color:#e2e8f0;">${esc(p.default_trade.split("&")[0])}</strong></span>
            <span>🔐 3 Secret Clues</span>
          </div>
        </div>
      `;
    })
    .join("");

  grid.querySelectorAll(".persona-card").forEach((el) => {
    el.onclick = () => {
      state.selectedPersonaId = el.dataset.pid;
      const p = state.personas.find((x) => x.id === state.selectedPersonaId);
      if (p) {
        document.getElementById("setupTrade").value = p.default_trade;
        document.getElementById("setupDifficulty").value = p.difficulty_default;
        updateTradePreview();
      }
      renderPersonaSetup();
    };
  });
}

function populateTradesAndDropdowns() {
  const tradeHtml = state.trades.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("");
  ["setupTrade", "gauntletTradeSelect", "coachLabTrade", "assignTradeSelect"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = tradeHtml;
  });

  const pSel = document.getElementById("assignPersonaSelect");
  if (pSel) {
    pSel.innerHTML = state.personas.map((p) => `<option value="${esc(p.id)}">${esc(p.avatar_emoji)} ${esc(p.name)} (${esc(p.archetype)})</option>`).join("");
  }
  const oSel = document.getElementById("assignObjectionSelect");
  if (oSel) {
    oSel.innerHTML = state.objections.map((o) => `<option value="${esc(o.key)}">${esc(o.title)}</option>`).join("");
  }

  const selP = state.personas.find((x) => x.id === state.selectedPersonaId);
  if (selP) {
    document.getElementById("setupTrade").value = selP.default_trade;
  }
  updateTradePreview();
}

function updateTradePreview() {
  const tName = document.getElementById("setupTrade").value;
  const t = state.trades.find((x) => x.name === tName) || state.trades[0];
  if (!t) return;
  document.getElementById("tradePreviewStrip").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;">
      <div>
        <strong style="color:var(--cyan);">DRC ${esc(t.name)} Tiers:</strong>
        <span style="margin-left:8px;">Good: <strong>${esc(t.typical_tiers.good)}</strong> • Better: <strong style="color:var(--gold);">${esc(t.typical_tiers.better)}</strong> • Best: <strong>${esc(t.typical_tiers.best)}</strong></span>
        <span style="margin-left:10px;background:rgba(16,185,129,0.16);color:#34d399;padding:2px 8px;border-radius:999px;font-weight:700;font-size:0.76rem;">Promo Financing from ${esc(t.monthly_from)}</span>
      </div>
      <div style="color:var(--text-secondary);font-size:0.8rem;max-width:680px;">
        <strong>Code & Build Spec:</strong> ${esc(t.code_and_specs)}
      </div>
    </div>
  `;
}

function renderObjectionGauntlet() {
  const grid = document.getElementById("objectionGauntletGrid");
  grid.innerHTML = state.objections
    .map((o) => `
      <div class="card objection-card">
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span class="obj-cat-badge">${esc(o.category)}</span>
            <span style="font-size:0.74rem;color:var(--text-muted);font-weight:700;">Difficulty: ${esc(o.difficulty)}</span>
          </div>
          <h3 style="font-size:1.06rem;margin-bottom:8px;color:#fff;">${esc(o.title)}</h3>
          <p style="font-size:0.86rem;color:#cbd5e1;font-style:italic;margin-bottom:8px;">"${esc(o.homeowner_says)}"</p>
          <p style="font-size:0.8rem;color:var(--text-secondary);"><strong>🧠 Real Psychology:</strong> ${esc(o.hidden_meaning)}</p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--border-subtle);">
          <button class="btn btn-primary btn-sm spar-obj-btn" data-okey="${esc(o.key)}" style="flex:1;">
            ⚡ Spar Live Against This Now
          </button>
          <button class="btn btn-ghost btn-sm study-obj-btn" data-okey="${esc(o.key)}">
            📖 3 Master Scripts
          </button>
        </div>
      </div>
    `)
    .join("");

  grid.querySelectorAll(".spar-obj-btn").forEach((btn) => {
    btn.onclick = () => {
      const okey = btn.dataset.okey;
      const trade = document.getElementById("gauntletTradeSelect").value;
      // Pick matching persona or default tough persona
      const matchingPersona =
        state.personas.find((p) => (p.primary_objections || []).includes(okey)) || state.personas[0];
      switchView("view-arena");
      startSession({
        mode: "objection_gauntlet",
        persona_id: matchingPersona.id,
        trade,
        difficulty: "pro",
        objection_focus: okey,
      });
    };
  });

  grid.querySelectorAll(".study-obj-btn").forEach((btn) => {
    btn.onclick = () => openObjectionStudyModal(btn.dataset.okey);
  });
}

function openObjectionStudyModal(okey) {
  const o = state.objections.find((x) => x.key === okey);
  if (!o) return;
  const modal = document.getElementById("objectionStudyModal");
  const body = document.getElementById("objectionStudyBody");

  const fwEntries = Object.entries(o.frameworks || {});
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;">
      <div>
        <span class="obj-cat-badge">${esc(o.category)}</span>
        <h2 style="font-size:1.35rem;margin-top:6px;">${esc(o.title)}</h2>
      </div>
      <button class="btn btn-ghost btn-sm" id="closeStudyModalBtn">✕ Close</button>
    </div>

    <div class="card" style="background:rgba(244,63,94,0.08);border-color:rgba(244,63,94,0.28);margin-bottom:14px;">
      <div style="font-size:0.76rem;font-weight:800;color:#fda4af;text-transform:uppercase;margin-bottom:6px;">🚫 Deadly Rookie Mistakes To Avoid</div>
      <ul style="padding-left:18px;font-size:0.84rem;color:#fecdd3;line-height:1.55;">
        ${(o.rookie_mistakes || []).map((m) => `<li>${esc(m)}</li>`).join("")}
      </ul>
    </div>

    <h3 style="font-size:0.9rem;color:var(--gold);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">
      🦈 Word-For-Word Proven Rebuttals (Click 🔊 To Hear Coach Megladon Deliver It)
    </h3>
    ${fwEntries
      .map(
        ([k, script], idx) => `
      <div class="framework-block">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong style="color:var(--cyan);text-transform:uppercase;font-size:0.74rem;">Angle ${idx + 1}: ${esc(k.replace(/_/g, " "))}</strong>
          <button class="btn btn-ghost btn-sm play-fw-btn" data-script="${esc(script.replace(/^"|"$/g, ""))}">🔊 Hear Delivery</button>
        </div>
        <div style="color:#f1f5f9;">${esc(script)}</div>
      </div>
    `
      )
      .join("")}
  `;

  modal.classList.add("open");
  document.getElementById("closeStudyModalBtn").onclick = () => {
    stopActiveAudio();
    modal.classList.remove("open");
  };
  body.querySelectorAll(".play-fw-btn").forEach((b) => {
    b.onclick = () => speakText(b.dataset.script, "coach_megladon");
  });
}

function renderPlaybookVault() {
  const nepqEl = document.getElementById("nepqArsenalGrid");
  if (nepqEl) {
    nepqEl.innerHTML = (state.nepqArsenal || [])
      .map(
        (st) => `
        <div class="card" style="border-color:rgba(16,185,129,0.28);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
            <strong style="color:#34d399;font-size:1rem;">${esc(st.stage)}</strong>
            <span style="font-size:0.71rem;background:rgba(14,165,233,0.16);color:#7dd3fc;padding:3px 8px;border-radius:999px;font-weight:700;">🎙️ Tonality: ${esc(st.tonality)}</span>
          </div>
          <p style="font-size:0.81rem;color:var(--text-secondary);margin-bottom:10px;">${esc(st.purpose)}</p>
          <div style="display:flex;flex-direction:column;gap:8px;">
            ${(st.questions || [])
              .map(
                (q) => `
              <div style="background:rgba(5,8,17,0.65);border-left:3px solid #10b981;padding:9px 11px;border-radius:0 8px 8px 0;font-size:0.83rem;line-height:1.48;">
                <div style="color:#f1f5f9;margin-bottom:6px;">${esc(q)}</div>
                <div style="display:flex;gap:8px;">
                  <button class="btn btn-ghost btn-sm hear-nepq-btn" data-q="${esc(q)}" style="padding:4px 9px;font-size:0.73rem;">🔊 Hear Tonality</button>
                  <button class="btn btn-ghost btn-sm copy-nepq-btn" data-q="${esc(q.replace(/^"|"$/g, ""))}" style="padding:4px 9px;font-size:0.73rem;">📋 Copy</button>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `
      )
      .join("");

    nepqEl.querySelectorAll(".hear-nepq-btn").forEach((b) => {
      b.onclick = () => speakText(b.dataset.q, "coach_megladon");
    });
    nepqEl.querySelectorAll(".copy-nepq-btn").forEach((b) => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.q);
        b.textContent = "✅ Copied!";
        setTimeout(() => (b.textContent = "📋 Copy"), 1400);
      };
    });
  }

  document.getElementById("stagesRoadmapGrid").innerHTML = state.stages
    .map(
      (s) => `
      <div class="card">
        <div style="font-size:0.72rem;font-weight:900;color:var(--gold);text-transform:uppercase;letter-spacing:0.08em;">Step ${esc(s.step)}</div>
        <h4 style="font-size:1rem;margin:4px 0 8px;">${esc(s.label)}</h4>
        <p style="font-size:0.84rem;color:var(--text-secondary);line-height:1.5;">${esc(s.goal)}</p>
      </div>
    `
    )
    .join("");

  document.getElementById("mastersVaultGrid").innerHTML = state.masters
    .map(
      (m) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <strong style="font-size:1.05rem;color:#fff;">${esc(m.name)}</strong>
          <span style="font-size:0.73rem;color:var(--cyan);font-weight:700;">${esc(m.system)}</span>
        </div>
        <p style="font-size:0.85rem;color:var(--text-secondary);line-height:1.55;">${esc(m.core_rule)}</p>
      </div>
    `
    )
    .join("");
}

/* ============================================================================
   LIVE ROLEPLAY SESSION ENGINE
============================================================================ */

async function startSession(opts = {}) {
  const payload = {
    rep_id: state.activeRepId,
    mode: opts.mode || "full_roleplay",
    persona_id: opts.persona_id || state.selectedPersonaId,
    trade: opts.trade || document.getElementById("setupTrade").value,
    difficulty: opts.difficulty || document.getElementById("setupDifficulty").value,
    objection_focus: opts.objection_focus || "",
    custom_context: opts.custom_context ?? document.getElementById("setupCustomContext").value,
  };

  const btn = document.getElementById("launchFullSitBtn");
  const prevTxt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "🦈 Entering Sit...";

  try {
    const data = await apiFetch("/api/sessions/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.activeSession = data.session;
    document.getElementById("arenaSetup").style.display = "none";
    document.getElementById("arenaCockpit").style.display = "block";
    document.getElementById("hintDrawer").classList.remove("open");

    renderActiveCockpit();

    const firstTurn = (state.activeSession.turns || [])[0];
    if (firstTurn && document.getElementById("autoSpeakToggle").checked) {
      speakText(firstTurn.content, state.activeSession.persona_id);
    }
  } catch (err) {
    alert("Could not start roleplay: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prevTxt;
  }
}

function renderActiveCockpit() {
  const sess = state.activeSession;
  if (!sess) return;
  const persona = state.personas.find((p) => p.id === sess.persona_id) || state.personas[0];
  const tradeInfo = state.trades.find((t) => t.name === sess.trade) || state.trades[0];

  document.getElementById("liveVoiceOrb").textContent = persona ? persona.avatar_emoji : "🦈";
  document.getElementById("activePersonaTitle").textContent = `${persona.name} (${sess.mode === "objection_gauntlet" ? "⚡ Gauntlet" : "🏡 Full Sit"})`;
  document.getElementById("activePersonaSub").textContent = `${persona.location} • ${sess.trade} • ${sess.difficulty.toUpperCase()}`;

  // Gauges
  const trust = sess.trust_score ?? 38;
  const val = sess.value_score ?? 25;
  const urg = sess.urgency_score ?? 20;

  document.getElementById("gaugeTrustVal").textContent = `${trust}%`;
  document.getElementById("gaugeTrustBar").style.width = `${trust}%`;
  document.getElementById("gaugeValueVal").textContent = `${val}%`;
  document.getElementById("gaugeValueBar").style.width = `${val}%`;
  document.getElementById("gaugeUrgencyVal").textContent = `${urg}%`;
  document.getElementById("gaugeUrgencyBar").style.width = `${urg}%`;

  const closeReady =
    sess.mode === "objection_gauntlet"
      ? trust >= 74 && val >= 68
      : trust >= 75 && val >= 70 && urg >= 60;
  const gateBadge = document.getElementById("closeGateBadge");
  if (closeReady) {
    gateBadge.innerHTML = `<span style="color:var(--emerald);font-weight:800;">🟢 READY TO ASK FOR SIGNATURE!</span>`;
  } else {
    gateBadge.textContent = "Gate Locked 🔒";
  }

  // Last homeowner turn whisper & mood
  const hoTurns = (sess.turns || []).filter((t) => t.speaker === "homeowner");
  const lastHo = hoTurns[hoTurns.length - 1];
  if (lastHo && lastHo.coach_whisper) {
    document.getElementById("liveCoachWhisper").textContent = lastHo.coach_whisper;
  }
  if (lastHo && lastHo.emotion) {
    document.getElementById("statEmotion").textContent = lastHo.emotion.replace(/_/g, " ");
  }

  // Clues Vault
  const unlocked = sess.unlocked_clues || [];
  document.getElementById("cluesCounter").textContent = `${Math.min(3, unlocked.length)} / 3 Unlocked`;
  const clueSlots = [0, 1, 2].map((idx) => {
    if (unlocked[idx]) {
      return `<div class="clue-item unlocked">🔓 ${esc(unlocked[idx])}</div>`;
    }
    const labels = [
      "🔒 Hidden Clue #1: Emotional Key Driver (Ask 'Why now?')",
      "🔒 Hidden Clue #2: Past Fear / Technical Pain (Probe deeper)",
      "🔒 Hidden Clue #3: Real Budget / Payment Comfort",
    ];
    return `<div class="clue-item">${labels[idx]}</div>`;
  });
  document.getElementById("cluesVaultList").innerHTML = clueSlots.join("");

  // Rilla Telemetry
  const tr = sess.talk_ratio_pct ?? 50;
  const trEl = document.getElementById("statTalkRatio");
  trEl.textContent = `${tr}%`;
  trEl.style.color = tr >= 35 && tr <= 55 ? "var(--emerald)" : tr > 65 ? "var(--rose)" : "var(--gold)";
  document.getElementById("statQuestions").textContent = sess.rep_question_count ?? 0;
  document.getElementById("statFillers").textContent = sess.filler_word_count ?? 0;

  const stg = state.stages.find((s) => s.key === sess.current_stage);
  document.getElementById("stagePill").textContent = stg ? `Step ${stg.step}: ${stg.label}` : sess.current_stage;

  // DRC Cheat Sheet
  if (tradeInfo) {
    document.getElementById("hudTradeCheatSheet").innerHTML = `
      <div style="margin-bottom:6px;">
        <strong style="color:#fff;">Good:</strong> ${esc(tradeInfo.typical_tiers.good)} |
        <strong style="color:var(--gold);">Better:</strong> ${esc(tradeInfo.typical_tiers.better)} |
        <strong style="color:var(--cyan);">Best:</strong> ${esc(tradeInfo.typical_tiers.best)}
      </div>
      <div style="margin-bottom:6px;color:#34d399;font-weight:700;">💳 Promo Monthly: from ${esc(tradeInfo.monthly_from)}</div>
      <div><strong>Specs & Code:</strong> ${esc(tradeInfo.code_and_specs)}</div>
    `;
  }

  // Transcript Bubbles
  const stream = document.getElementById("transcriptStream");
  stream.innerHTML = (sess.turns || [])
    .map((t) => {
      const isRep = t.speaker === "rep";
      const delta = t.trust_delta || 0;
      const deltaHtml =
        !isRep && delta !== 0
          ? `<span class="delta-badge ${delta > 0 ? "delta-pos" : "delta-neg"}">Trust ${delta > 0 ? "+" + delta : delta}</span>`
          : "";
      const tagsHtml =
        (t.tactical_tags || []).length > 0
          ? `<div class="tag-row">${t.tactical_tags.map((tg) => `<span class="tactical-tag">${esc(tg)}</span>`).join("")}</div>`
          : "";

      return `
        <div class="turn-bubble ${isRep ? "turn-rep" : "turn-homeowner"}">
          <div class="turn-meta">
            <span>${isRep ? "🎙️ YOU (DRC Closer)" : `${esc(persona.avatar_emoji)} ${esc(persona.name)}`}</span>
            <div style="display:flex;align-items:center;gap:6px;">
              ${deltaHtml}
              ${
                !isRep
                  ? `<button class="replay-turn-btn" data-txt="${esc(t.content)}" style="background:none;border:none;color:var(--cyan);cursor:pointer;font-size:0.78rem;" title="Replay Voice">🔊</button>`
                  : ""
              }
            </div>
          </div>
          <div>${esc(t.content)}</div>
          ${tagsHtml}
        </div>
      `;
    })
    .join("");

  stream.querySelectorAll(".replay-turn-btn").forEach((b) => {
    b.onclick = () => speakText(b.dataset.txt, sess.persona_id);
  });
  stream.scrollTop = stream.scrollHeight;
}

async function submitRepTurn() {
  if (state.sendingTurn || !state.activeSession) return;
  const input = document.getElementById("repMessageInput");
  const msg = input.value.trim();
  if (!msg) return;

  state.sendingTurn = true;
  input.value = "";
  stopActiveAudio();
  document.getElementById("hintDrawer").classList.remove("open");

  const sendBtn = document.getElementById("sendTurnBtn");
  sendBtn.disabled = true;
  sendBtn.textContent = "Thinking...";

  // Optimistic append
  state.activeSession.turns.push({
    speaker: "rep",
    content: msg,
    tactical_tags: [],
  });
  renderActiveCockpit();

  try {
    const res = await apiFetch(`/api/sessions/${state.activeSession.id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg }),
    });
    state.activeSession = res.session;
    renderActiveCockpit();

    if (document.getElementById("autoSpeakToggle").checked && res.homeowner_turn?.content) {
      speakText(res.homeowner_turn.content, state.activeSession.persona_id);
    }

    if (res.deal_closed) {
      setTimeout(() => {
        if (confirm("🏆 BOOM! The homeowner agreed to move forward with Dinverno Remodeling and Construction! Ready to open your 100-Point Film-Room Scorecard?")) {
          finishAndGradeSession();
        }
      }, 900);
    }
  } catch (err) {
    alert("Turn error: " + err.message);
  } finally {
    state.sendingTurn = false;
    sendBtn.disabled = false;
    sendBtn.textContent = "Send ➤";
  }
}

async function requestCoachRescue(customQuestion = "") {
  if (!state.activeSession) return;
  const drawer = document.getElementById("hintDrawer");
  const box = document.getElementById("hintContent");
  drawer.classList.add("open");
  box.innerHTML = "🦈 Coach Megladon is crafting your exact rebuttal & NEPQ move...";

  try {
    const res = await apiFetch(`/api/sessions/${state.activeSession.id}/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: customQuestion || "" }),
    });
    const h = res.hint || {};
    const opt1 = h.option_nepq || {};
    const opt2 = h.option_closer || {};

    if (h.coach_answer) {
      document.getElementById("liveCoachWhisper").textContent = `🦈 ${h.coach_answer}`;
    }

    const renderOpt = (opt, idx, accentColor) => {
      if (!opt.say_this) return "";
      return `
        <div style="background:rgba(5,8,17,0.78);border:1px solid var(--border-subtle);border-radius:8px;padding:10px 12px;margin-top:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
            <strong style="color:${accentColor};font-size:0.8rem;">${idx}. ${esc(opt.label || "Coach Script")}</strong>
            ${opt.tonality ? `<span style="font-size:0.69rem;color:#94a3b8;">🎙️ ${esc(opt.tonality)}</span>` : ""}
          </div>
          <div style="color:#f8fafc;font-size:0.84rem;line-height:1.46;margin-bottom:8px;">"${esc(opt.say_this)}"</div>
          <div style="display:flex;gap:7px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm send-hint-now-btn" data-line="${esc(opt.say_this)}" style="padding:5px 11px;font-size:0.74rem;">🚀 Say This Now</button>
            <button class="btn btn-ghost btn-sm edit-hint-btn" data-line="${esc(opt.say_this)}" style="padding:5px 11px;font-size:0.74rem;">📝 Edit First</button>
            <button class="btn btn-ghost btn-sm speak-hint-btn" data-line="${esc(opt.say_this)}" style="padding:5px 11px;font-size:0.74rem;">🔊 Hear Coach</button>
          </div>
        </div>
      `;
    };

    box.innerHTML = `
      <div style="margin-bottom:4px;color:#cbd5e1;"><strong>🧠 Diagnosis:</strong> ${esc(h.diagnosis)}</div>
      ${h.coach_answer ? `<div style="margin-bottom:6px;color:#fde68a;"><strong>🎯 Coach Advice:</strong> ${esc(h.coach_answer)}</div>` : ""}
      ${renderOpt(opt1, 1, "var(--cyan)")}
      ${renderOpt(opt2, 2, "var(--gold)")}
    `;

    box.querySelectorAll(".edit-hint-btn").forEach((b) => {
      b.onclick = () => {
        document.getElementById("repMessageInput").value = b.dataset.line;
        document.getElementById("repMessageInput").focus();
      };
    });
    box.querySelectorAll(".send-hint-now-btn").forEach((b) => {
      b.onclick = () => {
        document.getElementById("repMessageInput").value = b.dataset.line;
        submitRepTurn();
      };
    });
    box.querySelectorAll(".speak-hint-btn").forEach((b) => {
      b.onclick = () => speakText(b.dataset.line, "coach_megladon");
    });
  } catch (err) {
    box.textContent = "Could not load rescue hint: " + err.message;
  }
}

async function finishAndGradeSession() {
  if (!state.activeSession) return;
  stopActiveAudio();
  const finishBtn = document.getElementById("finishSitBtn");
  finishBtn.disabled = true;
  finishBtn.textContent = "Grading...";

  try {
    const res = await apiFetch(`/api/sessions/${state.activeSession.id}/finish`, { method: "POST" });
    state.reps = res.reps || state.reps;
    renderRepSelector();
    openScorecardModal(res.session);
    document.getElementById("arenaCockpit").style.display = "none";
    document.getElementById("arenaSetup").style.display = "block";
    state.activeSession = null;
    loadCommandAnalytics();
  } catch (err) {
    alert("Grading error: " + err.message);
  } finally {
    finishBtn.disabled = false;
    finishBtn.textContent = "🏁 Finish & Grade";
  }
}

function openScorecardModal(sess) {
  const modal = document.getElementById("scorecardModal");
  const body = document.getElementById("scorecardModalBody");
  const sc = sess.scorecard || {};
  const pillars = sc.pillars || {};
  const persona = state.personas.find((p) => p.id === sess.persona_id) || { name: sess.persona_id, avatar_emoji: "🏡" };

  const pillarRows = state.pillars
    .map((p) => {
      const val = pillars[p.key] ?? 0;
      const barCol = val >= 82 ? "var(--emerald)" : val >= 68 ? "var(--cyan)" : "var(--gold)";
      return `
        <div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;font-weight:700;margin-bottom:3px;">
            <span>${esc(p.label)} <small style="color:var(--text-muted);">(${esc(p.weight)})</small></span>
            <span>${val}/100</span>
          </div>
          <div class="gauge-bar"><div class="gauge-fill" style="width:${val}%;background:${barCol};"></div></div>
        </div>
      `;
    })
    .join("");

  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid var(--border-subtle);">
      <div style="display:flex;align-items:center;gap:16px;">
        <div class="grade-circle">
          <span>${esc(sess.letter_grade || "B")}</span>
          <span style="font-size:0.75rem;color:#fff;font-weight:700;">${sess.final_score ?? 0}/100</span>
        </div>
        <div>
          <div style="font-size:0.74rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--cyan);font-weight:800;">
            🦈 MEGLADON FILM-ROOM SCORECARD • +${sc.xp_awarded || 0} XP EARNED
          </div>
          <h2 style="font-size:1.35rem;margin-top:3px;">${esc(sess.rep_name || "Closer")} vs. ${esc(persona.name)}</h2>
          <div style="font-size:0.82rem;color:var(--text-secondary);margin-top:2px;">
            ${esc(sess.trade)} • Outcome: <strong style="color:var(--gold);text-transform:uppercase;">${esc((sess.outcome || "").replace(/_/g, " "))}</strong>
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="closeScorecardBtn">✕ Close Scorecard</button>
    </div>

    <div class="grid-2" style="margin-bottom:16px;">
      <div class="card" style="padding:14px;">
        <h4 style="font-size:0.82rem;text-transform:uppercase;color:var(--text-secondary);margin-bottom:10px;">8-Pillar Execution Breakdown</h4>
        ${pillarRows}
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div class="card" style="padding:14px;border-color:rgba(16,185,129,0.3);">
          <h4 style="font-size:0.8rem;text-transform:uppercase;color:#34d399;margin-bottom:6px;">✅ What You Crushed</h4>
          <ul style="padding-left:18px;font-size:0.83rem;line-height:1.52;color:#e2e8f0;">
            ${(sc.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("")}
          </ul>
        </div>
        <div class="card" style="padding:14px;border-color:rgba(245,158,11,0.35);">
          <h4 style="font-size:0.8rem;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">🔧 Margin & Closing Leaks To Tighten</h4>
          <ul style="padding-left:18px;font-size:0.83rem;line-height:1.52;color:#e2e8f0;">
            ${(sc.leaks || []).map((l) => `<li>${esc(l)}</li>`).join("")}
          </ul>
        </div>
      </div>
    </div>

    ${
      sc.weakest_line_megladon_rewrite
        ? `
      <div class="card" style="padding:14px;margin-bottom:16px;">
        <h4 style="font-size:0.82rem;text-transform:uppercase;color:var(--cyan);margin-bottom:4px;">⚡ Instant Line Upgrade (Before vs. 10/10 Megladon Rewrite)</h4>
        <div class="rewrite-compare">
          <div class="rewrite-box rewrite-weak">
            <strong style="color:#fda4af;display:block;font-size:0.74rem;margin-bottom:4px;">❌ WHAT WAS SAID:</strong>
            "${esc(sc.weakest_line_original)}"
          </div>
          <div class="rewrite-box rewrite-strong">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <strong style="color:#34d399;font-size:0.74rem;">🦈 COACH MEGLADON 10/10 REWRITE:</strong>
              <button class="btn btn-ghost btn-sm" id="hearRewriteBtn" data-txt="${esc(sc.weakest_line_megladon_rewrite)}">🔊 Hear It</button>
            </div>
            "${esc(sc.weakest_line_megladon_rewrite)}"
          </div>
        </div>
      </div>`
        : ""
    }

    <div class="card md-output" style="padding:16px;margin-bottom:14px;">
      <h4 style="font-size:0.84rem;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">🎙️ Coach Megladon Film-Room Debrief</h4>
      ${renderMarkdown(sess.debrief_markdown || "")}
    </div>

    <details class="card" style="padding:14px;">
      <summary style="cursor:pointer;font-weight:700;font-size:0.86rem;color:var(--cyan);">📜 View Full Session Transcript (${(sess.turns || []).length} Turns)</summary>
      <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;font-size:0.83rem;">
        ${(sess.turns || [])
          .map(
            (t) => `
          <div style="padding:8px 10px;border-radius:8px;background:rgba(255,255,255,0.03);">
            <strong style="color:${t.speaker === "rep" ? "#38bdf8" : "#fbbf24"};">${t.speaker === "rep" ? "CLOSER" : "HOMEOWNER"}:</strong>
            ${esc(t.content)}
          </div>
        `
          )
          .join("")}
      </div>
    </details>
  `;

  modal.classList.add("open");
  document.getElementById("closeScorecardBtn").onclick = () => {
    stopActiveAudio();
    modal.classList.remove("open");
  };
  const rwBtn = document.getElementById("hearRewriteBtn");
  if (rwBtn) {
    rwBtn.onclick = () => speakText(rwBtn.dataset.txt, "coach_megladon");
  }
}

/* ============================================================================
   COACH MEGLADON LIVE DEAL REHASH LAB & EXECUTIVE COMMAND CENTER
============================================================================ */

async function submitCoachLabQuestion() {
  const q = document.getElementById("coachLabInput").value.trim();
  const trade = document.getElementById("coachLabTrade").value;
  if (!q) return;

  const rep = state.reps.find((r) => r.id === state.activeRepId);
  const btn = document.getElementById("askCoachSubmitBtn");
  const out = document.getElementById("coachLabOutput");
  btn.disabled = true;
  btn.textContent = "🦈 Strategizing...";
  out.style.display = "block";
  out.innerHTML = "<p>🦈 Coach Megladon is crafting your word-for-word battle plan...</p>";

  try {
    const res = await apiFetch("/api/coach/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rep_name: rep ? rep.name : "DRC Closer",
        question: q,
        trade,
      }),
    });
    out.innerHTML = renderMarkdown(res.reply);
  } catch (err) {
    out.innerHTML = `<p style="color:var(--rose);">Error: ${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🦈 Generate Battle Plan & Scripts";
  }
}

async function loadCommandAnalytics() {
  try {
    const data = await apiFetch("/api/analytics/overview");
    state.reps = data.reps || state.reps;
    state.assignments = data.assignments || [];
    renderRepSelector();

    const tbody = document.querySelector("#leaderboardTable tbody");
    tbody.innerHTML = state.reps
      .map(
        (r, i) => `
      <tr>
        <td>
          <div style="font-weight:700;">${i === 0 ? "👑 " : ""}${esc(r.name)}</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">${esc(r.role)}</div>
        </td>
        <td><span class="rank-pill">${esc(r.rank?.title || "Reef Pup")}</span></td>
        <td>${r.sessions_completed || 0}</td>
        <td style="color:var(--emerald);font-weight:700;">${r.closes_won || 0}</td>
        <td style="font-weight:800;">${r.avg_score ? r.avg_score + "/100" : "—"}</td>
        <td style="color:var(--cyan);font-weight:800;">${r.xp || 0} XP</td>
      </tr>
    `
      )
      .join("");

    const sessBody = document.querySelector("#recentSessionsTable tbody");
    const completed = (data.recent_sessions || []).filter((s) => s.status === "completed");
    sessBody.innerHTML = completed.length
      ? completed
          .map((s) => {
            const p = state.personas.find((x) => x.id === s.persona_id);
            return `
            <tr>
              <td style="font-weight:700;">${esc(s.rep_name || s.rep_id)}</td>
              <td>${s.mode === "objection_gauntlet" ? "⚡ Gauntlet" : "🏡 Full Sit"}</td>
              <td>${esc(p ? p.name : s.persona_id)} • <span style="color:var(--text-secondary);">${esc(s.trade)}</span></td>
              <td>${s.trust_score}%</td>
              <td><strong style="color:var(--gold);">${s.final_score ?? "—"}/100 (${esc(s.letter_grade)})</strong></td>
              <td style="text-transform:uppercase;font-size:0.75rem;font-weight:700;">${esc((s.outcome || "").replace(/_/g, " "))}</td>
              <td><button class="btn btn-ghost btn-sm inspect-sess-btn" data-sid="${esc(s.id)}">🎬 Scorecard</button></td>
            </tr>
          `;
          })
          .join("")
      : `<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:22px;">No completed sits yet—launch a roleplay in the Arena to populate Film Room scorecards!</td></tr>`;

    sessBody.querySelectorAll(".inspect-sess-btn").forEach((b) => {
      b.onclick = async () => {
        const res = await apiFetch(`/api/sessions/${b.dataset.sid}`);
        openScorecardModal(res.session);
      };
    });
  } catch (_) {}
}

function switchView(viewId) {
  document.querySelectorAll(".view-section").forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");

  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === viewId);
  });
  document.getElementById("sidebar").classList.remove("mobile-open");

  if (viewId === "view-command") {
    loadCommandAnalytics();
  }
}

/* ============================================================================
   INITIALIZATION & EVENT WIRING
============================================================================ */

async function initApp() {
  await resolveApiBase();
  const boot = await apiFetch("/api/bootstrap");
  state.reps = boot.reps || [];
  state.personas = boot.personas || [];
  state.trades = boot.trades || [];
  state.objections = boot.objections || [];
  state.nepqArsenal = boot.nepq_arsenal || [];
  state.stages = boot.stages || [];
  state.pillars = boot.pillars || [];
  state.masters = boot.masters || [];

  document.getElementById("voiceEngineBadge").textContent = boot.voice_enabled
    ? "● ElevenLabs Neural Voice Live"
    : "● Browser Voice Mode";

  renderRepSelector();
  populateTradesAndDropdowns();
  renderPersonaSetup();
  renderObjectionGauntlet();
  renderPlaybookVault();
  await loadCommandAnalytics();

  // Wire Navigation
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  document.getElementById("mobileMenuBtn").onclick = () => {
    document.getElementById("sidebar").classList.toggle("mobile-open");
  };

  document.getElementById("repSelect").onchange = (e) => {
    state.activeRepId = e.target.value;
    localStorage.setItem("megladon_rep_id", state.activeRepId);
    updateActiveRepBadge();
    renderPendingAssignments();
  };

  document.getElementById("addRepQuickBtn").onclick = async () => {
    const name = prompt("Enter new DRC Sales Rep's Full Name:");
    if (!name || !name.trim()) return;
    const role = prompt("Role / Title:", "Sales Representative") || "Sales Representative";
    const res = await apiFetch("/api/reps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role }),
    });
    state.reps.push(res.rep);
    state.activeRepId = res.rep.id;
    renderRepSelector();
  };

  document.getElementById("setupTrade").onchange = updateTradePreview;
  document.getElementById("launchFullSitBtn").onclick = () => startSession({ mode: "full_roleplay" });

  document.getElementById("sendTurnBtn").onclick = submitRepTurn;
  document.getElementById("repMessageInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitRepTurn();
    }
  });

  document.getElementById("micToggleBtn").onclick = toggleMicRecording;
  document.getElementById("rescueHintBtn").onclick = () => requestCoachRescue("");
  const inSitBtn = document.getElementById("inSitAskCoachBtn");
  const inSitInp = document.getElementById("inSitCoachQuestion");
  if (inSitBtn && inSitInp) {
    const runInSitCoach = () => {
      const q = inSitInp.value.trim();
      inSitInp.value = "";
      requestCoachRescue(q);
    };
    inSitBtn.onclick = runInSitCoach;
    inSitInp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runInSitCoach();
      }
    });
  }
  const nepqBtn = document.getElementById("nepqBankBtn");
  if (nepqBtn) {
    nepqBtn.onclick = () => {
      const drawer = document.getElementById("hintDrawer");
      const box = document.getElementById("hintContent");
      drawer.classList.add("open");
      box.innerHTML = `
        <div style="margin-bottom:6px;color:#34d399;font-weight:700;">🎯 JEREMY MINER 7TH LEVEL NEPQ — CLICK ANY QUESTION TO LOAD IT:</div>
        <div style="max-height:210px;overflow-y:auto;padding-right:4px;">
          ${(state.nepqArsenal || [])
            .map(
              (st) => `
              <div style="margin-top:6px;font-size:0.74rem;color:var(--cyan);font-weight:800;">${esc(st.stage)} — <em>${esc(st.tonality)}</em></div>
              ${(st.questions || [])
                .map((q) => {
                  const cleanQ = q.replace(/^"|"$/g, "").replace(/\[CDD [^\]]+\]\s*/i, "");
                  return `<button class="hint-option-btn nepq-insert-btn" data-line="${esc(cleanQ)}">${esc(q)}</button>`;
                })
                .join("")}
            `
            )
            .join("")}
        </div>
      `;
      box.querySelectorAll(".nepq-insert-btn").forEach((b) => {
        b.onclick = () => {
          document.getElementById("repMessageInput").value = b.dataset.line;
          document.getElementById("repMessageInput").focus();
        };
      });
    };
  }
  document.getElementById("closeHintBtn").onclick = () => document.getElementById("hintDrawer").classList.remove("open");
  document.getElementById("finishSitBtn").onclick = finishAndGradeSession;
  document.getElementById("exitSitBtn").onclick = () => {
    stopActiveAudio();
    document.getElementById("arenaCockpit").style.display = "none";
    document.getElementById("arenaSetup").style.display = "block";
    state.activeSession = null;
  };

  document.getElementById("speakWhisperBtn").onclick = () => {
    const txt = document.getElementById("liveCoachWhisper").textContent;
    speakText(txt, "coach_megladon");
  };

  // Coach Lab
  document.querySelectorAll(".coach-preset").forEach((b) => {
    b.onclick = () => {
      document.getElementById("coachLabInput").value = b.dataset.q;
    };
  });
  document.getElementById("askCoachSubmitBtn").onclick = submitCoachLabQuestion;

  // Executive Command Center
  document.getElementById("refreshAnalyticsBtn").onclick = loadCommandAnalytics;
  document.getElementById("createAssignmentBtn").onclick = async () => {
    const rep_id = document.getElementById("assignRepSelect").value;
    const mode = document.getElementById("assignModeSelect").value;
    const persona_id = document.getElementById("assignPersonaSelect").value;
    const objection_focus = document.getElementById("assignObjectionSelect").value;
    const trade = document.getElementById("assignTradeSelect").value;
    const difficulty = document.getElementById("assignDiffSelect").value;
    const notes = document.getElementById("assignNotesInput").value.trim();
    const objObj = state.objections.find((o) => o.key === objection_focus);
    const title = mode === "objection_gauntlet" && objObj ? `Objection Drill: ${objObj.title}` : `Full Sit vs. ${persona_id}`;

    await apiFetch("/api/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rep_id, title, mode, persona_id, trade, difficulty, objection_focus, notes }),
    });
    document.getElementById("assignNotesInput").value = "";
    await loadCommandAnalytics();
    alert("🦈 Drill dispatched! It will appear at the top of that rep's Arena immediately.");
  };
}

initApp().catch((err) => {
  console.error("Megladon init error:", err);
});
