import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { BUILD_ID, BUILD_LOADED_AT, IMAGE_CACHE_DIR } from "./src/config.mjs";
import {
    applyReaction, createProfile, deleteProfile, detectHumorStyles, getActiveName,
    importProfile, listProfiles, loadProfile, persistActive, prMemeInstructions,
    profileContext, saveActiveProfile, suggestPrMeme, switchProfile,
} from "./src/profiles.mjs";
import {
    addMeme, addMemeFromUrl, analyzeMeme, analyzePendingMemes, deleteMeme, findMemes, keepMeme,
    loadMemeIndex, recoverAnalysisState, replaceMeme, saveMemeIndex, syncAnalysisResults,
} from "./src/memes.mjs";

const servers = new Map();
const previewServers = new Map();
let pendingPrMeme = null;
let lastAssistantTurn = { id: "", completedAt: 0, styles: [] };

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderHtml(profile, profiles, activeName, memeIndex) {
    const levels = ["off", "subtle", "playful", "absurd + sharp", "dark / edgy"];
    const options = profiles.map((name) =>
        `<option value="${escapeHtml(name)}" ${name === activeName ? "selected" : ""}>${escapeHtml(name)}</option>`
    ).join("");
    const memeCards = memeIndex.images.map((image) => `
      <button class="meme-card ${image.analysisStatus === "analyzing" ? "analyzing" : ""}"
        data-status="${escapeHtml(image.analysisStatus)}"
        data-meme-id="${escapeHtml(image.id)}" data-meme='${escapeHtml(JSON.stringify(image))}'>
        <span class="status-dot status-${escapeHtml(image.analysisStatus)}"
          title="${escapeHtml(image.duplicateOf ? "Duplicate decision" : image.analysisStatus)}"
          aria-label="${escapeHtml(image.duplicateOf ? "Duplicate decision" : image.analysisStatus)}"></span>
        <img src="/api/meme/image?id=${encodeURIComponent(image.id)}" alt="${escapeHtml(image.template || image.file)}">
        <span class="meme-name">${escapeHtml(image.template || "Awaiting analysis")}</span>
      </button>
    `).join("");
    return `<!doctype html>
<html data-color-mode="auto">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0f172a">
  <title>Lolpilot Reactions</title>
  <style>
    :root { --status-bar-color: var(--background-color-default, #0f172a); }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; padding: 18px;
      color: var(--text-color-default, #f8fafc);
      background: var(--background-color-default, #0f172a);
      font: 14px/1.4 var(--font-sans, "Segoe UI", sans-serif);
    }
    body[data-color-mode="light"], html[data-light-theme] body {
      --lp-card: #ffffff; --lp-control: #eef1f6; --lp-border: #d0d7de; --lp-muted: #57606a;
      color-scheme: light;
    }
    body[data-color-mode="dark"], html[data-dark-theme] body, :root:not([data-light-theme]) body {
      --lp-card: #161b22; --lp-control: #21262d; --lp-border: #30363d; --lp-muted: #9da7b3;
      color-scheme: dark;
    }
    main { max-width: 560px; margin: 0 auto; }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .logo { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 8px;
      background: linear-gradient(135deg, #f97316, #ec4899); color: white; font-size: 22px; }
    h1 { margin: 0; font-size: 24px; }
    .tagline { margin: 1px 0 0; color: var(--lp-muted); }
    .card { margin: 12px 0; padding: 15px; border: 1px solid var(--lp-border); border-radius: 6px;
      background: var(--lp-card); box-shadow: 0 5px 18px #00000014; }
    .react-card { position: relative; }
    .answer-dot { position: absolute; top: 12px; right: 12px; width: 11px; height: 11px;
      border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 4px #ef444425; opacity: 0;
      pointer-events: none; }
    .answer-dot.live { opacity: 1; animation: answerSignal 5s linear forwards; }
    @keyframes answerSignal { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
    .answer-status { min-height: 14px; margin-top: 5px; color: var(--lp-muted); font-size: 11px; text-align: right; }
    .eyebrow { color: #8b5cf6; font-size: 11px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
    .level { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 8px; }
    .level-name { width: 142px; min-width: 142px; font-size: 21px; font-weight: 750; text-transform: capitalize; }
    .level-value { width: 36px; min-width: 36px; text-align: right; }
    .meter { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
    .bar { height: 10px; border: 1px solid var(--lp-border); border-radius: 3px; background: var(--lp-control); }
    .bar.on { border-color: transparent; background: linear-gradient(90deg, #f97316, #ec4899); }
    .bar.dark-on { border-color: #000; background: #000; box-shadow: 0 0 0 1px #6b7280 inset; }
    .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 13px; }
    button, select, input { min-height: 42px; border: 1px solid var(--lp-border); border-radius: 5px;
      color: inherit; background: var(--lp-control); font: inherit; }
    button { padding: 11px 12px; font-weight: 700; cursor: pointer; box-shadow: 0 1px 0 #00000018; }
    button:hover { filter: brightness(1.08); }
    button:active { transform: translateY(1px); }
    button.good { color: #fff; border-color: #2563eb; background: #2563eb; }
    button.bad { color: #fff; border-color: #be123c; background: #be123c; }
    button.hot { color: #fff; border-color: #c2410c; background: #c2410c; }
    button.cool { color: #fff; border-color: #0369a1; background: #0369a1; }
    button.neutral { color: #fff; border-color: #5b21b6; background: #5b21b6; }
    button.selected { outline: 3px solid #f59e0b; outline-offset: 1px; }
    .censor-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 13px;
      padding: 10px 12px; border: 2px solid ${profile.censorSafe ? "#16a34a" : "#dc2626"};
      border-radius: 6px; background: ${profile.censorSafe ? "#16a34a18" : "#dc26261a"}; }
    .censor-copy strong { display: block; letter-spacing: .03em; }
    .censor-switch { position: relative; width: 58px; height: 30px; min-height: 30px; flex: 0 0 auto; padding: 0;
      overflow: hidden; border-radius: 999px;
      border: 2px solid ${profile.censorSafe ? "#16a34a" : "#dc2626"};
      background: ${profile.censorSafe ? "#16a34a" : "#dc2626"}; }
    .censor-switch::after { content: ""; position: absolute; top: 3px; left: ${profile.censorSafe ? "29px" : "3px"};
      width: 20px; height: 20px; border-radius: 50%; background: white; transition: left .15s ease; }
    .censor-status { font-weight: 800; color: ${profile.censorSafe ? "#16a34a" : "#dc2626"}; }
    .pr-memes { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:12px;
      padding:10px 12px; border:1px solid var(--lp-border); border-radius:6px; background:var(--lp-control); }
    .pr-memes input { width:20px; min-height:20px; accent-color:#7c3aed; }
    button.wide { grid-column: 1 / -1; }
    .profile-card { padding: 12px 14px; }
    .profile-label { display: block; margin-bottom: 5px; color: var(--lp-muted); font-size: 11px;
      font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .profile-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
    .profile-row button, .profile-row .export { padding: 8px 10px; }
    #new { min-width: 104px; }
    .profile-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
    .transfer-actions { display: grid; grid-template-columns: 104px 104px; gap: 8px; }
    select, input { width: 100%; padding: 8px 10px; }
    .stats { display: flex; flex-wrap: wrap; gap: 18px; color: var(--lp-muted); }
    .stats strong { color: inherit; }
    .status { min-height: 20px; margin-top: 10px; color: #8b5cf6; text-align: center; font-weight: 650; }
    .fine { color: var(--lp-muted); font-size: 12px; }
    .build-stamp { margin: 14px 0 0; padding-top: 8px; border-top: 1px solid var(--lp-border);
      color: var(--lp-muted); font: 11px/1.3 var(--font-mono, Consolas, monospace); text-align: center; }
    a.export, .import { display: inline-grid; grid-auto-flow: column; align-items: center; justify-content: center; gap: 6px;
      width: 100%; min-height: 42px; padding: 8px 12px; border: 1px solid var(--lp-border); border-radius: 5px;
      color: inherit; background: var(--lp-control); font-weight: 700; text-decoration: none; }
    .arrow { color: #000; font-size: 20px; font-weight: 900; line-height: 1; }
    body[data-color-mode="dark"] .arrow, html[data-dark-theme] .arrow, :root:not([data-light-theme]) .arrow {
      color: #000;
      filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff);
    }
    #importFile { display: none; }
    #delete { width: 104px; min-height: 42px; color: #fff; border-color: #be123c; background: #be123c; }
    .meme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); gap: 10px; margin-top: 12px; }
    .meme-status { min-height: 20px; margin-top: 9px; color: #dc2626; font-weight: 650; }
    .meme-card { position: relative; display: block; min-width: 0; padding: 0; overflow: hidden; text-align: left;
      border: 1px solid var(--lp-border); border-radius: 5px; background: var(--lp-control); }
    [hidden] { display: none !important; }
    .meme-card:hover { outline: 2px solid #8b5cf6; outline-offset: 1px; }
    .meme-card img { display: block; width: 100%; aspect-ratio: 1 / .72; object-fit: cover; background: #000; }
    .meme-name { display: block; overflow: hidden; padding: 8px 9px; text-overflow: ellipsis; white-space: nowrap; }
    .status-dot { position: absolute; z-index: 1; top: 7px; right: 7px; width: 13px; height: 13px;
      border: 2px solid white; border-radius: 50%; box-shadow: 0 1px 4px #0008; }
    .status-analyzed { background: #22c55e; }
    .status-needs-review { background: #eab308; }
    .status-analyzing { background: #3b82f6; animation: statusBlink 1.2s ease-in-out infinite; }
    .status-pending { background: #f97316; }
    .meme-card.analyzing { animation: analysisPulse 2.4s ease-in-out infinite; }
    @keyframes analysisPulse { 50% { border-color: #8b5cf6; box-shadow: 0 0 0 2px #8b5cf622; } }
    @keyframes statusBlink { 50% { opacity: .25; transform: scale(.75); } }
    @media (prefers-reduced-motion: reduce) {
      .meme-card.analyzing, .status-analyzing { animation: none; }
    }
    .meme-delete { min-height: 36px; padding: 7px 9px; color: #fff; border-color: #be123c; background: #be123c; }
    .meme-actions { position: relative; margin-top: 11px; }
    #addMeme { width: 100%; border-style: dashed; }
    #addMeme.dragging { outline: 3px solid #22c55e; outline-offset: 2px; filter: brightness(1.14); }
    .add-menu { display: none; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
    .add-menu.open { display: grid; }
    #memeFile { display: none; }
    .library-card { margin-top: 20px; }
    .library-page > .library-card { margin: 0 0 16px; }
    .library-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
    .library-summary button { min-width: 150px; }
    .library-page { display: none; }
    body.library-open main { max-width: none; }
    body.library-open > main > .brand, body.library-open > main > .profile-card { display: none; }
    body.library-open .control-page { display: none; }
    body.library-open .library-page { display: block; }
    body.library-open .library-page > .card { margin: 0 0 16px; }
    .library-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .library-header h2 { margin: 0; flex: 1; }
    .library-filters { display: grid; grid-template-columns: auto 170px minmax(140px, 1fr) auto 76px; align-items: center;
      gap: 8px; margin: 16px 0 10px; padding-top: 14px; border-top: 1px solid var(--lp-border); }
    .library-filters select { width: auto; min-width: 170px; }
    #sortMemes { min-width: 86px; padding: 7px 9px; font-size: 12px; }
    .filter-count { display: grid; place-items: center; min-width: 68px; line-height: 1.05; text-align: center; }
    .filter-count strong { font-size: 15px; }
    .filter-count span { color: var(--lp-muted); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
    .meme-detail { max-width: min(620px, calc(100vw - 28px)); }
    .meme-detail img { display: block; width: 100%; max-height: 55vh; object-fit: contain; border-radius: 5px; background: #000; }
    .meme-detail dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 7px 12px; }
    .meme-detail dt { color: var(--lp-muted); }
    .meme-detail dd { margin: 0; overflow-wrap: anywhere; }
    .identity-hint { display:grid; gap:8px; margin-top:12px; }
    .identity-hint textarea { min-height:64px; resize:vertical; border:1px solid var(--lp-border); border-radius:5px;
      padding:9px 10px; background:var(--lp-control); color:inherit; font:14px var(--font-sans,Segoe UI,sans-serif); }
    .identity-hint button { min-height:38px; border:1px solid var(--lp-border); border-radius:5px;
      background:var(--lp-control); color:inherit; font-weight:700; }
    dialog { width: min(420px, calc(100vw - 32px)); border: 1px solid var(--lp-border); border-radius: 7px;
      color: inherit; background: var(--lp-card); box-shadow: 0 18px 60px #0008; }
    dialog::backdrop { background: #0009; backdrop-filter: blur(2px); }
    dialog h2 { margin: 0 0 8px; font-size: 18px; }
    dialog p { color: var(--lp-muted); }
    .dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    .meme-detail .dialog-actions { justify-content: space-between; }
    .meme-detail .dialog-actions #deleteMeme { margin-right: auto; order: -1; }
    .dialog-actions button { min-width: 90px; }
    button:disabled { cursor: not-allowed; opacity: .55; }
    @media (max-width: 340px) {
      body { padding: 10px; }
      main { width: 100%; min-width: 0; }
      .card { padding: 11px; }
      .profile-row { grid-template-columns: minmax(0, 1fr); }
      #new, #delete { width: 100%; min-width: 0; }
      .profile-actions { align-items: stretch; flex-direction: column; }
      .transfer-actions { width: 100%; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .buttons { grid-template-columns: minmax(0, 1fr); }
      .buttons button { width: 100%; min-width: 0; white-space: normal; }
      button, select, input, a.export, .import { min-width: 0; }
      .level { align-items: flex-start; flex-direction: column; gap: 8px; }
      .level-name { width: 100%; min-width: 0; }
      .level-value { width: auto; min-width: 0; }
      .meter { width: 100%; }
      .add-menu { grid-template-columns: 1fr; }
      .meme-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .library-filters { grid-template-columns: 1fr; }
      .library-filters select { width: 100%; }
    }
    @media (min-width: 341px) and (max-width: 620px) {
      .library-filters { grid-template-columns: auto minmax(0, 1fr) auto 72px; }
      .library-filters label { grid-column: 1; }
      .library-filters select { grid-column: 2 / 5; min-width: 0; width: 100%; }
      .library-filters input { grid-column: 1 / 3; min-width: 0; }
      #sortMemes { grid-column: 3; }
      .library-filters .filter-count { grid-column: 4; }
    }
  </style>
</head>
<body>
<main>
  <div class="brand">
    <div class="logo">😂</div>
    <div><h1>Lolpilot</h1><p class="tagline">Tune the vibe. Don't break the facts.</p></div>
  </div>

  <section class="card profile-card">
    <label class="profile-label" for="profile">Selected profile</label>
    <div class="profile-row">
      <select id="profile">${options}</select>
      <button id="new" class="neutral" title="Create new profile">＋ New</button>
    </div>
    <div class="profile-actions">
      <div class="transfer-actions">
        <a class="export" href="/api/export" title="Export active profile"><span class="arrow">⬆</span> Export</a>
        <button id="import" class="import" title="Import profile JSON"><span class="arrow">⬇</span> Import</button>
        <input id="importFile" type="file" accept=".json,application/json">
      </div>
      <button id="delete" title="Delete selected profile">❌ Delete</button>
    </div>
  </section>

  <div class="control-page">
  <section class="card">
    <div class="eyebrow">Humor engine</div>
    <div class="level">
      <div class="level-name">${escapeHtml(levels[profile.level])}</div>
      <div class="meter">${levels.slice(1).map((_, index) =>
        `<div class="bar ${index < profile.level ? (profile.level === 4 ? "dark-on" : "on") : ""}"></div>`
      ).join("")}</div>
      <strong class="level-value">${profile.level}/4</strong>
    </div>
    <div class="buttons">
      <button class="cool" data-reaction="humor-" ${profile.level === 0 ? "disabled" : ""}>🧊 Dial it down</button>
      <button class="hot" data-reaction="humor+" ${profile.level === 4 ? "disabled" : ""}>🔥 More chaos</button>
      <button class="neutral wide" data-reaction="humor-stop">🧑‍💼 Full serious mode</button>
    </div>
    <div class="censor-toggle">
      <div class="censor-copy">
        <strong class="censor-status">${profile.censorSafe ? "CENSOR-SAFE" : "NON-CENSOR-SAFE"}</strong>
      </div>
      <button class="censor-switch" data-reaction="${profile.censorSafe ? "censor-off" : "censor-safe"}"
        role="switch" aria-checked="${profile.censorSafe}" aria-label="Censor-safe"></button>
    </div>
    <label class="pr-memes">
      <span><strong>Suggest memes in PRs</strong></span>
      <input id="prMemes" type="checkbox" ${profile.suggestPrMemes ? "checked" : ""}>
    </label>
  </section>
  <section class="card react-card">
    <div class="eyebrow">React to the last answer</div>
    <span class="answer-dot" id="answerDot" title="A new assistant answer completed"></span>
    <div class="answer-status" id="answerStatus"></div>
    <div class="buttons">
      <button class="good" data-reaction="trafione">😂 Hit</button>
      <button class="bad" data-reaction="meh">😐 Meh</button>
    </div>
  </section>
  <section class="card">
    <div class="eyebrow">Images & memes</div>
    <div class="buttons">
      <button class="${profile.images === "often" ? "selected" : ""}" data-reaction="images-on">🖼️ Often</button>
      <button class="${profile.images === "rare" ? "selected" : ""}" data-reaction="images-rare">✨ Rare</button>
      <button class="wide ${profile.images === "never" ? "selected" : ""}" data-reaction="images-off">🚫 No images</button>
    </div>
  </section>
  <section class="card library-card">
    <div class="eyebrow">Meme library</div>
    <div class="library-summary">
      <span><strong>${memeIndex.images.length}</strong> templates · ${memeIndex.images.filter((image) => image.analysisStatus === "analyzed").length} analyzed</span>
      <button id="openLibrary" class="neutral">Open library</button>
    </div>
  </section>
  <section class="card stats">
    <span><strong>${profile.hits}</strong> hits</span>
    <span><strong>${profile.misses}</strong> misses</span>
    <span>Last action: <strong>${escapeHtml({
      "censor-safe": "enabled censor-safe mode",
      "censor-off": "disabled censor-safe mode",
      "humor+": "raised humor level",
      "humor-": "lowered humor level",
      "humor-stop": "enabled serious mode",
      "images-on": "set images to often",
      "images-rare": "set images to rare",
      "images-off": "disabled images",
      trafione: "rated as hit",
      meh: "rated as miss",
    }[profile.lastReaction] || profile.lastReaction)}</strong></span>
  </section>
  <div class="status" id="status"></div>
  <p class="fine">Profile data: C:\\Dev\\lolpilot · Image cache: C:\\Dev\\lolpilot\\cache\\images</p>
  <p class="build-stamp">Lolpilot ${escapeHtml(BUILD_ID)} · loaded ${escapeHtml(BUILD_LOADED_AT)}</p>
  </div>

  <div class="library-page">
    <div class="library-header">
      <button id="closeLibrary">← Back</button>
      <h2>Meme library</h2>
      <span class="fine">${memeIndex.images.length} templates</span>
    </div>
    <section class="card library-card">
      <div class="eyebrow">Add template</div>
      <p class="fine">Drop an image on Add, or choose one source. The agent analyzes it automatically.</p>
      <div class="meme-actions">
        <button id="addMeme" class="neutral">＋ Add image ▾</button>
        <div class="add-menu" id="addMenu">
          <button id="addFile">From file</button>
          <button id="addUrl">From URL</button>
          <button id="addClipboard">From clipboard</button>
        </div>
        <input id="memeFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
      </div>
      <div id="memeStatus" class="meme-status"></div>
    </section>
    <div class="library-filters">
      <label for="statusFilter">Status</label>
      <select id="statusFilter">
        <option value="all">All</option>
        <option value="analyzed">🟢 Analyzed</option>
        <option value="needs-review">🟡 Needs review / duplicate</option>
        <option value="analyzing">🔵 Analyzing</option>
        <option value="pending">🟠 Pending</option>
      </select>
      <input id="memeSearch" type="search" placeholder="Search template, tags, emotion…">
      <button id="sortMemes" type="button" title="Toggle oldest/newest">▼ Newest</button>
      <span id="filterCount" class="filter-count"></span>
    </div>
    <section class="card library-card">
      <div class="meme-grid">
        ${memeCards || '<p class="fine">No local memes yet.</p>'}
      </div>
    </section>
  </div>

  <dialog id="memeDetail" class="meme-detail">
    <img id="detailImage" alt="">
    <h2 id="detailTitle"></h2>
    <dl id="detailData"></dl>
    <div class="identity-hint">
      <button id="showIdentityHint" type="button">Suggest identity</button>
      <textarea id="galleryIdentityHint" hidden placeholder="Suggested template identity or context…" autofocus></textarea>
      <button id="reanalyzeIdentity" type="button" hidden disabled>Send suggestion & re-analyze</button>
    </div>
    <div class="dialog-actions">
      <button type="button" id="closeMemeDetail">Close</button>
      <button type="button" id="replaceMeme" class="neutral" hidden>Replace existing</button>
      <button type="button" id="deleteMeme" class="meme-delete">Delete</button>
    </div>
  </dialog>

  <dialog id="createDialog">
    <form id="createForm" method="dialog">
      <h2>Create profile</h2>
      <p>Start from the current settings, then tune it independently.</p>
      <input id="newProfile" maxlength="32" placeholder="e.g. code-review" autofocus>
      <div class="dialog-actions">
        <button type="button" id="cancelCreate">Cancel</button>
        <button type="submit" class="good">Create profile</button>
      </div>
    </form>
  </dialog>

  <dialog id="deleteDialog">
    <h2>Delete profile?</h2>
    <p id="deleteMessage"></p>
    <div class="dialog-actions">
      <button type="button" id="cancelDelete">Cancel</button>
      <button type="button" id="confirmDelete" class="bad" disabled>Wait 5s</button>
    </div>
  </dialog>
</main>
<script>
  const status = document.querySelector("#status");
  let currentTurnId = "";
  let lastAnimatedTurnId = "";
  const answerDot = document.querySelector("#answerDot");
  const answerStatus = document.querySelector("#answerStatus");
  async function refreshAnswerSignal() {
    try {
      const response = await fetch("/api/turn", { cache: "no-store" });
      if (!response.ok) return;
      const turn = await response.json();
      if (!turn.id) return;
      currentTurnId = turn.id;
      const age = Date.now() - Number(turn.completedAt || 0);
      if (lastAnimatedTurnId !== turn.id && age <= 5000) {
        lastAnimatedTurnId = turn.id;
        answerDot.classList.remove("live");
        void answerDot.offsetWidth;
        answerDot.classList.add("live");
        answerStatus.textContent = "New answer ready to rate";
        setTimeout(() => {
          answerDot.classList.remove("live");
          answerStatus.textContent = "";
        }, 5000);
      }
    } catch {
      // A temporary polling miss does not affect the rating controls.
    }
  }
  setInterval(refreshAnswerSignal, 400);
  refreshAnswerSignal();
  const libraryMode = new URLSearchParams(location.search).has("view") &&
    new URLSearchParams(location.search).get("view") === "library";
  if (libraryMode) document.body.classList.add("library-open");
  document.querySelector("#openLibrary").addEventListener("click", () => {
    history.replaceState(null, "", "?view=library");
    document.body.classList.add("library-open");
  });
  document.querySelector("#closeLibrary").addEventListener("click", () => {
    history.replaceState(null, "", location.pathname);
    document.body.classList.remove("library-open");
  });
  const statusFilter = document.querySelector("#statusFilter");
  const memeSearch = document.querySelector("#memeSearch");
  const sortMemes = document.querySelector("#sortMemes");
  let newestFirst = true;
  let memeSignature = "";
  let pendingMemeRefresh = false;
  async function refreshMemeStatus() {
    try {
      const response = await fetch("/api/memes/status", { cache: "no-store" });
      if (!response.ok) return;
      const state = await response.json();
      if (memeSignature && state.signature !== memeSignature) {
        if (document.querySelector("#memeDetail")?.open) {
          pendingMemeRefresh = true;
          document.querySelector("#memeStatus").textContent = "Analysis updated. Refresh will run after this preview closes.";
          memeSignature = state.signature;
          return;
        }
        const params = new URLSearchParams();
        params.set("view", "library");
        if (statusFilter.value !== "all") params.set("status", statusFilter.value);
        if (memeSearch.value) params.set("q", memeSearch.value);
        location.assign("?" + params.toString());
      }
      memeSignature = state.signature;
    } catch {
      // A transient panel reload is not a user-facing error.
    }
  }
  function filterLibrary() {
    const cards = [...document.querySelectorAll("[data-meme-id]")];
    const query = memeSearch.value.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const meme = JSON.parse(card.dataset.meme);
      const haystack = [
        meme.template, meme.file, meme.emotion, meme.visualDescription,
        ...(meme.templateAliases || []), ...(meme.tone || []), ...(meme.tags || []),
      ].filter(Boolean).join(" ").toLowerCase();
      const show = (statusFilter.value === "all" || card.dataset.status === statusFilter.value)
        && (!query || haystack.includes(query));
      card.hidden = !show;
      if (show) visible += 1;
    }
    const count = document.querySelector("#filterCount");
    count.innerHTML = "<strong>" + visible + "/" + cards.length + "</strong><span>shown</span>";
  }
  statusFilter.addEventListener("change", filterLibrary);
  memeSearch.addEventListener("input", filterLibrary);
  function persistLibraryFilters() {
    const params = new URLSearchParams(location.search);
    params.set("view", "library");
    if (statusFilter.value === "all") params.delete("status");
    else params.set("status", statusFilter.value);
    if (memeSearch.value) params.set("q", memeSearch.value);
    else params.delete("q");
    history.replaceState(null, "", "?" + params.toString());
  }
  statusFilter.addEventListener("change", persistLibraryFilters);
  memeSearch.addEventListener("input", persistLibraryFilters);
  function sortMemeCards() {
    sortMemes.textContent = newestFirst ? "▼ Newest" : "▲ Oldest";
    const grid = document.querySelector(".meme-grid");
    const cards = [...grid.querySelectorAll("[data-meme-id]")];
    cards.sort((left, right) => {
      const a = Date.parse(JSON.parse(left.dataset.meme).addedAt || 0);
      const b = Date.parse(JSON.parse(right.dataset.meme).addedAt || 0);
      return newestFirst ? b - a : a - b;
    });
    cards.forEach((card) => grid.appendChild(card));
  }
  sortMemes.addEventListener("click", () => {
    newestFirst = !newestFirst;
    sortMemeCards();
  });
  sortMemeCards();
  filterLibrary();
  const initialParams = new URLSearchParams(location.search);
  if (initialParams.has("status")) statusFilter.value = initialParams.get("status");
  if (initialParams.has("q")) memeSearch.value = initialParams.get("q");
  filterLibrary();
  if (libraryMode) {
    refreshMemeStatus();
    setInterval(refreshMemeStatus, 2500);
  }
  async function post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  async function run(work) {
    status.textContent = "Working…";
    try {
      await work();
      location.reload();
    } catch (error) {
      status.textContent = error.message;
    }
  }
  for (const button of document.querySelectorAll("[data-reaction]")) {
    button.addEventListener("click", () => run(() => post("/api/reaction", {
      reaction: button.dataset.reaction,
      turnId: currentTurnId,
    })));
  }
  document.querySelector("#prMemes").addEventListener("change", (event) =>
    run(() => post("/api/reaction", { reaction: event.target.checked ? "pr-memes-on" : "pr-memes-off" })));
  document.querySelector("#profile").addEventListener("change", (event) =>
    run(() => post("/api/profile/switch", { name: event.target.value })));

  async function importMemeResult(result) {
    status.textContent = "Imported. Agent analysis will run next.";
    const params = new URLSearchParams(location.search);
    params.set("view", "library");
    if (statusFilter.value !== "all") params.set("status", statusFilter.value);
    if (memeSearch.value) params.set("q", memeSearch.value);
    params.set("addOpen", "1");
    await post("/api/meme/analyze", { id: result.id });
    location.assign("?" + params.toString());
  }

  const memeFile = document.querySelector("#memeFile");
  const memeStatus = document.querySelector("#memeStatus");
  const addButton = document.querySelector("#addMeme");
  const addMenu = document.querySelector("#addMenu");
  addButton.addEventListener("click", () => addMenu.classList.toggle("open"));
  if (new URLSearchParams(location.search).get("addOpen") === "1") addMenu.classList.add("open");
  document.querySelector("#addFile").addEventListener("click", () => memeFile.click());
  document.querySelector("#addUrl").addEventListener("click", async () => {
    const url = prompt("Paste an image URL (PNG, JPEG, GIF, or WebP):");
    if (!url) return;
    try {
      memeStatus.textContent = "Importing image…";
      importMemeResult(await post("/api/meme/import-url", { url }));
    } catch (error) {
      memeStatus.textContent = error.message;
    }
  });
  document.querySelector("#addClipboard").addEventListener("click", async () => {
    try {
      const items = await navigator.clipboard.read();
      const type = ["image/png", "image/jpeg", "image/gif", "image/webp"].find((candidate) =>
        items.some((item) => item.types.includes(candidate)));
      if (!type) throw new Error("Clipboard does not contain a supported image.");
      const item = items.find((candidate) => candidate.types.includes(type));
      const blob = await item.getType(type);
      await importMemeFile(new File([blob], "clipboard." + type.split("/")[1], { type }));
    } catch (error) {
      memeStatus.textContent = error.message;
    }
  });
  async function importMemeFile(file) {
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(file);
      });
      const perceptualHash = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = 16;
          canvas.height = 16;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          context.drawImage(image, 0, 0, 16, 16);
          const pixels = context.getImageData(0, 0, 16, 16).data;
          const luminance = [];
          for (let index = 0; index < pixels.length; index += 4) {
            luminance.push(pixels[index] * .299 + pixels[index + 1] * .587 + pixels[index + 2] * .114);
          }
          const average = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
          resolve(luminance.map((value) => value >= average ? "1" : "0").join(""));
        };
        image.onerror = () => reject(new Error("Could not inspect the image."));
        image.src = dataUrl;
      });
      const result = await post("/api/meme/import", {
        fileName: file.name,
        mimeType: file.type,
        dataUrl,
        perceptualHash
      });
      await importMemeResult(result);
    } catch (error) {
      memeStatus.textContent = error.message;
    }
  }
  memeFile.addEventListener("change", async () => {
    if (memeFile.files.length) await importMemeFile(memeFile.files[0]);
    memeFile.value = "";
  });
  for (const eventName of ["dragenter", "dragover"]) {
    addButton.addEventListener(eventName, (event) => {
      event.preventDefault();
      addButton.classList.add("dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    addButton.addEventListener(eventName, (event) => {
      event.preventDefault();
      addButton.classList.remove("dragging");
    });
  }
  addButton.addEventListener("drop", async (event) => {
    const file = [...event.dataTransfer.files].find((candidate) =>
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(candidate.type));
    if (file) await importMemeFile(file);
    else memeStatus.textContent = "Drop a PNG, JPEG, GIF, or WebP image.";
  });
  const memeDetail = document.querySelector("#memeDetail");
  const deleteMemeButton = document.querySelector("#deleteMeme");
  const replaceMemeButton = document.querySelector("#replaceMeme");
  let selectedMeme;
  memeDetail.addEventListener("close", () => {
    if (pendingMemeRefresh) {
      pendingMemeRefresh = false;
      const params = new URLSearchParams(location.search);
      params.set("view", "library");
      location.assign("?" + params.toString());
    }
  });
  memeDetail.addEventListener("click", (event) => {
    if (event.target === memeDetail) memeDetail.close();
  });
  for (const button of document.querySelectorAll("[data-meme-id]")) {
    button.addEventListener("click", () => {
      selectedMeme = JSON.parse(button.dataset.meme);
      const image = document.querySelector("#detailImage");
      image.src = "/api/meme/image?id=" + encodeURIComponent(selectedMeme.id);
      image.alt = selectedMeme.template || selectedMeme.file;
      document.querySelector("#detailTitle").textContent = selectedMeme.template || "Awaiting analysis";
      replaceMemeButton.hidden = !selectedMeme.duplicateOf;
      replaceMemeButton.textContent = selectedMeme.replacementSuggested ? "Replace existing" : "Keep both";
      const rows = [
        ["Status", selectedMeme.duplicateOf ? "Duplicate decision" : selectedMeme.analysisStatus],
        ["Confidence", selectedMeme.confidence ? Math.round(selectedMeme.confidence * 100) + "%" : "—"],
        ["Emotion", selectedMeme.emotion || "—"],
        ["Tone", (selectedMeme.tone || []).join(", ") || "—"],
        ["Tags", (selectedMeme.tags || []).join(", ") || "—"],
        ["Description", selectedMeme.visualDescription || "—"],
        ["Source", selectedMeme.source || "local-import"],
      ];
      document.querySelector("#detailData").replaceChildren(...rows.flatMap(([label, value]) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = value;
        return [dt, dd];
      }));
      memeDetail.showModal();
    });
  }
  document.querySelector("#closeMemeDetail").addEventListener("click", () => memeDetail.close());
  const galleryIdentityHint = document.querySelector("#galleryIdentityHint");
  const reanalyzeIdentity = document.querySelector("#reanalyzeIdentity");
  document.querySelector("#showIdentityHint").addEventListener("click", () => {
    galleryIdentityHint.hidden = false;
    reanalyzeIdentity.hidden = false;
    document.querySelector("#showIdentityHint").hidden = true;
    galleryIdentityHint.focus();
  });
  galleryIdentityHint.addEventListener("input", () => {
    reanalyzeIdentity.disabled = !galleryIdentityHint.value.trim();
  });
  reanalyzeIdentity.addEventListener("click", () => {
    const hint = galleryIdentityHint.value.trim();
    if (!selectedMeme || !hint) return;
    run(() => post("/api/meme/analyze", { id: selectedMeme.id, hint }));
  });
  deleteMemeButton.addEventListener("click", () =>
    selectedMeme && run(() => post("/api/meme/delete", { id: selectedMeme.id })));
  replaceMemeButton.addEventListener("click", () => {
    if (!selectedMeme?.duplicateOf) return;
    if (selectedMeme.replacementSuggested) {
      run(() => post("/api/meme/replace", {
        existingId: selectedMeme.duplicateOf,
        replacementId: selectedMeme.id
      }));
    } else {
      run(() => post("/api/meme/keep", { id: selectedMeme.id }));
    }
  });

  const importFile = document.querySelector("#importFile");
  document.querySelector("#import").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    if (!importFile.files.length) return;
    try {
      const payload = JSON.parse(await importFile.files[0].text());
      try {
        await post("/api/profile/import", { profile: payload, overwrite: false });
      } catch (error) {
        if (!error.message.includes("already exists")) throw error;
        if (!confirm('A profile named "' + payload.name + '" already exists. Overwrite it?')) return;
        await post("/api/profile/import", { profile: payload, overwrite: true });
      }
      location.reload();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      importFile.value = "";
    }
  });

  const createDialog = document.querySelector("#createDialog");
  document.querySelector("#new").addEventListener("click", () => createDialog.showModal());
  document.querySelector("#cancelCreate").addEventListener("click", () => createDialog.close());
  document.querySelector("#createForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = document.querySelector("#newProfile").value;
    run(() => post("/api/profile/create", { name }));
  });

  const deleteDialog = document.querySelector("#deleteDialog");
  const confirmDelete = document.querySelector("#confirmDelete");
  let deleteTimer;
  document.querySelector("#delete").addEventListener("click", () => {
    const name = document.querySelector("#profile").value;
    document.querySelector("#deleteMessage").textContent =
      'Profile "' + name + '" will be permanently removed.';
    confirmDelete.disabled = true;
    let seconds = 5;
    confirmDelete.textContent = "Wait " + seconds + "s";
    clearInterval(deleteTimer);
    deleteTimer = setInterval(() => {
      seconds -= 1;
      if (seconds > 0) {
        confirmDelete.textContent = "Wait " + seconds + "s";
      } else {
        clearInterval(deleteTimer);
        confirmDelete.disabled = false;
        confirmDelete.textContent = "Delete now";
      }
    }, 1000);
    deleteDialog.showModal();
  });
  document.querySelector("#cancelDelete").addEventListener("click", () => {
    clearInterval(deleteTimer);
    deleteDialog.close();
  });
  confirmDelete.addEventListener("click", () => {
    const name = document.querySelector("#profile").value;
    run(() => post("/api/profile/delete", { name }));
  });
  deleteDialog.addEventListener("close", () => clearInterval(deleteTimer));
</script>
</body>
</html>`;
}

async function readBody(request) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, value, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
}

async function startServer() {
    await listProfiles();
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    await recoverAnalysisState();
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, "http://127.0.0.1");
            if (request.method === "GET" && url.pathname === "/api/export") {
                const name = await getActiveName();
                const profile = await loadProfile();
                response.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Disposition": `attachment; filename="lolpilot-${name}.json"`,
                });
                response.end(JSON.stringify({ name, ...profile }, null, 2));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/reaction") {
                const body = await readBody(request);
                const next = applyReaction(
                    await loadProfile(),
                    body.reaction,
                    body.turnId === lastAssistantTurn.id ? lastAssistantTurn.styles : []
                );
                if (["trafione", "meh"].includes(body.reaction)) next.ratedTurnId = String(body.turnId || "");
                sendJson(response, await saveActiveProfile(next));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/turn") {
                sendJson(response, lastAssistantTurn);
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/profile/create") {
                const body = await readBody(request);
                const result = await createProfile(body.name, await loadProfile());
                sendJson(response, await switchProfile(result.name));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/profile/switch") {
                const body = await readBody(request);
                sendJson(response, await switchProfile(body.name));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/profile/delete") {
                const body = await readBody(request);
                sendJson(response, await deleteProfile(body.name));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/profile/import") {
                const body = await readBody(request);
                sendJson(response, await importProfile(body.profile, body.overwrite === true));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/import") {
                sendJson(response, await addMeme(await readBody(request)));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/import-url") {
                const body = await readBody(request);
                sendJson(response, await addMemeFromUrl(body.url));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/analyze") {
                const body = await readBody(request);
                sendJson(response, await analyzeMeme(body.id, body.hint || ""));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/memes/status") {
                const changed = await syncAnalysisResults();
                const index = await loadMemeIndex();
                sendJson(response, {
                    changed,
                    signature: index.images
                        .map((image) => `${image.id}:${image.analysisStatus}:${image.updatedAt || ""}`)
                        .join("|"),
                });
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/delete") {
                const body = await readBody(request);
                sendJson(response, await deleteMeme(body.id));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/replace") {
                const body = await readBody(request);
                sendJson(response, await replaceMeme(body.existingId, body.replacementId));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/keep") {
                const body = await readBody(request);
                sendJson(response, await keepMeme(body.id));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/meme/image") {
                const id = url.searchParams.get("id");
                const image = (await loadMemeIndex()).images.find((candidate) => candidate.id === id);
                if (!image) {
                    response.writeHead(404);
                    response.end("Meme not found.");
                    return;
                }
                response.writeHead(200, {
                    "Content-Type": image.mimeType,
                    "Cache-Control": "private, max-age=86400",
                    "X-Content-Type-Options": "nosniff",
                });
                response.end(await readFile(`${IMAGE_CACHE_DIR}\\${image.file}`));
                return;
            }
            const profile = await loadProfile();
            const profiles = await listProfiles();
            const activeName = await getActiveName();
            await syncAnalysisResults();
            const memeIndex = await loadMemeIndex();
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(renderHtml(profile, profiles, activeName, memeIndex));
        } catch (error) {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
            response.end(error instanceof Error ? error.message : "Lolpilot update failed.");
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

async function startPreviewServer(_instanceId, image, caption = "") {
    const server = createServer(async (request, response) => {
        const url = new URL(request.url, "http://127.0.0.1");
        if (url.pathname === "/close" && request.method === "POST") {
            response.writeHead(204);
            response.end();
            return;
        }
        if (url.pathname === "/rate" && request.method === "POST") {
            const body = await readBody(request);
            if (!["hit", "miss"].includes(body.value)) {
                response.writeHead(400);
                response.end("Invalid rating.");
                return;
            }
            const index = await loadMemeIndex();
            const current = index.images.find((candidate) => candidate.id === image.id);
            if (current) {
                current.feedback = { ...(current.feedback || {}) };
                current.feedback[body.value] = Number(current.feedback[body.value] || 0) + 1;
                current.feedback.last = body.value;
                current.uses = Number(current.uses || 0) + 1;
                current.updatedAt = new Date().toISOString();
                await saveMemeIndex(index);
            }
            sendJson(response, { id: image.id, value: body.value });
            return;
        }
        if (url.pathname === "/image") {
            response.writeHead(200, {
                "Content-Type": image.mimeType,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            });
            response.end(await readFile(`${IMAGE_CACHE_DIR}\\${image.file}`));
            return;
        }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(image.template || "Lolpilot meme")}</title>
<style>
  body { margin:0; min-height:100vh; overflow:auto; background:var(--background-color-default,#0f172a);
    color:var(--text-color-default,#f8fafc); font-family:var(--font-sans,Segoe UI,sans-serif); }
  main { width:min(100%, 720px); min-height:100vh; margin:0 auto; padding:12px;
    display:flex; flex-direction:column; justify-content:center; }
  main.dismissing { animation: fadeDismiss 1.5s ease forwards; }
  @keyframes fadeDismiss { to { opacity:0; transform:scale(.985); } }
  canvas { display:block; width:100%; height:auto; max-height:none; object-fit:contain; background:#000; }
  body.idle {
    background: linear-gradient(120deg, #f8fafc, #d1d5db, #f8fafc) !important;
    background-size: 220% 220%;
    animation: idleWave 7s ease-in-out infinite;
  }
  @keyframes idleWave { 0%,100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
  @media (prefers-reduced-motion: reduce) { body.idle { animation:none; } }
  .feedback { display:flex; justify-content:center; gap:10px; margin-top:16px; padding:0 0 4px; }
  .feedback button { min-width:110px; min-height:40px; border:1px solid #475569; border-radius:5px;
    color:#111827; background:#fff; font:700 14px var(--font-sans,Segoe UI,sans-serif); cursor:pointer; }
  #hit, #miss { background:#fff; border-color:#d1d5db; }
  .feedback button.selected { outline:3px solid #8b5cf6; outline-offset:1px; }
  .dismiss-hint { display:block; padding:8px 0 0; color:var(--text-color-muted,#9da7b3); text-align:center; font-size:12px; }
</style></head><body>
<main>
  <canvas id="preview" aria-label="${escapeHtml(image.template || "Meme editor")}"></canvas>
  <div class="feedback">
    <button id="miss" aria-label="Meh" title="Meh">😐</button>
    <button id="hit" aria-label="Hit" title="Hit">😬</button>
  </div>
  <small class="dismiss-hint">Click image to dismiss</small>
</main>
<script>
const canvas = document.querySelector("#preview");
const ctx = canvas.getContext("2d");
const topText = { value: ${JSON.stringify(String(caption || ""))} };
const bottomText = { value: "" };
const source = new Image();
source.onload = render;
source.src = "/image";

function wrapText(text, maxWidth) {
  const words = text.trim().toUpperCase().split(/\\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

function drawCaption(text, fromBottom) {
  if (!text.trim()) return;
  const fontSize = Math.max(24, Math.round(canvas.width / 13));
  const maxWidth = canvas.width * .9;
  const lineHeight = fontSize * 1.05;
  ctx.font = "900 " + fontSize + "px Impact, Haettenschweiler, Arial Black, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(5, Math.round(fontSize / 7));
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  const lines = wrapText(text, maxWidth);
  const startY = fromBottom
    ? canvas.height - 16 - (lines.length - 1) * lineHeight
    : 16 + fontSize;
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    ctx.strokeText(line, canvas.width / 2, y);
    ctx.fillText(line, canvas.width / 2, y);
  });
}

function render() {
  if (!source.complete || !source.naturalWidth) return;
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  ctx.drawImage(source, 0, 0);
  drawCaption(topText.value, false);
  drawCaption(bottomText.value, true);
}

async function rate(value) {
  const response = await fetch("/rate", {
    method:"POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({ value })
  });
  if (!response.ok) return;
  document.querySelectorAll(".feedback button").forEach((button) => button.classList.remove("selected"));
  document.querySelector(value === "hit" ? "#hit" : "#miss").classList.add("selected");
}
document.querySelector("#hit").addEventListener("click", () => rate("hit"));
document.querySelector("#miss").addEventListener("click", () => rate("miss"));
canvas.addEventListener("click", () => {
  document.querySelector("main").classList.add("dismissing");
  setTimeout(() => {
    document.body.innerHTML = "";
    document.body.className = "idle";
    document.body.style.setProperty("background", "linear-gradient(120deg, #f8fafc, #d1d5db, #f8fafc)", "important");
    document.body.style.setProperty("background-size", "220% 220%", "important");
    document.body.style.setProperty("animation", "idleWave 7s ease-in-out infinite", "important");
  }, 1500);
});
</script></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return {
        server,
        url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`,
    };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "lolpilot-reactions",
            displayName: "Lolpilot",
            description: "Rate the last response and tune humor and image frequency.",
            actions: [
                {
                    name: "get_profile",
                    description: "Read the active Lolpilot profile",
                    handler: async () => ({ name: await getActiveName(), ...await loadProfile() }),
                },
                {
                    name: "get_pr_meme_suggestion",
                    description: "Read the pending opt-in meme suggestion for a pull request",
                    handler: async () => pendingPrMeme || { available: false },
                },
                {
                    name: "list_profiles",
                    description: "List saved Lolpilot profiles",
                    handler: async () => ({ active: await getActiveName(), profiles: await listProfiles() }),
                },
                {
                    name: "analyze_pending_memes",
                    description: "Analyze all pending Lolpilot memes with vision",
                    handler: async () => analyzePendingMemes(),
                },
                {
                    name: "find_meme",
                    description: "Find a local meme by clue or tags",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: { type: "string", minLength: 1 },
                            limit: { type: "integer", minimum: 1, maximum: 5 },
                        },
                        required: ["query"],
                    },
                    handler: async (ctx) => findMemes(await loadMemeIndex(), ctx.input.query)
                        .slice(0, ctx.input.limit || 1)
                        .map(({ file, hash, ...image }) => image),
                },
                {
                    name: "react",
                    description: "Apply a Lolpilot reaction or preference",
                    inputSchema: {
                        type: "object",
                        properties: {
                            reaction: {
                                type: "string",
                                enum: ["trafione", "meh", "humor+", "humor-", "humor-stop", "images-on", "images-rare", "images-off", "censor-safe", "censor-off", "pr-memes-on", "pr-memes-off"],
                            },
                        },
                        required: ["reaction"],
                    },
                    handler: async (ctx) => saveActiveProfile(applyReaction(await loadProfile(), ctx.input.reaction)),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Lolpilot Reactions", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
        createCanvas({
            id: "lolpilot-meme-preview",
            displayName: "Lolpilot Meme",
            description: "Show one selected meme beside the conversation; click to close.",
            inputSchema: {
                type: "object",
                properties: {
                    memeId: { type: "string" },
                    caption: { type: "string" },
                },
                required: ["memeId"],
            },
            open: async (ctx) => {
                const image = (await loadMemeIndex()).images.find((candidate) =>
                    candidate.id === String(ctx.input.memeId)
                );
                if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
                const existing = previewServers.get(ctx.instanceId);
                if (existing) {
                    await new Promise((resolve) => existing.server.close(() => resolve()));
                    previewServers.delete(ctx.instanceId);
                }
                const entry = await startPreviewServer(
                    ctx.instanceId,
                    image,
                    String(ctx.input.caption || "")
                );
                previewServers.set(ctx.instanceId, entry);
                return { title: image.template || "Lolpilot Meme", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = previewServers.get(ctx.instanceId);
                if (entry) {
                    previewServers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
    hooks: {
        onSessionStart: async () => ({ additionalContext: profileContext(await loadProfile()) }),
        onUserPromptSubmitted: async (input) => {
            const command = input.prompt.trim().toLowerCase();
            if (["trafione", "meh", "humor+", "humor-", "humor: stop"].includes(command)) {
                const reaction = command === "humor: stop" ? "humor-stop" : command;
                await saveActiveProfile(applyReaction(await loadProfile(), reaction));
            }
            const profile = await loadProfile();
            const prSuggestion = suggestPrMeme(input.prompt, profile);
            if (prSuggestion) pendingPrMeme = prSuggestion;
            else pendingPrMeme = null;
            const context = [profileContext(profile)];
            if (profile.images !== "never") {
                const matches = findMemes(await loadMemeIndex(), input.prompt).slice(0, 1);
                if (matches.length) {
                    const meme = matches[0];
                    if (meme.analysisStatus === "analyzed") {
                        context.push(
                            `A native image attachment matching this topic is available: template="${meme.template}"; tags=${meme.tags.join(",")}.`,
                            "Image output is currently disabled because this host cannot publish extension images inside assistant responses. Do not mention or attach the image."
                        );
                    } else {
                        context.push(`A matching local meme exists but is not ready to display: status=${meme.analysisStatus}.`);
                    }
                }
            }
            const prContext = prMemeInstructions(pendingPrMeme);
            if (prContext) context.push(prContext);
            return { additionalContext: context.join(" ") };
        },
    },
});

session.on("assistant.message", (event) => {
    const messageId = String(event.data.messageId || "");
    if (!messageId || event.data.toolRequests?.length) return;
    lastAssistantTurn = {
        id: messageId,
        completedAt: Date.now(),
        styles: detectHumorStyles(event.data.content),
    };
});
