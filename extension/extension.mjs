import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const ROOT = "C:\\Dev\\lolpilot";
const ACTIVE_PROFILE_PATH = `${ROOT}\\profile.md`;
const PROFILES_DIR = `${ROOT}\\profiles`;
const ACTIVE_NAME_PATH = `${ROOT}\\active-profile.txt`;
const IMAGE_CACHE_DIR = `${ROOT}\\cache\\images`;
const MEME_INDEX_PATH = `${ROOT}\\cache\\meme-index.json`;
const servers = new Map();

const defaultProfile = {
    level: 2,
    images: "rare",
    lastReaction: "none",
    hits: 0,
    misses: 0,
};

async function loadMemeIndex() {
    try {
        const parsed = JSON.parse(await readFile(MEME_INDEX_PATH, "utf8"));
        return {
            version: 1,
            images: Array.isArray(parsed.images) ? parsed.images : [],
        };
    } catch {
        return { version: 1, images: [] };
    }
}

async function saveMemeIndex(index) {
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    await writeFile(MEME_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
}

function normalizeTags(tags) {
    return [...new Set(String(tags || "")
        .split(/[,#\n]/)
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean))]
        .slice(0, 24);
}

async function addMeme({ fileName, mimeType, dataUrl, tags, clue, source = "local-import" }) {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
        throw new CanvasError("invalid_image_type", "Use PNG, JPEG, GIF, or WebP.");
    }
    const match = String(dataUrl || "").match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new CanvasError("invalid_image", "The selected image could not be read.");
    const bytes = Buffer.from(match[1], "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        throw new CanvasError("invalid_image_size", "Image size must be between 1 byte and 8 MiB.");
    }
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mimeType];
    const hash = createHash("sha256").update(bytes).digest("hex");
    const index = await loadMemeIndex();
    const existing = index.images.find((image) => image.hash === hash);
    if (existing) {
        const mergedTags = [...new Set([...existing.tags, ...normalizeTags(tags)])];
        existing.tags = mergedTags;
        existing.clue = String(clue || existing.clue || "").trim().slice(0, 240);
        await saveMemeIndex(index);
        return existing;
    }
    const id = hash.slice(0, 16);
    const safeBase = String(fileName || "meme").replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-")
        .replace(/^-+|-+$/g, "").slice(0, 40) || "meme";
    const file = `${safeBase}-${id}.${extension}`;
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    await writeFile(`${IMAGE_CACHE_DIR}\\${file}`, bytes);
    const image = {
        id,
        file,
        mimeType,
        hash,
        tags: normalizeTags(tags),
        clue: String(clue || "").trim().slice(0, 240),
        source: String(source || "local-import").trim().slice(0, 240),
        addedAt: new Date().toISOString(),
        uses: 0,
    };
    index.images.push(image);
    await saveMemeIndex(index);
    return image;
}

function findMemes(index, query) {
    const terms = normalizeTags(query);
    return index.images
        .map((image) => {
            const searchable = normalizeTags([image.clue, ...image.tags].join(","));
            const matches = terms.filter((term) => searchable.includes(term)).length;
            const fuzzyMatches = terms.filter((term) =>
                searchable.some((value) => value.includes(term) || term.includes(value))
            ).length;
            return { image, score: matches * 4 + fuzzyMatches + Math.min(image.uses, 3) * 0.1 };
        })
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .map(({ image, score }) => ({ ...image, score }));
}

async function deleteMeme(id) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    await unlink(`${IMAGE_CACHE_DIR}\\${image.file}`);
    index.images = index.images.filter((candidate) => candidate.id !== id);
    await saveMemeIndex(index);
    return { deleted: id };
}

function normalizeName(name) {
    const normalized = String(name || "").trim().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(normalized)) {
        throw new CanvasError("invalid_profile_name", "Use 1-32 letters, digits, hyphens, or underscores.");
    }
    return normalized;
}

function profilePath(name) {
    return `${PROFILES_DIR}\\${normalizeName(name)}.md`;
}

function parseProfile(text) {
    const number = (name, fallback) => {
        const match = text.match(new RegExp(`^- ${name}: (\\d+)$`, "m"));
        return match ? Number(match[1]) : fallback;
    };
    const value = (name, fallback) => {
        const match = text.match(new RegExp(`^- ${name}: (.+)$`, "m"));
        return match?.[1]?.trim() || fallback;
    };
    return {
        level: Math.max(0, Math.min(3, Number.parseInt(value("Level", "2/3"), 10))),
        images: value("Images", "rare"),
        lastReaction: value("Last reaction", "none"),
        hits: number("Hits", 0),
        misses: number("Misses", 0),
    };
}

function profileMarkdown(profile) {
    return `# Lolpilot profile

- Owner: PC
- Level: ${profile.level}/3
- Images: ${profile.images}
- Last reaction: ${profile.lastReaction}
- Hits: ${profile.hits}
- Misses: ${profile.misses}
- Style: concise, playful, technically precise
- Never joke in commits, security findings, production incidents, or when safety is at stake
`;
}

function normalizeProfile(profile) {
    return {
        level: Math.max(0, Math.min(3, Number(profile.level ?? defaultProfile.level))),
        images: ["rare", "often", "never"].includes(profile.images) ? profile.images : defaultProfile.images,
        lastReaction: String(profile.lastReaction || "none"),
        hits: Math.max(0, Number(profile.hits) || 0),
        misses: Math.max(0, Number(profile.misses) || 0),
    };
}

async function getActiveName() {
    try {
        return normalizeName(await readFile(ACTIVE_NAME_PATH, "utf8"));
    } catch {
        return "default";
    }
}

async function listProfiles() {
    await mkdir(PROFILES_DIR, { recursive: true });
    const names = (await readdir(PROFILES_DIR))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.slice(0, -3))
        .sort();
    if (!names.length) {
        const text = profileMarkdown(defaultProfile);
        await writeFile(profilePath("default"), text, "utf8");
        await writeFile(ACTIVE_PROFILE_PATH, text, "utf8");
        await writeFile(ACTIVE_NAME_PATH, "default\n", "utf8");
        return ["default"];
    }
    return names;
}

async function loadProfile() {
    try {
        return parseProfile(await readFile(ACTIVE_PROFILE_PATH, "utf8"));
    } catch {
        return { ...defaultProfile };
    }
}

async function loadNamedProfile(name) {
    try {
        return parseProfile(await readFile(profilePath(name), "utf8"));
    } catch {
        throw new CanvasError("profile_not_found", `Profile "${name}" was not found.`);
    }
}

async function persistActive(name, profile) {
    const normalizedName = normalizeName(name);
    const normalizedProfile = normalizeProfile(profile);
    const text = profileMarkdown(normalizedProfile);
    await mkdir(PROFILES_DIR, { recursive: true });
    await writeFile(profilePath(normalizedName), text, "utf8");
    await writeFile(ACTIVE_PROFILE_PATH, text, "utf8");
    await writeFile(ACTIVE_NAME_PATH, `${normalizedName}\n`, "utf8");
    return { name: normalizedName, ...normalizedProfile };
}

async function saveActiveProfile(profile) {
    return persistActive(await getActiveName(), profile);
}

async function createProfile(name, profile = defaultProfile) {
    const normalizedName = normalizeName(name);
    const names = await listProfiles();
    if (names.some((candidate) => candidate.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
        throw new CanvasError("profile_exists", `Profile "${normalizedName}" already exists.`);
    }
    const text = profileMarkdown(normalizeProfile(profile));
    await writeFile(profilePath(normalizedName), text, "utf8");
    return { name: normalizedName, ...normalizeProfile(profile) };
}

function validateImportedProfile(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CanvasError("invalid_import", "The selected file is not a Lolpilot profile.");
    }
    const name = normalizeName(payload.name);
    const level = Number(payload.level);
    if (!Number.isInteger(level) || level < 0 || level > 3) {
        throw new CanvasError("invalid_import", "Profile level must be an integer from 0 to 3.");
    }
    if (!["rare", "often", "never"].includes(payload.images)) {
        throw new CanvasError("invalid_import", 'Images must be "rare", "often", or "never".');
    }
    return {
        name,
        profile: normalizeProfile({
            ...payload,
            lastReaction: "imported",
        }),
    };
}

async function importProfile(payload, overwrite = false) {
    const imported = validateImportedProfile(payload);
    const names = await listProfiles();
    const existingName = names.find((candidate) =>
        candidate.toLocaleLowerCase() === imported.name.toLocaleLowerCase()
    );
    if (existingName && !overwrite) {
        throw new CanvasError("profile_exists", `Profile "${imported.name}" already exists.`);
    }
    return persistActive(existingName || imported.name, imported.profile);
}

async function switchProfile(name) {
    const normalizedName = normalizeName(name);
    return persistActive(normalizedName, await loadNamedProfile(normalizedName));
}

async function deleteProfile(name) {
    const normalizedName = normalizeName(name);
    const names = await listProfiles();
    if (!names.includes(normalizedName)) {
        throw new CanvasError("profile_not_found", `Profile "${normalizedName}" was not found.`);
    }
    if (names.length === 1) {
        throw new CanvasError("last_profile", "Keep at least one profile.");
    }
    if (normalizedName === await getActiveName()) {
        const replacement = names.find((candidate) => candidate !== normalizedName);
        await switchProfile(replacement);
    }
    await unlink(profilePath(normalizedName));
    return { deleted: normalizedName, active: await getActiveName() };
}

function applyReaction(profile, reaction) {
    const next = { ...profile, lastReaction: reaction };
    switch (reaction) {
        case "trafione":
            next.level = Math.min(3, next.level + 1);
            next.hits += 1;
            break;
        case "meh":
            next.level = Math.max(0, next.level - 1);
            next.misses += 1;
            break;
        case "humor+":
            next.level = Math.min(3, next.level + 1);
            break;
        case "humor-":
            next.level = Math.max(0, next.level - 1);
            break;
        case "humor-stop":
            next.level = 0;
            break;
        case "images-on":
            next.images = "often";
            break;
        case "images-rare":
            next.images = "rare";
            break;
        case "images-off":
            next.images = "never";
            break;
        default:
            throw new CanvasError("invalid_reaction", `Unknown reaction: ${reaction}`);
    }
    return next;
}

function profileContext(profile) {
    return [
        "Lolpilot profile:",
        `humor level ${profile.level}/3`,
        `image preference: ${profile.images}`,
        `last reaction: ${profile.lastReaction}`,
        "Be concise and technically precise. Never let humor obscure findings, risks, safety, or commits.",
        "Prefer an image or meme only when image preference allows it and the image materially improves the response.",
    ].join("; ");
}

function escapeHtml(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderHtml(profile, profiles, activeName, memeIndex) {
    const levels = ["off", "subtle", "playful", "feral"];
    const options = profiles.map((name) =>
        `<option value="${escapeHtml(name)}" ${name === activeName ? "selected" : ""}>${escapeHtml(name)}</option>`
    ).join("");
    const memeCards = memeIndex.images.map((image) => `
      <article class="meme-card">
        <img src="/api/meme/image?id=${encodeURIComponent(image.id)}" alt="${escapeHtml(image.clue || image.file)}">
        <div class="meme-copy">
          <strong>${escapeHtml(image.clue || "Untitled clue")}</strong>
          <small>${image.tags.map((tag) => `#${escapeHtml(tag)}`).join(" ") || "No tags yet"}</small>
        </div>
        <button class="meme-delete" data-meme-delete="${escapeHtml(image.id)}" title="Delete meme">❌</button>
      </article>
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
    .eyebrow { color: #8b5cf6; font-size: 11px; font-weight: 750; letter-spacing: .11em; text-transform: uppercase; }
    .level { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 8px; }
    .level-name { min-width: 74px; font-size: 21px; font-weight: 750; text-transform: capitalize; }
    .meter { flex: 1; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .bar { height: 10px; border: 1px solid var(--lp-border); border-radius: 3px; background: var(--lp-control); }
    .bar.on { border-color: transparent; background: linear-gradient(90deg, #f97316, #ec4899); }
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
    .meme-grid { display: grid; gap: 8px; margin-top: 12px; }
    .meme-card { display: grid; grid-template-columns: 70px minmax(0, 1fr) auto; align-items: center; gap: 10px;
      padding: 8px; border: 1px solid var(--lp-border); border-radius: 5px; background: var(--lp-control); }
    .meme-card img { width: 70px; height: 54px; object-fit: cover; border-radius: 3px; background: #000; }
    .meme-copy { min-width: 0; }
    .meme-copy strong, .meme-copy small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meme-copy small { margin-top: 3px; color: var(--lp-muted); }
    .meme-delete { min-height: 36px; padding: 7px 9px; color: #fff; border-color: #be123c; background: #be123c; }
    .meme-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-top: 11px; }
    .meme-fields { display: grid; gap: 7px; }
    #memeFile { display: none; }
    dialog { width: min(420px, calc(100vw - 32px)); border: 1px solid var(--lp-border); border-radius: 7px;
      color: inherit; background: var(--lp-card); box-shadow: 0 18px 60px #0008; }
    dialog::backdrop { background: #0009; backdrop-filter: blur(2px); }
    dialog h2 { margin: 0 0 8px; font-size: 18px; }
    dialog p { color: var(--lp-muted); }
    .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
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
      .meter { width: 100%; }
      .meme-form { grid-template-columns: minmax(0, 1fr); }
      .meme-card { grid-template-columns: 54px minmax(0, 1fr) auto; }
      .meme-card img { width: 54px; height: 44px; }
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

  <section class="card">
    <div class="eyebrow">Humor engine</div>
    <div class="level">
      <div class="level-name">${escapeHtml(levels[profile.level])}</div>
      <div class="meter">${levels.slice(1).map((_, index) => `<div class="bar ${index < profile.level ? "on" : ""}"></div>`).join("")}</div>
      <strong>${profile.level}/3</strong>
    </div>
    <div class="buttons">
      <button class="cool" data-reaction="humor-">🧊 Dial it down</button>
      <button class="hot" data-reaction="humor+">🔥 More chaos</button>
      <button class="neutral wide" data-reaction="humor-stop">🧑‍💼 Full serious mode</button>
    </div>
  </section>
  <section class="card">
    <div class="eyebrow">React to the last answer</div>
    <div class="buttons">
      <button class="good" data-reaction="trafione">😂 Trafione</button>
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
    <div class="meme-form">
      <div class="meme-fields">
        <input id="memeClue" maxlength="240" placeholder="Clue: when CI is waiting forever">
        <input id="memeTags" maxlength="300" placeholder="Tags: ci, waiting, frustration">
      </div>
      <button id="addMeme" class="neutral">＋ Add image</button>
      <input id="memeFile" type="file" accept="image/png,image/jpeg,image/gif,image/webp">
    </div>
    <div class="meme-grid">
      ${memeCards || '<p class="fine">No local memes yet. Add one with a clue and tags.</p>'}
    </div>
  </section>
  <section class="card stats">
    <span><strong>${profile.hits}</strong> hits</span>
    <span><strong>${profile.misses}</strong> misses</span>
    <span>Last: <strong>${escapeHtml(profile.lastReaction)}</strong></span>
  </section>
  <div class="status" id="status"></div>
  <p class="fine">Profile data: C:\\Dev\\lolpilot · Image cache: C:\\Dev\\lolpilot\\cache\\images</p>

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
    button.addEventListener("click", () => run(() => post("/api/reaction", { reaction: button.dataset.reaction })));
  }
  document.querySelector("#profile").addEventListener("change", (event) =>
    run(() => post("/api/profile/switch", { name: event.target.value })));

  const memeFile = document.querySelector("#memeFile");
  document.querySelector("#addMeme").addEventListener("click", () => memeFile.click());
  memeFile.addEventListener("change", async () => {
    if (!memeFile.files.length) return;
    const file = memeFile.files[0];
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(file);
      });
      await post("/api/meme/import", {
        fileName: file.name,
        mimeType: file.type,
        dataUrl,
        clue: document.querySelector("#memeClue").value,
        tags: document.querySelector("#memeTags").value
      });
      location.reload();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      memeFile.value = "";
    }
  });
  for (const button of document.querySelectorAll("[data-meme-delete]")) {
    button.addEventListener("click", () =>
      run(() => post("/api/meme/delete", { id: button.dataset.memeDelete })));
  }

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
                sendJson(response, await saveActiveProfile(applyReaction(await loadProfile(), body.reaction)));
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
            if (request.method === "POST" && url.pathname === "/api/meme/delete") {
                const body = await readBody(request);
                sendJson(response, await deleteMeme(body.id));
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

await joinSession({
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
                    name: "list_profiles",
                    description: "List saved Lolpilot profiles",
                    handler: async () => ({ active: await getActiveName(), profiles: await listProfiles() }),
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
                                enum: ["trafione", "meh", "humor+", "humor-", "humor-stop", "images-on", "images-rare", "images-off"],
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
            const context = [profileContext(profile)];
            if (profile.images !== "never") {
                const matches = findMemes(await loadMemeIndex(), input.prompt).slice(0, 1);
                if (matches.length) {
                    const meme = matches[0];
                    context.push(`A matching local meme is available: id=${meme.id}; clue="${meme.clue}"; tags=${meme.tags.join(",")}.`);
                }
            }
            return { additionalContext: context.join(" ") };
        },
    },
});
