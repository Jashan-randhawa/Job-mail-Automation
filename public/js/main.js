import { extractEmailFromText } from './emailExtract.js';

/* ================= UTILITIES ================= */
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (t) => t * t * (3 - 2 * t);

/* ================= THEME ================= */
(function theme(){
  const root = document.documentElement;
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;
  function setTheme(dark, persist){
    root.dataset.theme = dark ? 'dark' : 'light';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    if (persist){ try { localStorage.setItem('autosend-theme', dark ? 'dark' : 'light'); } catch (_e){} }
  }
  setTheme(root.dataset.theme === 'dark', false);
  toggle.addEventListener('click', () => setTheme(root.dataset.theme !== 'dark', true));
})();

/* ================= HAMBURGER MENU ================= */
(function hamburgerMenu(){
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (!hamburger || !navLinks) return;

  function closeMenu(){
    document.body.classList.remove('nav-open');
    hamburger.setAttribute('aria-expanded', 'false');
  }
  function toggleMenu(){
    const open = document.body.classList.toggle('nav-open');
    hamburger.setAttribute('aria-expanded', String(open));
  }

  hamburger.addEventListener('click', toggleMenu);
  navLinks.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('nav-open')) return;
    if (navLinks.contains(e.target) || hamburger.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
})();

/* ================= AMBIENT: pause off-screen, drift with cursor ================= */
(function ambient(){
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('page-hidden', document.hidden);
  });

  if (REDUCED) return;
  const bg = document.getElementById('ambientBg');
  const isDesktop = matchMedia('(hover:hover) and (pointer:fine) and (min-width:901px)').matches;
  if (!bg || !isDesktop) return;

  let mx = 0, my = 0, tx = 0, ty = 0, raf = null;
  function step(){
    tx += (mx - tx) * .06;
    ty += (my - ty) * .06;
    bg.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0)`;
    if (Math.abs(mx - tx) > .05 || Math.abs(my - ty) > .05) raf = requestAnimationFrame(step);
    else raf = null;
  }
  addEventListener('pointermove', (e) => {
    mx = (e.clientX / innerWidth - .5) * 2 * 16;
    my = (e.clientY / innerHeight - .5) * 2 * 12;
    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });
})();

/* ================= CLOCK ================= */
(function clock(){
  const t = document.getElementById('clockTime');
  function tick(){ const d = new Date(); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2,'0'); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; t.textContent = h + ':' + m + ' ' + ap; }
  tick(); setInterval(tick, 15000);
})();

/* ================= COOKIE BANNER ================= */
(function cookie(){
  const el = document.getElementById('cookie');
  try { if (localStorage.getItem('autosend-cookies')) el.classList.add('hide'); } catch(_e){}
  const done = (v) => { try { localStorage.setItem('autosend-cookies', v); } catch(_e){} el.classList.add('hide'); };
  document.getElementById('cookieAccept').addEventListener('click', () => done('accept'));
  document.getElementById('cookieDecline').addEventListener('click', () => done('decline'));
})();


/* ================= WORKFLOW VIDEO: reveal and pause off-screen ================= */
(function workflowVideo(){
  const wrap = document.getElementById('workflowVideoWrap');
  const video = document.getElementById('workflowVideo');
  if (!wrap || !video) return;
  if (REDUCED){ video.pause(); wrap.classList.add('is-visible'); return; }
  if (!('IntersectionObserver' in window)){ wrap.classList.add('is-visible'); video.play().catch(() => {}); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting){
        wrap.classList.add('is-visible');
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, { threshold: .15 });
  io.observe(wrap);
})();

/* ================= HERO ENGINE ANIMATION: 50-frame disassembly/reassembly loop =================
   Lives in the hero section now (moved from Vision). Same reveal-on-scroll +
   pause-off-screen contract the workflow video uses (the "is-visible" class +
   IntersectionObserver), just driving a canvas frame sequence instead of a
   <video> element. Frames preload once; playback is a plain
   requestAnimationFrame loop keyed off wall-clock time so it stays smooth
   regardless of frame rate. */
(function engineAnimation(){
  const wrap = document.getElementById('heroEngineWrap');
  const canvas = document.getElementById('engineCanvas');
  const phaseEl = document.getElementById('enginePhase');
  const progressFill = document.getElementById('engineProgressFill');
  if (!wrap || !canvas) return;
  const ctx = canvas.getContext('2d');

  const FRAME_COUNT = 50;
  const FRAME_PATH = (i) => `assets/hero-frames/frame-${String(i).padStart(3, '0')}.webp`;
  const CYCLE_MS = 4200;
  const HOLD_AT_LOOP_MS = 260;
  const PHASES = [
    { at: 0.00, text: 'Scattered applications' },
    { at: 0.14, text: 'Reading context' },
    { at: 0.32, text: 'AI understanding' },
    { at: 0.52, text: 'Personalized email' },
    { at: 0.70, text: 'Outreach queue' },
    { at: 0.86, text: 'Automated send' }
  ];

  const images = new Array(FRAME_COUNT);
  let loadedCount = 0;
  let currentFrame = 1;
  let lastPhase = -1;
  let playing = false;
  let raf = null;
  let startTime = null;

  function drawFrame(index){
    const img = images[index - 1];
    if (!img || !img.complete || !img.naturalWidth) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  function activePhaseIndex(progress){
    let idx = 0;
    for (let i = 0; i < PHASES.length; i++) if (progress >= PHASES[i].at) idx = i;
    return idx;
  }

  const totalMs = CYCLE_MS + HOLD_AT_LOOP_MS;
  function tick(now){
    if (!playing) return;
    if (startTime === null) startTime = now;
    const elapsed = (now - startTime) % totalMs;
    const progress = elapsed <= CYCLE_MS ? elapsed / CYCLE_MS : 1;

    const frame = Math.min(FRAME_COUNT, Math.max(1, Math.round(progress * (FRAME_COUNT - 1)) + 1));
    if (frame !== currentFrame){ currentFrame = frame; drawFrame(currentFrame); }
    if (progressFill) progressFill.style.width = `${progress * 100}%`;

    const pIdx = activePhaseIndex(progress);
    if (pIdx !== lastPhase){ lastPhase = pIdx; if (phaseEl) phaseEl.textContent = PHASES[pIdx].text; }

    raf = requestAnimationFrame(tick);
  }

  function play(){ if (playing) return; playing = true; startTime = null; raf = requestAnimationFrame(tick); }
  function pause(){ playing = false; if (raf) cancelAnimationFrame(raf); raf = null; }

  function preload(){
    for (let i = 1; i <= FRAME_COUNT; i++){
      const img = new Image();
      img.onload = img.onerror = () => {
        loadedCount++;
        if (i === 1) drawFrame(1);
      };
      img.src = FRAME_PATH(i);
      images[i - 1] = img;
    }
  }
  preload();

  if (REDUCED){
    wrap.classList.add('is-visible');
    if (phaseEl) phaseEl.textContent = PHASES[0].text;
    return;
  }
  if (!('IntersectionObserver' in window)){
    wrap.classList.add('is-visible');
    play();
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting){ wrap.classList.add('is-visible'); play(); }
      else pause();
    });
  }, { threshold: .15 });
  io.observe(wrap);
})();

/* ================= WORD-BY-WORD REVEAL ================= */
const words = (function(){
  const el = document.getElementById('wordReveal');
  const parts = el.textContent.trim().split(/\s+/);
  el.textContent = '';
  const spans = parts.map((w,i) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w; el.appendChild(s); if (i < parts.length-1) el.appendChild(document.createTextNode(' ')); return s; });
  function set(p){ const n = Math.floor(p * (spans.length + 2)); spans.forEach((s,i) => s.classList.toggle('on', i < n)); }
  return { set };
})();

/* ================= STORY DIAGRAM (Fig 1–5) ================= */
const story = (function(){
  const NS = 'http://www.w3.org/2000/svg';
  const nodesG = document.getElementById('nodesG'), gridG = document.getElementById('gridG');
  const loopsG = document.getElementById('loopsG'), coreG = document.getElementById('coreG');
  const applications = document.getElementById('storyApplications');
  const context = document.getElementById('storyContext');
  const queue = document.getElementById('storyQueue');
  const personalization = document.getElementById('storyPersonalization');
  const automation = document.getElementById('storyAutomation');
  const stagesEl = [...document.querySelectorAll('.stage')];
  const figCap = document.getElementById('figCap');
  const CAPS = ['Fig. 1 — Applications sent in isolation','Fig. 2 — Adding resume & role memory','Fig. 3 — Coordinating the queue','Fig. 4 — Personalizing at scale','Fig. 5 — Outreach, automated'];
  const S = [
    [[170,120],[300,140],[430,110],[520,150],[140,210],[260,230],[380,210],[500,240],[200,300],[330,310],[450,300],[560,200]],
    [[234,293],[168,247],[168,152],[234,107],[406,293],[472,247],[472,152],[406,107],[320,105],[320,295],[150,200],[490,200]],
    [[234,293],[168,247],[168,152],[234,107],[406,293],[472,247],[472,152],[406,107],[155,200],[485,200],[320,105],[320,295]],
    [[170,130],[230,130],[290,130],[350,130],[410,130],[470,130],[170,270],[230,270],[290,270],[350,270],[410,270],[470,270]]
  ];
  const rects = S[0].map(([x,y]) => { const r = document.createElementNS(NS,'rect'); r.setAttribute('width',26); r.setAttribute('height',26); r.setAttribute('rx',2); r.style.transform = `translate(${x-13}px,${y-13}px)`; nodesG.appendChild(r); return r; });
  for (let ry=0; ry<3; ry++) for (let rx=0; rx<7; rx++){
    const c = document.createElementNS(NS,'circle');
    c.setAttribute('cx', 320 + (rx-3)*46); c.setAttribute('cy', 200 + (ry-1)*46); c.setAttribute('r', 21);
    const mid = (rx===3&&ry===1);
    if (mid || (Math.abs(rx-3)+Math.abs(ry-1))===1) c.setAttribute('stroke','#2c2c2c');
    gridG.appendChild(c);
  }
  const icon = document.createElementNS(NS,'g'); icon.setAttribute('stroke','#2c2c2c'); icon.setAttribute('fill','none');
  icon.innerHTML = '<circle cx="320" cy="195" r="4"/><path d="M312 208a8 8 0 0 1 16 0"/>';
  gridG.appendChild(icon);

  /* setStage just sets the target values for whichever stage we're on;
     the actual motion between stages is handled entirely by the CSS
     transitions on #nodesG rect / #loopsG / #coreG / #gridG (see
     style.css) — no JS-computed interpolation. Simpler and it's the
     SVG/CSS doing the animating, not scroll math. */
  let cur = -1;
  function setStage(s){
    s = Math.round(s);
    if (s === cur) return; cur = s;
    const pos = S[Math.min(s, 3)];
    if (s > 0){
      rects.forEach((r, i) => { r.style.transform = `translate(${pos[i][0] - 13}px,${pos[i][1] - 13}px)`; });
    }
    applications.classList.toggle('is-active', s === 0);
    context.classList.toggle('is-active', s === 1);
    queue.classList.toggle('is-active', s === 2);
    personalization.classList.toggle('is-active', s === 3);
    automation.classList.toggle('is-active', s === 4);
    nodesG.style.opacity = s === 0 || s === 1 || s === 2 || s === 3 || s === 4 ? 0 : 1;
    gridG.style.opacity  = 0;
    loopsG.style.opacity = [0,1,0,0,0][s];
    coreG.style.opacity  = [0,1,0,0,0][s];
    stagesEl.forEach(el => el.classList.toggle('on', +el.dataset.stage === s));
    figCap.textContent = CAPS[s];
  }
  return { setStage };
})();

/* ================= SCROLL ENGINE (single rAF) ================= */
(function engine(){
  const heroPar = document.getElementById('heroParallax');
  const visionSec = document.getElementById('vision');
  const storyTall = document.getElementById('storyTall');
  const showcase = document.getElementById('showcase');
  const toast = document.getElementById('toast');
  const typeLine = document.getElementById('typeLine');
  let queued = false, showcaseOn = false;

  function startTyping(){
    const full = typeLine.dataset.text;
    if (REDUCED){ typeLine.textContent = full; return; }
    let i = 0; const t = setInterval(() => { typeLine.textContent = full.slice(0, ++i); if (i >= full.length) clearInterval(t); }, 26);
  }

  function tick(){
    queued = false;
    const vh = innerHeight, y = scrollY;

    /* --- READ PHASE: gather every layout measurement up front so the
       browser never has to interrupt a write with a forced synchronous
       reflow. Mixing reads/writes here was the main cause of scroll
       jank, especially on mobile. --- */
    const vr = visionSec.getBoundingClientRect();
    const sr = storyTall.getBoundingClientRect();
    const cr = showcase.getBoundingClientRect();

    const visionActive = vr.top < vh && vr.bottom > 0;
    const visionP = visionActive ? clamp01((vh*.85 - vr.top) / (vh*.75)) : null;

    const storyActive = sr.top < vh && sr.bottom > 0;
    const storyP = storyActive ? clamp01(-sr.top / (sr.height - vh)) : null;

    const showcaseHit = cr.top < vh*.7 && !showcaseOn;

    /* --- WRITE PHASE: apply everything computed above. --- */
    if (!REDUCED && y < vh) heroPar.style.transform = `translate3d(0,${y*.14}px,0)`;

    if (visionActive){
      words.set(REDUCED ? 1 : smooth(clamp01((visionP-.1)/.9)));
    }
    if (storyActive){
      story.setStage(REDUCED ? 2 : Math.min(4, storyP*5));
    }
    if (showcaseHit){ showcaseOn = true; toast.classList.add('show'); startTyping(); }
  }
    /* Pause the purely-decorative continuous CSS animations (ambient
      orbs) while the user is actively scrolling, and
     resume ~150ms after they stop. These animations don't need to run
     every single frame, and freeing up the GPU/main thread during the
     scroll gesture itself is what actually removes the stutter on
     mobile — the animations are still just as visible, just not
     fighting the scroll for resources. */
  let scrollIdleTimer = null;
  function markScrolling(){
    document.body.classList.add('is-scrolling');
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => document.body.classList.remove('is-scrolling'), 150);
  }

  function onScroll(){
    if (!REDUCED) markScrolling();
    if (!queued){ queued = true; requestAnimationFrame(tick); }
  }
  addEventListener('scroll', onScroll, { passive:true });
  addEventListener('resize', onScroll);
  tick();
})();

/* ================= SCROLL REVEAL ([data-reveal] elements) =================
   Additive-only entrance animation for sections that previously had no
   scroll-triggered motion (story intro, showcase copy, workspace panel,
   footer). Does not touch the existing scroll engine, story diagram, word
   reveal, or workflow video logic above — it only watches elements carrying
   a data-reveal attribute and toggles a class once each scrolls into view. */
(function scrollReveal(){
  const els = [...document.querySelectorAll('[data-reveal]')];
  if (!els.length) return;
  if (REDUCED || !('IntersectionObserver' in window)){
    els.forEach((el) => el.classList.add('in-view'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in-view');
      io.unobserve(entry.target);
    });
  }, { threshold: .15, rootMargin: '0px 0px -8% 0px' });
  els.forEach((el) => io.observe(el));
})();

/* ================= FOOTER ENTRANCE (cinematic closing sequence) =================
   Runs independently of the generic [data-reveal] observer above. Two classes
   drive everything in the footer's own CSS:
     - "footer-in-view"  toggles on/off as the footer enters/leaves the
       viewport; only used to pause/resume the idle signal + status pulses
       so nothing animates off-screen.
     - "footer-settled"  is added once, the first time the footer is
       meaningfully visible (~20% in view), and never removed — it fires
       the one-time line/signal/nav-column/status/closing-bar entrance.
   A single observer covers both, so scrolling the footer in and out
   repeatedly never replays the entrance, only pauses/resumes the idle
   pulses. */
(function footerEntrance(){
  const footer = document.getElementById('siteFooter');
  if (!footer) return;
  if (REDUCED || !('IntersectionObserver' in window)){
    footer.classList.add('footer-in-view', 'footer-settled');
    return;
  }
  let settled = false;
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      footer.classList.toggle('footer-in-view', entry.isIntersecting);
      if (!settled && entry.isIntersecting && entry.intersectionRatio >= .2){
        settled = true;
        footer.classList.add('footer-settled');
      }
    });
  }, { threshold: [0, .2, .3] });
  io.observe(footer);
})();

/* ================= APPLICATION LOGIC =================
   This same frontend is served by both backends (see README "Warning:
   frontend/backend compatibility"), and the two speak different protocols
   for the same POST /api/send-outreach — so the response is inspected at
   runtime and handled accordingly:
     - Path B (api/send-outreach.js, Vercel): drafts AND sends inside one
       request, streaming newline-delimited JSON progress
       (Content-Type: application/x-ndjson) as each phase happens. No
       server-side job store, so "retry" just means resubmitting the same
       post text — there's no job id to retry against. Pacing (the 45s
       cooldown) is enforced server-side now (see api/send-outreach.js) —
       a request that arrives too soon gets back a 429 with `retryAfterMs`
       before any draft is generated. What's still here client-side is (a)
       a local pre-check so this tab doesn't fire off a request it already
       knows will bounce, and (b) automatic handling of that 429 — wait the
       exact time the server says, then retry the same request — so a
       reload, a second tab, or the cooldown simply changing between
       requests never surfaces as a user-visible error.
     - Path A (server.js): returns a single 202 JSON `{ jobId, status,
       position, etaSeconds, ... }` response the instant the job is queued,
       then the frontend polls GET /api/status/:jobId for progress. The
       server's own queue/batch pacing already spaces sends out, so there's
       no client-side cooldown for this path — the button re-enables right
       away and multiple posts can be queued back to back. Failed jobs are
       retried via POST /api/jobs/:jobId/retry (server-side, preserves the
       job id and retryCount) rather than resubmitting as a new job.
   The ledger list itself is still purely a client-side history of this
   tab's submissions for both paths — it's rebuilt from responses/polls,
   not fetched from a server-side list, so it resets on page reload. */
const form = document.getElementById('outreach-form');
const btn = document.getElementById('submitBtn');
const statusEl = document.getElementById('status');
const jobsEl = document.getElementById('jobs');
const jobsEmptyEl = document.getElementById('jobsEmpty');
const postTextEl = document.getElementById('postText');
const recipientEmailEl = document.getElementById('recipientEmail');
const emailHintEl = document.getElementById('recipientEmailHint');
const history = []; // most recent first; each entry: { id, status, recipientEmail, concept, subject, error, postText, pathA }

/* ================= AUTO-DETECT RECIPIENT EMAIL FROM PASTED POST ================= */
// As soon as the pasted post text contains a recognizable email (including
// common de-obfuscated forms like "hr [at] acme [dot] com"), the recipient
// field is filled in automatically. It only ever overwrites a field the user
// hasn't manually edited themselves — once they type or edit the recipient
// field directly, auto-detection backs off and leaves their input alone.
let recipientEditedByUser = false;
let lastAutoFilledEmail = '';

function setEmailHint(text, tone){
  if (!emailHintEl) return;
  emailHintEl.textContent = text || '';
  emailHintEl.className = 'field-hint' + (tone ? ` field-hint--${tone}` : '');
}

function runEmailAutoDetect(){
  if (!postTextEl || !recipientEmailEl) return;
  const detected = extractEmailFromText(postTextEl.value);
  if (recipientEditedByUser) {
    // User has taken over the field manually — never clobber their input,
    // just stop showing a stale "auto-detected" hint if it no longer matches.
    if (emailHintEl && recipientEmailEl.value.trim() !== lastAutoFilledEmail) setEmailHint('');
    return;
  }
  if (detected) {
    recipientEmailEl.value = detected;
    lastAutoFilledEmail = detected;
    setEmailHint(`Auto-detected from the pasted post: ${detected}`, 'success');
  } else if (!recipientEmailEl.value.trim()) {
    setEmailHint('No email found in the post yet — paste one or enter the recipient manually.', 'muted');
  }
}

if (postTextEl) {
  postTextEl.addEventListener('input', runEmailAutoDetect);
  postTextEl.addEventListener('paste', () => setTimeout(runEmailAutoDetect, 0));

  // Enter submits the form; Shift+Enter still inserts a newline so a
  // manually-typed multi-line description remains possible.
  postTextEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
}

/* ================= PASTE-FROM-CLIPBOARD BUTTON ================= */
const pasteBtnEl = document.getElementById('pasteBtn');
if (pasteBtnEl && postTextEl) {
  pasteBtnEl.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      postTextEl.value = text;
      postTextEl.dispatchEvent(new Event('input', { bubbles: true }));
      postTextEl.focus();
      const original = pasteBtnEl.innerHTML;
      pasteBtnEl.classList.add('paste-btn--done');
      pasteBtnEl.innerHTML = 'Pasted';
      setTimeout(() => { pasteBtnEl.classList.remove('paste-btn--done'); pasteBtnEl.innerHTML = original; }, 1200);
    } catch (_err) {
      setEmailHint('Clipboard access was blocked — paste manually with Ctrl/Cmd+V instead.', 'error');
    }
  });
}
if (recipientEmailEl) {
  recipientEmailEl.addEventListener('input', () => {
    recipientEditedByUser = recipientEmailEl.value.trim() !== lastAutoFilledEmail;
    if (recipientEditedByUser) setEmailHint('');
  });
}

function escapeHtml(str){ const div = document.createElement('div'); div.textContent = str == null ? '' : str; return div.innerHTML; }
function showStatus(kind, title, bodyHtml){ statusEl.className = `status show ${kind}`; statusEl.innerHTML = `<strong>${escapeHtml(title)}</strong>${bodyHtml}`; }

const FAILURE_STATUSES = new Set(['draft_failed', 'send_failed', 'send_unknown', 'rejected', 'error']);
const TERMINAL_STATUSES = new Set(['sent', 'draft_failed', 'send_failed', 'send_unknown', 'rejected', 'error']);
// Every phase either backend can report, in the order it happens, plus what
// to show while it's in progress. 'drafted' only ever comes from path B's
// stream; 'processing' and 'waiting' only ever come from path A's job
// status (queued -> processing -> drafting -> waiting -> sending -> sent).
// This is what makes "queuing / drafting / sending" visible in real time
// instead of one opaque spinner.
const PHASE_LABELS = {
  queued: 'Queued',
  processing: 'Claimed by worker…',
  drafting: 'Drafting…',
  drafted: 'Draft ready',
  waiting: 'Waiting for send slot…',
  sending: 'Sending…',
  sent: 'Sent',
  draft_failed: 'Draft failed',
  rejected: 'Rejected by safety check',
  send_failed: 'Send failed',
  send_unknown: 'Send status unknown',
  error: 'Error'
};
const POST_SEND_COOLDOWN_MS = 45_000;
let cooldownTimer = null;

function formatEta(seconds){
  if (seconds == null) return '';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function renderHistory(){
  jobsEl.innerHTML = history.map((entry) => {
    const statusText = PHASE_LABELS[entry.status] || entry.status.replace('_', ' ').toUpperCase();
    const concept = entry.concept ? `<div class="job-meta-row"><span class="job-meta-label">Concept</span> ${escapeHtml(entry.concept)}</div>` : '';
    const subject = entry.subject ? `<div class="job-meta-row"><span class="job-meta-label">Subject</span> ${escapeHtml(entry.subject)}</div>` : '';
    const error = entry.error ? `<div class="job-error">Error: ${escapeHtml(entry.error)}</div>` : '';
    // Position/ETA only ever comes from path A (server.js) polling — path B
    // has no queue to report a position or ETA for.
    const eta = (entry.pathA && !TERMINAL_STATUSES.has(entry.status) && entry.etaSeconds != null)
      ? `<div class="job-meta-row"><span class="job-meta-label">ETA</span> ~${formatEta(entry.etaSeconds)}${entry.position ? ` · position ${entry.position}` : ''}</div>`
      : '';
    const canRetry = FAILURE_STATUSES.has(entry.status);
    const retryBtn = canRetry ? `<div class="job-actions"><button type="button" class="button button-secondary retry-btn" data-retry-id="${escapeHtml(entry.id)}">Retry</button></div>` : '';
    return `
      <article class="ledger-row">
        <div class="ledger-row-top">
          <div class="ledger-status">
            <span class="status-dot job-${escapeHtml(entry.status)}">●</span>
            <span class="ledger-status-text">${escapeHtml(statusText)}</span>
          </div>
          <span class="job-id">${escapeHtml(entry.id.slice(0, 8))}</span>
        </div>
        <div class="ledger-row-main">
          <div class="job-recipient">${escapeHtml(entry.recipientEmail || 'unknown')}</div>
          ${concept}${subject}${eta}${error}
        </div>
        ${retryBtn}
      </article>`;
  }).join('');
  jobsEmptyEl.style.display = history.length ? 'none' : 'block';
}

// Reads the NDJSON stream from /api/send-outreach one line at a time,
// calling onEvent(event) as each phase arrives. Buffers partial lines
// across chunk boundaries since a phase's JSON can be split across reads.
async function streamOutreach(res, onEvent){
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0){
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  const rest = buffer.trim();
  if (rest) onEvent(JSON.parse(rest));
}

/* ================= CLIENT-SIDE SUBMISSION QUEUE =================
   Submitting used to disable the button until that one job finished (plus,
   on path B, a 45s cooldown on top) — so you couldn't paste a second post
   until the first was completely done. Now every submission is pushed onto
   `submitQueue` and the button re-enables immediately; `runQueue()` drains
   the queue one job at a time in the background.
     - Path B (no server-side job store, but the cooldown itself IS
       server-enforced — see api/send-outreach.js): the local wait below,
       measured from the timestamp of the last actual send
       (`lastPathBSendAt`), is only a best-effort optimization so this tab
       doesn't fire a request off it can predict will bounce. It can be
       wrong — another tab may have sent more recently than this tab knows
       about, or the two can drift — which is fine, because `runSubmission`
       treats a 429 from the server as the actual source of truth and
       retries automatically using the `retryAfterMs` the server returns.
     - Path A (server.js): its own queue/batch worker already paces sends,
       so no client-side wait is added here — jobs are handed off back to
       back and `pollJobStatus` (unchanged, below) tracks each one's real
       progress. */
const submitQueue = [];
let queueRunning = false;

// Appends "(N queued)" to a status label whenever there's something behind
// the currently-running job — used everywhere the button text gets set so
// the queue depth is always visible, not just when idle.
function queuedSuffix(label){
  return submitQueue.length > 0 ? `${label} (${submitQueue.length} queued)` : label;
}

function updateQueueLabel(){
  if (queueRunning) return; // runSubmission/waitSeconds own btn.textContent while a job is active
  btn.textContent = submitQueue.length > 0
    ? `Queued: ${submitQueue.length} post${submitQueue.length !== 1 ? 's' : ''} pending`
    : 'Generate & Send Outreach';
}

// The button is never disabled here — only the countdown text changes.
// Disabling it during the path B cooldown would defeat the entire point of
// the queue: you should be able to keep adding posts during that wait too.
function waitSeconds(seconds){
  return new Promise((resolve) => {
    clearInterval(cooldownTimer);
    let remaining = seconds;
    const tick = () => {
      if (remaining <= 0){
        clearInterval(cooldownTimer);
        cooldownTimer = null;
        resolve();
        return;
      }
      btn.textContent = `Next send in ${remaining}s… (${submitQueue.length} queued)`;
      remaining -= 1;
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
  });
}

let lastPathBSendAt = 0; // ms timestamp of the last successful path B send; 0 until the first one

async function runQueue(){
  if (queueRunning) return;
  queueRunning = true;
  while (submitQueue.length > 0){
    const job = submitQueue.shift();

    // Enforce the 45s gap from the last *actual send*, not from whether
    // another job happened to already be sitting in the queue. This is
    // what makes the cooldown apply even when posts are submitted one at a
    // time, each only after the previous one finished — the bug in the
    // earlier version only paced jobs that were rapid-fired together.
    if (lastPathBSendAt > 0){
      const remainingMs = POST_SEND_COOLDOWN_MS - (Date.now() - lastPathBSendAt);
      if (remainingMs > 0) await waitSeconds(Math.ceil(remainingMs / 1000));
    }

    const entry = await runSubmission(job.postText, job.recipientEmail, { retryOf: job.retryOf });
    if (entry && !entry.pathA && entry.status === 'sent'){
      lastPathBSendAt = Date.now();
    }
  }
  queueRunning = false;
  updateQueueLabel();
}

// Path A (server.js) polling: one interval per in-flight job id, keyed so a
// retry or an accidental double-submit never spins up a second poller for
// the same job.
const activePolls = new Map(); // jobId -> interval id

function stopPolling(jobId){
  const t = activePolls.get(jobId);
  if (t){ clearInterval(t); activePolls.delete(jobId); }
}

function applyJobUpdate(id, job){
  const i = history.findIndex((h) => h.id === id);
  if (i === -1) return;
  history[i] = { ...history[i], status: job.status, error: job.error, position: job.position, etaSeconds: job.etaSeconds, concept: job.concept, subject: job.subject };
  renderHistory();
}

function pollJobStatus(jobId){
  stopPolling(jobId);
  const tick = async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      if (!res.ok){ stopPolling(jobId); return; } // job unknown/pruned — nothing left to track
      const job = await res.json();
      applyJobUpdate(jobId, job);
      if (TERMINAL_STATUSES.has(job.status)) stopPolling(jobId);
    } catch (_err) {
      // Transient network error — leave the interval running, the next
      // tick will just retry.
    }
  };
  tick(); // show the first update immediately rather than waiting a full interval
  activePolls.set(jobId, setInterval(tick, 3000));
}

// Does the actual fetch/stream/poll work for exactly one job. Called only
// from runQueue(), one job at a time — this is otherwise the same logic
// submitOutreach used to run inline before the queue existed.
async function runSubmission(postText, recipientEmail, { retryOf } = {}){
  // Deliberately NOT disabling btn here — that was the whole point of the
  // queue. The button stays clickable for the entire time this job is
  // drafting/sending so more posts can be added on top of it.
  btn.textContent = queuedSuffix('Processing…');
  statusEl.className = 'status'; statusEl.innerHTML = '';
  let entry = { id: crypto.randomUUID(), status: 'queued', recipientEmail, postText };

  try {
    let res = await fetch('/api/send-outreach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postText, recipientEmail }) });

    // Server-enforced cooldown (Path B only): a request that arrives before
    // the gap has elapsed comes back 429 with `retryAfterMs` instead of
    // starting a draft. Wait exactly that long, then silently resend the
    // same request — this loop is what makes the earlier local pre-check
    // just an optimization rather than the source of truth. A 429 that
    // somehow never resolves (clock skew, misconfigured cooldown) isn't
    // looped forever: cap the number of automatic retries.
    for (let attempt = 0; res.status === 429 && attempt < 5; attempt++){
      const data = await res.json().catch(() => ({}));
      const retryAfterMs = Number(data.retryAfterMs)
        || (Number(res.headers.get('Retry-After')) * 1000)
        || POST_SEND_COOLDOWN_MS;
      showStatus('queued', 'Waiting for send slot…', escapeHtml(data.error || 'Pacing sends to stay safe.'));
      await waitSeconds(Math.ceil(retryAfterMs / 1000));
      res = await fetch('/api/send-outreach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postText, recipientEmail }) });
    }

    if (!res.ok){
      // Shared validation errors (bad email, empty post), or a 429 that
      // never cleared after the retry cap above, land here on both paths —
      // path B always responds 200 once streaming starts, and path A's 202
      // is also `ok`, so this only ever fires for real 4xx/5xx.
      const data = await res.json().catch(() => ({}));
      entry = { ...entry, status: 'error', error: data.error || 'Something went wrong.' };
      showStatus('error', 'Not sent', escapeHtml(entry.error));
    } else if ((res.headers.get('content-type') || '').includes('application/x-ndjson')) {
      // Path B: stream drafting/sending progress from this one request.
      await streamOutreach(res, (event) => {
        entry = { ...entry, ...event, id: event.jobId || entry.id, status: event.phase, pathA: false };
        const label = PHASE_LABELS[event.phase] || event.phase;
        if (FAILURE_STATUSES.has(event.phase)){
          showStatus('error', label, escapeHtml(event.error || 'Something went wrong.'));
        } else if (event.phase === 'sent'){
          const detectedNote = event.emailAutoDetected ? ` Sent to auto-detected address ${escapeHtml(event.recipientEmail || '')}.` : '';
          showStatus('success', 'Sent', `${escapeHtml(event.subject || '')}${detectedNote}`);
        } else {
          showStatus('queued', label, escapeHtml(event.message || ''));
        }
        btn.textContent = queuedSuffix(label);
      });
    } else {
      // Path A: the job is only just queued, not sent — the server's own
      // queue/batch pacing takes it from here, so poll for real progress
      // instead of treating this response as the outcome.
      const data = await res.json();
      entry = { ...entry, ...data, id: data.jobId || entry.id, status: data.status || 'queued', pathA: true };
      const detectedNote = data.emailAutoDetected ? ` Auto-detected recipient: ${escapeHtml(data.recipientEmail || '')}.` : '';
      showStatus('queued', PHASE_LABELS[entry.status] || entry.status, `Position ${data.position ?? '?'} · ETA ~${escapeHtml(formatEta(data.etaSeconds))}.${detectedNote}`);
      btn.textContent = queuedSuffix(PHASE_LABELS[entry.status] || entry.status);
    }
  } catch (_err){
    entry = { ...entry, status: 'error', error: 'Could not reach the server.' };
    showStatus('error', 'Not sent', 'Could not reach the server. Is it running?');
  }

  if (retryOf){
    const i = history.findIndex((h) => h.id === retryOf);
    if (i >= 0) history[i] = entry; else history.unshift(entry);
  } else {
    history.unshift(entry);
  }
  renderHistory();

  if (entry.pathA && entry.id && !TERMINAL_STATUSES.has(entry.status)) pollJobStatus(entry.id);

  return entry;
}

// Public entry point (called by the form handler and by retries): enqueues
// the job and makes sure the queue is running. Never blocks — the button
// stays clickable and the form clears immediately (the just-typed values are
// already captured in the queued job) so the next post can be pasted in
// right away, instead of waiting for this one to actually send.
async function submitOutreach(postText, recipientEmail, { retryOf } = {}){
  submitQueue.push({ postText, recipientEmail, retryOf });
  if (!retryOf){
    form.reset(); recipientEditedByUser = false; lastAutoFilledEmail = ''; setEmailHint('');
  }
  updateQueueLabel();
  runQueue();
}

async function retryJob(entry){
  if (!entry.pathA){
    // Path B has no server-side job to retry against — resubmitting the
    // same inputs as a fresh request is the only option (see file-top
    // comment).
    submitOutreach(entry.postText, entry.recipientEmail, { retryOf: entry.id });
    return;
  }
  try {
    const res = await fetch(`/api/jobs/${entry.id}/retry`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok){
      showStatus('error', 'Retry failed', escapeHtml(data.error || 'Something went wrong.'));
      return;
    }
    const i = history.findIndex((h) => h.id === entry.id);
    if (i >= 0) history[i] = { ...history[i], status: data.status || 'queued', position: data.position, etaSeconds: data.etaSeconds, error: null };
    renderHistory();
    pollJobStatus(entry.id);
  } catch (_err) {
    showStatus('error', 'Retry failed', 'Could not reach the server.');
  }
}

jobsEl.addEventListener('click', (e) => {
  const retryButton = e.target.closest('[data-retry-id]');
  if (!retryButton) return;
  const id = retryButton.getAttribute('data-retry-id');
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  retryJob(entry);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const postText = document.getElementById('postText').value.trim();
  const recipientEmail = document.getElementById('recipientEmail').value.trim();
  submitOutreach(postText, recipientEmail);
});
renderHistory();
