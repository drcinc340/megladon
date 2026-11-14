/* MEGLADON — Multi-Tenant AI Home Improvement Sales Coach & Prospect Sandbox Engine
   Built for Adriano Vagnini & Dinverno Remodeling and Construction (+1 (248) 431-4609)
*/

const urlParams = new URLSearchParams(window.location.search);

const state = {
  apiBase: "",
  inviteToken: (urlParams.get("invite") || "").trim(),
  isInviteMode: Boolean((urlParams.get("invite") || "").trim()),
  founderPin: localStorage.getItem("megladon_founder_pin") || "",
  founderUnlocked: false,
  previewOrgId: "",
  previewInviteUrl: "",
  orgId: "drc",
  brand: {
    id: "drc",
    name: "Dinverno Remodeling and Construction",
    short_name: "DRC",
    phone: "+1 (248) 431-4609",
    region: "Southeast Michigan",
    tagline: "Dinverno Remodeling Sales Dojo",
    accent_color: "#0ea5e9",
  },
  access: { allowed: true, sessions_used: 0, max_sessions: 0, plan_type: "flagship", status: "active" },
  reps: [],
  activeRepId: "rep_adriano",
  personas: [],
  selectedPersonaId: "price_grinder_frank",
  trades: [],
  objections: [],
  nepqArsenal: [],
  stages: [],
  pillars: [],
  masters: [],
  coachPresets: [],
  assignments: [],
  activeSession: null,
  currentAudio: null,
  isRecording: false,
  mediaRecorder: null,
  audioChunks: [],
  speechRec: null,
  sendingTurn: false,
  // Studio state
  tradesCatalog: [],
  selectedStudioTrades: new Set([
    "Impact Windows & Hurricane Doors",
    "Energy-Efficient Replacement Windows",
    "Architectural Roof Replacement",
    "Luxury Kitchen Remodel",
    "Primary Bath & Wet-Area Remodel",
    "Seamless Gutters & Micro-Mesh Guards",
  ]),
  companiesList: [],
  lastCreatedCompany: null,
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
  if (urlParams.get("api")) {
    state.apiBase = urlParams.get("api").replace(/\/+$/, "");
    return;
  }
  try {
    const r = await fetch("./api/status", { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const data = await r.json().catch(() => null);
      if (data && (data.service === "megladon" || String(data.app || "").includes("MEGLADON"))) {
        state.apiBase = window.location.pathname.replace(/\/index\.html$/i, "").replace(/\/+$/, "");
        return;
      }
    }
  } catch (_) {}

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

function buildTenantHeaders(extraHeaders = {}) {
  const h = { ...extraHeaders };
  if (state.inviteToken) {
    h["X-Invite-Token"] = state.inviteToken;
  } else if (state.previewOrgId && state.founderPin) {
    h["X-Founder-Pin"] = state.founderPin;
    h["X-Org-Id"] = state.previewOrgId;
  } else if (state.founderPin) {
    h["X-Founder-Pin"] = state.founderPin;
  }
  return h;
}

async function apiFetch(path, options = {}) {
  const url = `${state.apiBase}${path}`;
  const opts = {
    ...options,
    headers: buildTenantHeaders(options.headers || {}),
  };
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ============================================================================
   NEURAL VOICE PLAYBACK & PUSH-TO-TALK RECORDING
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
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
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
      headers: buildTenantHeaders({ "Content-Type": "application/json" }),
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

async function toggleMicRecording() {
  const micBtn = document.getElementById("micToggleBtn");
  const banner = document.getElementById("recordingStatusBanner");
  const orb = document.getElementById("liveVoiceOrb");
  const input = document.getElementById("repMessageInput");

  stopActiveAudio();

  if (state.isRecording) {
    state.isRecording = false;
    micBtn.classList.remove("recording");
    if (orb) orb.classList.remove("recording");
    banner.style.display = "none";

    if (state.speechRec) {
      try {
        state.speechRec.stop();
      } catch (_) {}
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
        const r = await fetch(`${state.apiBase}/api/stt`, { method: "POST", headers: buildTenantHeaders(), body: fd });
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
   WHITE-LABEL BRANDING & UI RENDERING
============================================================================ */

function applyCompanyBranding() {
  const b = state.brand || {};
  const name = b.name || "Dinverno Remodeling and Construction";
  const shortName = b.short_name || "DRC";
  const phone = b.phone || "+1 (248) 431-4609";
  const region = b.region || "Southeast Michigan";
  const accent = b.accent_color || "#0ea5e9";

  document.title = `MEGLADON — AI Sales Coach | ${name}`;
  document.documentElement.style.setProperty("--cyan", accent);

  const mobileSub = document.getElementById("mobileBrandSub");
  if (mobileSub) mobileSub.textContent = `${name} Sales Dojo`;

  const sideSub = document.getElementById("sidebarBrandSub");
  if (sideSub) sideSub.textContent = state.orgId === "drc" ? "Apex AI Sales Coach" : `${shortName} Sales Dojo`;

  const sideName = document.getElementById("sidebarCompanyName");
  if (sideName) sideName.textContent = name;

  const sidePhone = document.getElementById("sidebarCompanyPhone");
  if (sidePhone) sidePhone.textContent = phone;

  const arenaSub = document.getElementById("arenaPageSubtitle");
  if (arenaSub) {
    arenaSub.textContent = `Train live by voice or text against hyper-realistic ${region} homeowners. Unlock hidden emotional drivers, hold ${name}'s margin, and earn the close.`;
  }

  const tradeLbl = document.getElementById("setupTradeLabel");
  if (tradeLbl) tradeLbl.textContent = `2. ${shortName} Project Trade & Scope`;

  const hudTitle = document.getElementById("hudTradeTitle");
  if (hudTitle) hudTitle.textContent = `📋 ${shortName} Tiers & Local Code`;

  const pbSub = document.getElementById("playbookPageSubtitle");
  if (pbSub) {
    pbSub.textContent = `Distilled closing DNA from Jeremy Miner (7th Level NEPQ), Dave Yoho, Rodney Webb, Grosso University, Brian Gottlieb, Chris Voss, Rilla Telemetry, and ${name}.`;
  }

  const stgTitle = document.getElementById("stagesRoadmapTitle");
  if (stgTitle) stgTitle.textContent = `The 8-Step ${shortName} Megladon Consultation Roadmap`;

  const lbHead = document.getElementById("leaderboardHeading");
  if (lbHead) lbHead.textContent = `🦈 ${shortName} Closer Standings`;

  // Hide Prospect Studio tab from external invite links
  const studioNav = document.getElementById("navProspectStudioBtn");
  if (studioNav) {
    studioNav.style.display = state.isInviteMode ? "none" : "flex";
  }

  // Founder Preview Top Bar
  const prevBar = document.getElementById("founderPreviewBar");
  if (prevBar) {
    if (!state.isInviteMode && state.previewOrgId && state.previewOrgId !== "drc") {
      prevBar.style.display = "flex";
      document.getElementById("previewCompanyLabel").textContent = `${name} (${region})`;
    } else {
      prevBar.style.display = "none";
    }
  }

  // Prospect Sandbox Trial Meter (for invited prospects)
  const trialBox = document.getElementById("prospectTrialBox");
  if (trialBox) {
    if (state.isInviteMode && state.access) {
      const used = state.access.sessions_used || 0;
      const maxS = state.access.max_sessions || 0;
      trialBox.style.display = "block";
      trialBox.innerHTML = `
        <div style="font-weight:800;color:var(--gold);margin-bottom:3px;">
          ${maxS > 0 ? `🎁 Custom Demo Sandbox` : `🏆 Dedicated Team Portal`}
        </div>
        <div style="color:#e2e8f0;margin-bottom:7px;">
          ${maxS > 0 ? `<strong>${used} / ${maxS}</strong> complimentary sits used` : `Unlimited active seats for <strong>${esc(name)}</strong>`}
        </div>
        <button class="btn btn-gold btn-sm" id="openUpgradeInfoBtn" style="width:100%;font-size:0.73rem;padding:6px 8px;">
          🚀 Activate Full Team License
        </button>
      `;
      document.getElementById("openUpgradeInfoBtn").onclick = openProspectUpgradeModal;
    } else {
      trialBox.style.display = "none";
    }
  }

  // Access Blocked Banner (Paused or Expired)
  const blockedBanner = document.getElementById("accessBlockedBanner");
  if (blockedBanner) {
    if (state.access && state.access.allowed === false) {
      blockedBanner.style.display = "block";
      blockedBanner.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
          <div>
            <strong style="color:var(--gold);font-size:0.95rem;">🔒 Sandbox Trial Notice</strong>
            <div style="color:#f8fafc;font-size:0.86rem;margin-top:3px;">${esc(state.access.message)}</div>
          </div>
          <a href="mailto:drcinc340@gmail.com?subject=${encodeURIComponent("Activate Full MEGLADON License for " + name)}" class="btn btn-gold btn-sm" style="text-decoration:none;">
            ✉️ Contact Adriano Vagnini
          </a>
        </div>
      `;
    } else {
      blockedBanner.style.display = "none";
    }
  }
}

function openProspectUpgradeModal() {
  const modal = document.getElementById("shareCompanyModal");
  const body = document.getElementById("shareCompanyModalBody");
  const name = state.brand?.name || "Your Company";
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 style="font-size:1.25rem;">🦈 Launch Your Dedicated <span style="color:var(--gold);">MEGLADON</span> Dojo</h2>
      <button class="btn btn-ghost btn-sm" id="closeUpgradeModalBtn">✕ Close</button>
    </div>
    <p style="font-size:0.9rem;color:#cbd5e1;line-height:1.6;margin-bottom:14px;">
      This custom sandbox was built by <strong>Adriano Vagnini</strong> specifically for <strong>${esc(name)}</strong>.
      A full dedicated deployment unlocks:
    </p>
    <ul style="padding-left:20px;font-size:0.86rem;color:#e2e8f0;line-height:1.65;margin-bottom:18px;">
      <li><strong>Unlimited Voice &amp; Text Roleplay Sits</strong> across your entire sales force</li>
      <li><strong>Custom Pricing Tiers, Financing Plans &amp; Exact Product Specs</strong> baked into every persona</li>
      <li><strong>Sales Manager Command Center</strong> to assign mandatory drills &amp; audit 100-point Film-Room Scorecards</li>
      <li><strong>Dedicated Custom URL &amp; Mobile Home-Screen PWA</strong> for every rep</li>
    </ul>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;">
      <a href="mailto:drcinc340@gmail.com?subject=${encodeURIComponent("Dedicated MEGLADON Deployment — " + name)}" class="btn btn-gold" style="text-decoration:none;">
        ✉️ Email Adriano Vagnini (drcinc340@gmail.com)
      </a>
    </div>
  `;
  modal.classList.add("open");
  document.getElementById("closeUpgradeModalBtn").onclick = () => modal.classList.remove("open");
}

function renderCoachPresets() {
  const wrap = document.getElementById("quickCoachPrompts");
  if (!wrap) return;
  wrap.innerHTML = (state.coachPresets || [])
    .map(
      (p) =>
        `<button class="btn btn-ghost btn-sm coach-preset" data-trade="${esc(p.trade || "")}" data-q="${esc(p.q)}">${esc(p.label)}</button>`
    )
    .join("");
  wrap.querySelectorAll(".coach-preset").forEach((b) => {
    b.onclick = () => {
      document.getElementById("coachLabInput").value = b.dataset.q;
      if (b.dataset.trade) {
        const tSel = document.getElementById("coachLabTrade");
        if (tSel) tSel.value = b.dataset.trade;
      }
    };
  });
}

function renderRepSelector() {
  const sel = document.getElementById("repSelect");
  const assignSel = document.getElementById("assignRepSelect");
  const savedRep = localStorage.getItem(`megladon_rep_${state.orgId}`);
  if (savedRep && state.reps.find((r) => r.id === savedRep)) {
    state.activeRepId = savedRep;
  } else if (!state.reps.find((r) => r.id === state.activeRepId) && state.reps.length) {
    state.activeRepId = state.reps[0].id;
  }

  sel.innerHTML = state.reps
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === state.activeRepId ? "selected" : ""}>${esc(r.name)} (${esc((r.role || "").split("/")[0].trim())})</option>`
    )
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
      const bossTag =
        p.difficulty_default === "megladon_boss"
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
            <span>Default: <strong style="color:#e2e8f0;">${esc((p.default_trade || "").split("&")[0])}</strong></span>
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
    pSel.innerHTML = state.personas
      .map((p) => `<option value="${esc(p.id)}">${esc(p.avatar_emoji)} ${esc(p.name)} (${esc(p.archetype)})</option>`)
      .join("");
  }
  const oSel = document.getElementById("assignObjectionSelect");
  if (oSel) {
    oSel.innerHTML = state.objections.map((o) => `<option value="${esc(o.key)}">${esc(o.title)}</option>`).join("");
  }

  const selP = state.personas.find((x) => x.id === state.selectedPersonaId) || state.personas[0];
  if (selP && state.trades.some((t) => t.name === selP.default_trade)) {
    document.getElementById("setupTrade").value = selP.default_trade;
  }
  updateTradePreview();
}

function updateTradePreview() {
  const tName = document.getElementById("setupTrade").value;
  const t = state.trades.find((x) => x.name === tName) || state.trades[0];
  if (!t) return;
  const shortBrand = state.brand?.short_name || "DRC";
  document.getElementById("tradePreviewStrip").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;justify-content:space-between;">
      <div>
        <strong style="color:var(--cyan);">${esc(shortBrand)} ${esc(t.name)} Tiers:</strong>
        <span style="margin-left:8px;">Good: <strong>${esc(t.typical_tiers.good)}</strong> • Better: <strong style="color:var(--gold);">${esc(t.typical_tiers.better)}</strong> • Best: <strong>${esc(t.typical_tiers.best)}</strong></span>
        <span style="margin-left:10px;background:rgba(16,185,129,0.16);color:#34d399;padding:2px 8px;border-radius:999px;font-weight:700;font-size:0.76rem;">Promo Financing from ${esc(t.monthly_from)}</span>
      </div>
      <div style="color:var(--text-secondary);font-size:0.8rem;max-width:680px;">
        <strong>Code &amp; Build Spec:</strong> ${esc(t.code_and_specs)}
      </div>
    </div>
  `;
}

function renderObjectionGauntlet() {
  const grid = document.getElementById("objectionGauntletGrid");
  grid.innerHTML = state.objections
    .map(
      (o) => `
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
            📖 Master Scripts
          </button>
        </div>
      </div>
    `
    )
    .join("");

  grid.querySelectorAll(".spar-obj-btn").forEach((btn) => {
    btn.onclick = () => {
      const okey = btn.dataset.okey;
      const trade = document.getElementById("gauntletTradeSelect").value;
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
    if (data.usage) {
      state.access.sessions_used = data.usage.sessions_used;
      state.access.max_sessions = data.usage.max_sessions;
      applyCompanyBranding();
    }
    document.getElementById("arenaSetup").style.display = "none";
    document.getElementById("arenaCockpit").style.display = "block";
    document.getElementById("hintDrawer").classList.remove("open");

    renderActiveCockpit();

    const firstTurn = (state.activeSession.turns || [])[0];
    if (firstTurn && document.getElementById("autoSpeakToggle").checked) {
      speakText(firstTurn.content, state.activeSession.persona_id);
    }
  } catch (err) {
    if (state.isInviteMode && /complimentary|paused|expired/i.test(err.message)) {
      alert(err.message);
      openProspectUpgradeModal();
    } else {
      alert("Could not start roleplay: " + err.message);
    }
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
  const shortBrand = state.brand?.short_name || "DRC";

  document.getElementById("liveVoiceOrb").textContent = persona ? persona.avatar_emoji : "🦈";
  document.getElementById("activePersonaTitle").textContent = `${persona.name} (${sess.mode === "objection_gauntlet" ? "⚡ Gauntlet" : "🏡 Full Sit"})`;
  document.getElementById("activePersonaSub").textContent = `${persona.location} • ${sess.trade} • ${sess.difficulty.toUpperCase()}`;

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

  const hoTurns = (sess.turns || []).filter((t) => t.speaker === "homeowner");
  const lastHo = hoTurns[hoTurns.length - 1];
  if (lastHo && lastHo.coach_whisper) {
    document.getElementById("liveCoachWhisper").textContent = lastHo.coach_whisper;
  }
  if (lastHo && lastHo.emotion) {
    document.getElementById("statEmotion").textContent = lastHo.emotion.replace(/_/g, " ");
  }

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

  const tr = sess.talk_ratio_pct ?? 50;
  const trEl = document.getElementById("statTalkRatio");
  trEl.textContent = `${tr}%`;
  trEl.style.color = tr >= 35 && tr <= 55 ? "var(--emerald)" : tr > 65 ? "var(--rose)" : "var(--gold)";
  document.getElementById("statQuestions").textContent = sess.rep_question_count ?? 0;
  document.getElementById("statFillers").textContent = sess.filler_word_count ?? 0;

  const stg = state.stages.find((s) => s.key === sess.current_stage);
  document.getElementById("stagePill").textContent = stg ? `Step ${stg.step}: ${stg.label}` : sess.current_stage;

  if (tradeInfo) {
    document.getElementById("hudTradeCheatSheet").innerHTML = `
      <div style="margin-bottom:6px;">
        <strong style="color:#fff;">Good:</strong> ${esc(tradeInfo.typical_tiers.good)} |
        <strong style="color:var(--gold);">Better:</strong> ${esc(tradeInfo.typical_tiers.better)} |
        <strong style="color:var(--cyan);">Best:</strong> ${esc(tradeInfo.typical_tiers.best)}
      </div>
      <div style="margin-bottom:6px;color:#34d399;font-weight:700;">💳 Promo Monthly: from ${esc(tradeInfo.monthly_from)}</div>
      <div><strong>Specs &amp; Code:</strong> ${esc(tradeInfo.code_and_specs)}</div>
    `;
  }

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
            <span>${isRep ? `🎙️ YOU (${esc(shortBrand)} Closer)` : `${esc(persona.avatar_emoji)} ${esc(persona.name)}`}</span>
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
        if (
          confirm(
            `🏆 BOOM! The homeowner agreed to move forward with ${state.brand.name}! Ready to open your 100-Point Film-Room Scorecard?`
          )
        ) {
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
          <h4 style="font-size:0.8rem;text-transform:uppercase;color:var(--gold);margin-bottom:6px;">🔧 Margin &amp; Closing Leaks To Tighten</h4>
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
   COACH LAB & EXECUTIVE COMMAND CENTER
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
        rep_name: rep ? rep.name : `${state.brand.short_name} Closer`,
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

/* ============================================================================
   ADRIANO'S PROSPECT & WHITE-LABEL CLIENT STUDIO
============================================================================ */

async function verifyAndLoadStudio(pinCandidate = "") {
  const pin = (pinCandidate || state.founderPin || "").trim();
  if (!pin) {
    document.getElementById("studioLockGate").style.display = "block";
    document.getElementById("studioWorkspace").style.display = "none";
    return false;
  }
  try {
    const res = await fetch(`${state.apiBase}/api/admin/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Founder-Pin": pin },
      body: JSON.stringify({ pin }),
    });
    const d = await res.json();
    if (!res.ok || !d.ok) throw new Error(d.error || "Invalid PIN");

    state.founderPin = pin;
    state.founderUnlocked = true;
    localStorage.setItem("megladon_founder_pin", pin);
    document.getElementById("studioLockGate").style.display = "none";
    document.getElementById("studioWorkspace").style.display = "block";

    await Promise.all([loadStudioCatalog(), loadStudioCompanies()]);
    return true;
  } catch (err) {
    if (pinCandidate) alert("Invalid Founder PIN: " + err.message);
    state.founderUnlocked = false;
    document.getElementById("studioLockGate").style.display = "block";
    document.getElementById("studioWorkspace").style.display = "none";
    return false;
  }
}

async function loadStudioCatalog() {
  if (state.tradesCatalog.length) {
    renderStudioTradeChips();
    return;
  }
  const data = await apiFetch("/api/admin/catalog");
  state.tradesCatalog = data.trades_catalog || [];
  renderStudioTradeChips();
}

function renderStudioTradeChips() {
  const grid = document.getElementById("studioTradeChips");
  if (!grid) return;
  grid.innerHTML = state.tradesCatalog
    .map((t) => {
      const checked = state.selectedStudioTrades.has(t.name);
      return `
        <label class="trade-chip ${checked ? "checked" : ""}" data-tname="${esc(t.name)}">
          <input type="checkbox" ${checked ? "checked" : ""} />
          <span>${esc(t.name)}</span>
        </label>
      `;
    })
    .join("");

  grid.querySelectorAll(".trade-chip").forEach((lbl) => {
    const inp = lbl.querySelector("input");
    inp.onchange = () => {
      const tname = lbl.dataset.tname;
      if (inp.checked) {
        state.selectedStudioTrades.add(tname);
        lbl.classList.add("checked");
      } else {
        state.selectedStudioTrades.delete(tname);
        lbl.classList.remove("checked");
      }
    };
  });
}

async function loadStudioCompanies() {
  const data = await apiFetch("/api/admin/companies");
  state.companiesList = data.companies || [];
  renderCompaniesPipeline();
}

function formatTimeAgo(epochSec) {
  if (!epochSec) return "Never";
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderStudioInviteBanner(comp) {
  const banner = document.getElementById("studioInviteResult");
  if (!comp || comp.id === "drc") {
    banner.style.display = "none";
    return;
  }
  state.lastCreatedCompany = comp;
  banner.style.display = "block";
  banner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:260px;">
        <div style="font-size:0.74rem;font-weight:800;color:#34d399;text-transform:uppercase;letter-spacing:0.06em;">
          ✅ CUSTOM PORTAL LIVE FOR ${esc(comp.name.toUpperCase())} (${esc(comp.region)})
        </div>
        <div style="margin-top:6px;font-size:0.86rem;color:#f8fafc;word-break:break-all;">
          <strong>Private Prospect Link:</strong>
          <a href="${esc(comp.invite_url)}" target="_blank" style="color:var(--cyan);margin-left:6px;">${esc(comp.invite_url)}</a>
        </div>
        <div style="margin-top:4px;font-size:0.77rem;color:var(--text-secondary);">
          Trades (${Object.keys(comp.trades || {}).length}): ${esc(Object.keys(comp.trades || {}).join(" • "))}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn-primary btn-sm" id="bannerCopyInviteBtn">📋 Copy Link</button>
        <button class="btn btn-gold btn-sm" id="bannerPreviewBtn">👁️ Preview As ${esc(comp.name.split(" ")[0])}</button>
        <button class="btn btn-ghost btn-sm" id="bannerSendInviteBtn">📨 Email / SMS Invite</button>
      </div>
    </div>
  `;
  document.getElementById("bannerCopyInviteBtn").onclick = (e) => {
    navigator.clipboard.writeText(comp.invite_url);
    e.target.textContent = "✅ Link Copied!";
    setTimeout(() => (e.target.textContent = "📋 Copy Link"), 1600);
  };
  document.getElementById("bannerPreviewBtn").onclick = () => enterFounderPreview(comp);
  document.getElementById("bannerSendInviteBtn").onclick = () => openShareCompanyModal(comp);
}

function renderCompaniesPipeline() {
  const tbody = document.querySelector("#companiesPipelineTable tbody");
  if (!tbody) return;

  tbody.innerHTML = state.companiesList
    .map((c) => {
      const isFlagship = c.id === "drc";
      const tradeKeys = Object.keys(c.trades || {});
      const tradesBadge = tradeKeys.slice(0, 3).map((t) => esc(c.trades[t]?.short || t)).join(", ") +
        (tradeKeys.length > 3 ? ` +${tradeKeys.length - 3}` : "");

      let pillClass = "status-trial";
      let pillLabel = "Active Trial";
      if (isFlagship) {
        pillClass = "status-flagship";
        pillLabel = "Flagship HQ";
      } else if (c.status === "paused") {
        pillClass = "status-paused";
        pillLabel = "Paused";
      } else if (c.plan_type === "client" || Number(c.max_sessions) === 0) {
        pillClass = "status-client";
        pillLabel = "Full Client";
      }

      const sitsText = isFlagship || Number(c.max_sessions) === 0
        ? `${c.sessions_used || 0} / ∞`
        : `${c.sessions_used || 0} / ${c.max_sessions}`;

      const controlsHtml = isFlagship
        ? `<span style="font-size:0.75rem;color:var(--text-muted);">Main DRC Portal</span>`
        : `
          <div style="display:flex;gap:5px;flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm tbl-copy-btn" data-cid="${esc(c.id)}" title="Copy Private Invite Link">🔗 Copy</button>
            <button class="btn btn-gold btn-sm tbl-preview-btn" data-cid="${esc(c.id)}" title="Preview Live Sandbox">👁️ Preview</button>
            <button class="btn btn-ghost btn-sm tbl-share-btn" data-cid="${esc(c.id)}" title="Email or Text Link">📨 Send</button>
            <button class="btn btn-ghost btn-sm tbl-plus-btn" data-cid="${esc(c.id)}" title="Add +20 Demo Sits">+20 Sits</button>
            <button class="btn btn-ghost btn-sm tbl-toggle-btn" data-cid="${esc(c.id)}" title="Pause or Resume Access">${c.status === "paused" ? "▶️ Resume" : "⏸️ Pause"}</button>
            ${c.plan_type !== "client" ? `<button class="btn btn-ghost btn-sm tbl-upgrade-btn" data-cid="${esc(c.id)}" title="Convert to Unlimited Client">🏆 Unlimited</button>` : ""}
            <button class="btn btn-danger btn-sm tbl-del-btn" data-cid="${esc(c.id)}" title="Delete Sandbox">🗑️</button>
          </div>
        `;

      return `
        <tr>
          <td>
            <div style="font-weight:800;color:#fff;">${esc(c.name)}</div>
            <div style="font-size:0.74rem;color:var(--text-secondary);">📍 ${esc(c.region || "—")} ${c.contact_name ? `• ${esc(c.contact_name)}` : ""}</div>
          </td>
          <td style="font-size:0.78rem;color:#cbd5e1;max-width:230px;">${tradesBadge || "—"}</td>
          <td><span class="status-pill ${pillClass}">${pillLabel}</span></td>
          <td style="font-size:0.8rem;">
            <strong>${c.views_count || 0}</strong> opens
            <div style="font-size:0.7rem;color:var(--text-muted);">Active: ${formatTimeAgo(c.last_active_at)}</div>
          </td>
          <td style="font-weight:700;">${sitsText}</td>
          <td style="font-weight:800;color:var(--gold);">${c.avg_score ? `${c.avg_score}/100` : "—"}</td>
          <td>${controlsHtml}</td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".tbl-copy-btn").forEach((b) => {
    b.onclick = () => {
      const c = state.companiesList.find((x) => x.id === b.dataset.cid);
      if (!c) return;
      navigator.clipboard.writeText(c.invite_url);
      b.textContent = "✅ Copied";
      setTimeout(() => (b.textContent = "🔗 Copy"), 1400);
    };
  });

  tbody.querySelectorAll(".tbl-preview-btn").forEach((b) => {
    b.onclick = () => {
      const c = state.companiesList.find((x) => x.id === b.dataset.cid);
      if (c) enterFounderPreview(c);
    };
  });

  tbody.querySelectorAll(".tbl-share-btn").forEach((b) => {
    b.onclick = () => {
      const c = state.companiesList.find((x) => x.id === b.dataset.cid);
      if (c) openShareCompanyModal(c);
    };
  });

  tbody.querySelectorAll(".tbl-plus-btn").forEach((b) => {
    b.onclick = async () => {
      await apiFetch(`/api/admin/companies/${b.dataset.cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add_sessions: 20 }),
      });
      await loadStudioCompanies();
    };
  });

  tbody.querySelectorAll(".tbl-toggle-btn").forEach((b) => {
    b.onclick = async () => {
      const c = state.companiesList.find((x) => x.id === b.dataset.cid);
      if (!c) return;
      const nextStatus = c.status === "paused" ? "active" : "paused";
      await apiFetch(`/api/admin/companies/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadStudioCompanies();
    };
  });

  tbody.querySelectorAll(".tbl-upgrade-btn").forEach((b) => {
    b.onclick = async () => {
      await apiFetch(`/api/admin/companies/${b.dataset.cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_type: "client", max_sessions: 0, expires_at: null, status: "active" }),
      });
      await loadStudioCompanies();
    };
  });

  tbody.querySelectorAll(".tbl-del-btn").forEach((b) => {
    b.onclick = async () => {
      const c = state.companiesList.find((x) => x.id === b.dataset.cid);
      if (!c) return;
      if (!confirm(`Permanently delete ${c.name}'s sandbox portal, reps, and demo sessions?`)) return;
      await apiFetch(`/api/admin/companies/${c.id}`, { method: "DELETE" });
      if (state.lastCreatedCompany?.id === c.id) {
        document.getElementById("studioInviteResult").style.display = "none";
      }
      await loadStudioCompanies();
    };
  });
}

async function createProspectiveCompany() {
  const name = document.getElementById("newCompName").value.trim();
  const region = document.getElementById("newCompRegion").value.trim();
  if (!name) {
    alert("Enter the Prospective Company Name first.");
    return;
  }
  if (!region) {
    alert("Enter their Market / City & State (e.g., Tampa Bay, FL or Dallas, TX).");
    return;
  }

  const trade_names = Array.from(state.selectedStudioTrades);
  const custom_trades = document.getElementById("newCompCustomTrades").value.trim();
  if (!trade_names.length && !custom_trades) {
    alert("Select at least 1 trade this company sells.");
    return;
  }

  const btn = document.getElementById("createCompanyBtn");
  const prevTxt = btn.textContent;
  btn.disabled = true;
  btn.textContent = "🦈 Tailoring Custom Sandbox...";

  try {
    const payload = {
      name,
      region,
      phone: document.getElementById("newCompPhone").value.trim(),
      contact_name: document.getElementById("newCompContactName").value.trim(),
      contact_email: document.getElementById("newCompContactEmail").value.trim(),
      contact_phone: document.getElementById("newCompContactPhone").value.trim(),
      plan_type: document.getElementById("newCompPlanType").value,
      max_sessions: Number(document.getElementById("newCompMaxSessions").value),
      trial_days: Number(document.getElementById("newCompTrialDays").value),
      accent_color: document.getElementById("newCompColor").value,
      starter_reps: document.getElementById("newCompStarterReps").value.trim(),
      custom_trades,
      trade_names,
      use_ai_tailor: document.getElementById("newCompAiTailor").checked,
    };

    const res = await apiFetch("/api/admin/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    document.getElementById("newCompName").value = "";
    document.getElementById("newCompStarterReps").value = "";
    document.getElementById("newCompCustomTrades").value = "";

    renderStudioInviteBanner(res.company);
    await loadStudioCompanies();
  } catch (err) {
    alert("Could not create company portal: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prevTxt;
  }
}

function openShareCompanyModal(comp) {
  const modal = document.getElementById("shareCompanyModal");
  const body = document.getElementById("shareCompanyModalBody");
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <h2 style="font-size:1.2rem;">📨 Share <span style="color:var(--gold);">${esc(comp.name)}</span> Private Sandbox</h2>
      <button class="btn btn-ghost btn-sm" id="closeShareModalBtn">✕ Close</button>
    </div>

    <div style="background:rgba(5,8,17,0.75);border:1px solid var(--border-subtle);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:0.82rem;word-break:break-all;">
      <div style="color:var(--text-secondary);font-size:0.72rem;text-transform:uppercase;font-weight:700;margin-bottom:4px;">Private Invite URL</div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="color:var(--cyan);">${esc(comp.invite_url)}</span>
        <button class="btn btn-ghost btn-sm" id="modalCopyUrlBtn">📋 Copy</button>
      </div>
    </div>

    <div class="grid-2" style="margin-bottom:12px;">
      <div class="field-group">
        <label>Recipient Email (Tracked Open Pixel)</label>
        <input id="shareEmailInput" type="email" class="input-ctrl" value="${esc(comp.contact_email || "")}" placeholder="owner@company.com" />
      </div>
      <div class="field-group">
        <label>Recipient Mobile (SMS Text)</label>
        <input id="sharePhoneInput" type="text" class="input-ctrl" value="${esc(comp.contact_phone || "")}" placeholder="e.g. 813-555-0144" />
      </div>
    </div>

    <div class="field-group" style="margin-bottom:14px;">
      <label>Optional Personal Note From Adriano</label>
      <textarea id="shareCustomNote" class="input-ctrl" rows="2" placeholder="e.g., Built this specifically around your Impact Windows & Bath teams—try 'Price-Grinder Frank' on voice mode!"></textarea>
    </div>

    <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px;font-size:0.84rem;">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="shareSendEmailChk" ${comp.contact_email ? "checked" : ""} />
        <span>📧 Send Tracked Email</span>
      </label>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input type="checkbox" id="shareSendSmsChk" ${comp.contact_phone ? "checked" : ""} />
        <span>📱 Send SMS Invite</span>
      </label>
    </div>

    <div id="shareDispatchStatus" style="font-size:0.83rem;margin-bottom:10px;"></div>

    <div style="display:flex;justify-content:flex-end;gap:8px;">
      <button class="btn btn-gold" id="confirmShareDispatchBtn">🚀 Dispatch Private Invite Now</button>
    </div>
  `;

  modal.classList.add("open");
  document.getElementById("closeShareModalBtn").onclick = () => modal.classList.remove("open");
  document.getElementById("modalCopyUrlBtn").onclick = (e) => {
    navigator.clipboard.writeText(comp.invite_url);
    e.target.textContent = "✅ Copied!";
  };
  document.getElementById("confirmShareDispatchBtn").onclick = async (e) => {
    const btn = e.target;
    const statusEl = document.getElementById("shareDispatchStatus");
    const email = document.getElementById("shareEmailInput").value.trim();
    const phone = document.getElementById("sharePhoneInput").value.trim();
    const send_email = document.getElementById("shareSendEmailChk").checked;
    const send_sms = document.getElementById("shareSendSmsChk").checked;
    const custom_note = document.getElementById("shareCustomNote").value.trim();

    if (send_email && !email) {
      alert("Enter an email address or uncheck Send Tracked Email.");
      return;
    }
    if (send_sms && !phone) {
      alert("Enter a mobile number or uncheck Send SMS Invite.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Sending...";
    statusEl.innerHTML = `<span style="color:var(--cyan);">Dispatching invite...</span>`;

    try {
      const res = await apiFetch(`/api/admin/companies/${comp.id}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone, send_email, send_sms, custom_note }),
      });
      const d = res.dispatch || {};
      const parts = [];
      if (d.email_sent) parts.push("✅ Tracked Email Delivered");
      if (d.email_error) parts.push(`⚠️ Email: ${d.email_error}`);
      if (d.sms_sent) parts.push("✅ SMS Delivered");
      if (d.sms_error) parts.push(`⚠️ SMS: ${d.sms_error}`);
      statusEl.innerHTML = `<strong style="color:#34d399;">${esc(parts.join(" • ") || "Invite ready")}</strong>`;
      await loadStudioCompanies();
    } catch (err) {
      statusEl.innerHTML = `<span style="color:var(--rose);">Error: ${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 Dispatch Private Invite Now";
    }
  };
}

async function enterFounderPreview(comp) {
  stopActiveAudio();
  state.activeSession = null;
  document.getElementById("arenaCockpit").style.display = "none";
  document.getElementById("arenaSetup").style.display = "block";
  state.previewOrgId = comp.id;
  state.previewInviteUrl = comp.invite_url;
  await loadTenantBootstrap(false);
  switchView("view-arena");
}

async function exitFounderPreview() {
  stopActiveAudio();
  state.activeSession = null;
  document.getElementById("arenaCockpit").style.display = "none";
  document.getElementById("arenaSetup").style.display = "block";
  state.previewOrgId = "";
  state.previewInviteUrl = "";
  await loadTenantBootstrap(false);
  switchView("view-studio");
}

/* ============================================================================
   NAVIGATION, BOOTSTRAP & EVENT WIRING
============================================================================ */

function switchView(viewId) {
  if (viewId === "view-studio" && state.isInviteMode) return;

  document.querySelectorAll(".view-section").forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(viewId);
  if (target) target.classList.add("active");

  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === viewId);
  });
  document.getElementById("sidebar").classList.remove("mobile-open");

  if (viewId === "view-command") {
    loadCommandAnalytics();
  } else if (viewId === "view-studio") {
    verifyAndLoadStudio();
  }
}

async function loadTenantBootstrap(trackView = false) {
  const qs = trackView && state.isInviteMode ? "?track_view=1" : "";
  const boot = await apiFetch(`/api/bootstrap${qs}`);
  state.orgId = boot.org_id || "drc";
  state.brand = boot.brand || state.brand;
  state.access = boot.access || state.access;
  state.reps = boot.reps || [];
  state.personas = boot.personas || [];
  state.trades = boot.trades || [];
  state.objections = boot.objections || [];
  state.nepqArsenal = boot.nepq_arsenal || [];
  state.stages = boot.stages || [];
  state.pillars = boot.pillars || [];
  state.masters = boot.masters || [];
  state.coachPresets = boot.coach_presets || [];

  document.getElementById("voiceEngineBadge").textContent = boot.voice_enabled
    ? "● ElevenLabs Neural Voice Live"
    : "● Browser Voice Mode";

  applyCompanyBranding();
  renderRepSelector();
  populateTradesAndDropdowns();
  renderPersonaSetup();
  renderObjectionGauntlet();
  renderCoachPresets();
  renderPlaybookVault();
  await loadCommandAnalytics();
}

async function initApp() {
  await resolveApiBase();

  try {
    await loadTenantBootstrap(true);
  } catch (err) {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;">
        <div class="card" style="max-width:480px;padding:30px;">
          <div style="font-size:2.4rem;margin-bottom:10px;">🦈</div>
          <h2 style="margin-bottom:8px;">MEGLADON Portal Notice</h2>
          <p style="color:var(--text-secondary);font-size:0.9rem;line-height:1.6;margin-bottom:18px;">${esc(err.message)}</p>
          <a href="mailto:drcinc340@gmail.com" class="btn btn-gold" style="text-decoration:none;">Contact Adriano Vagnini</a>
        </div>
      </div>
    `;
    return;
  }

  // Wire Navigation
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  document.getElementById("mobileMenuBtn").onclick = () => {
    document.getElementById("sidebar").classList.toggle("mobile-open");
  };

  document.getElementById("repSelect").onchange = (e) => {
    state.activeRepId = e.target.value;
    localStorage.setItem(`megladon_rep_${state.orgId}`, state.activeRepId);
    updateActiveRepBadge();
    renderPendingAssignments();
  };

  document.getElementById("addRepQuickBtn").onclick = async () => {
    const name = prompt(`Enter new ${state.brand.name} Sales Rep's Full Name:`);
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

  // Founder Preview Bar Buttons
  document.getElementById("exitPreviewBtn").onclick = exitFounderPreview;
  document.getElementById("previewCopyLinkBtn").onclick = (e) => {
    if (!state.previewInviteUrl) return;
    navigator.clipboard.writeText(state.previewInviteUrl);
    e.target.textContent = "✅ Link Copied!";
    setTimeout(() => (e.target.textContent = "📋 Copy Their Invite Link"), 1600);
  };

  // Founder Prospect Studio Wiring
  document.getElementById("unlockStudioBtn").onclick = () => {
    const pin = document.getElementById("founderPinInput").value.trim();
    verifyAndLoadStudio(pin);
  };
  document.getElementById("founderPinInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      verifyAndLoadStudio(e.target.value.trim());
    }
  });
  document.getElementById("refreshStudioBtn").onclick = () => {
    if (state.founderUnlocked) loadStudioCompanies();
  };
  document.getElementById("createCompanyBtn").onclick = createProspectiveCompany;

  document.getElementById("presetExteriorsBtn").onclick = () => {
    state.selectedStudioTrades = new Set(
      state.tradesCatalog.filter((t) => t.category === "Exteriors").map((t) => t.name)
    );
    renderStudioTradeChips();
  };
  document.getElementById("presetInteriorsBtn").onclick = () => {
    state.selectedStudioTrades = new Set([
      "Luxury Kitchen Remodel",
      "Primary Bath & Wet-Area Remodel",
      "Walk-In Tubs & Mobility Showers",
      "4-Season Sunroom / Patio Enclosure",
    ]);
    renderStudioTradeChips();
  };
  document.getElementById("presetAllTradesBtn").onclick = () => {
    state.selectedStudioTrades = new Set(state.tradesCatalog.map((t) => t.name));
    renderStudioTradeChips();
  };
  document.getElementById("presetClearTradesBtn").onclick = () => {
    state.selectedStudioTrades = new Set();
    renderStudioTradeChips();
  };

  // Support ?studio=1 deep link for Adriano
  if (!state.isInviteMode && urlParams.get("studio") === "1") {
    switchView("view-studio");
  }
}

initApp().catch((err) => {
  console.error("Megladon init error:", err);
});
