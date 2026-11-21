import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { CanvasError } from "@github/copilot-sdk/extension";
import { ACTIVE_PROFILE_PATH, ACTIVE_NAME_PATH, PROFILES_DIR } from "./config.mjs";

export const defaultProfile = {
    level: 2,
    images: "rare",
    censorSafe: true,
    emoji: "never",
    lastReaction: "none",
    hits: 0,
    misses: 0,
    ratedTurnId: "",
    styleScores: {},
    suggestPrMemes: false,
};
export function parseStyleScores(value) {
    try {
        const parsed = JSON.parse(String(value || "{}"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? normalizeStyleScores(parsed) : {};
    } catch {
        return {};
    }
}

export function normalizeStyleScores(scores) {
    return Object.fromEntries(Object.entries(scores || {})
        .filter(([key, value]) => /^[a-z][a-z0-9-]{0,31}$/.test(key) && Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Math.max(-20, Math.min(20, Math.round(Number(value))))])
        .slice(0, 24));
}

export function adjustStyleScores(scores, styles, delta) {
    const next = { ...normalizeStyleScores(scores) };
    for (const style of styles) {
        next[style] = Math.max(-20, Math.min(20, (next[style] || 0) + delta));
    }
    return next;
}

export function detectHumorStyles(content) {
    const text = String(content || "");
    const styles = [];
    if (/^[^\n]{1,90}[.!?](\n|$)/.test(text)) styles.push("punchline-first");
    if (/[!?]{1,2}$/.test(text.trim())) styles.push("dry-punch");
    if (/\b(jakby|wygląda|brzmi jak|niczym)\b/i.test(text)) styles.push("absurd-analogy");
    if (/\b(ale|tylko|znowu|spokojnie)\b/i.test(text)) styles.push("callback");
    if (/[😀-🙏🌀-🫿]/u.test(text)) styles.push("emoji");
    if (/\b(as an AI|jako model|jestem asystentem)\b/i.test(text)) styles.push("assistant-speak");
    if (text.length > 700) styles.push("long-explanation");
    if (/\b(podsumowując|należy|powyżej|weryfikacja|funkcjonalność)\b/i.test(text)) styles.push("bureaucratic-tone");
    return styles;
}

export function learnedHumorInstruction(scores) {
    const liked = Object.entries(normalizeStyleScores(scores))
        .filter(([, score]) => score >= 1)
        .sort((left, right) => right[1] - left[1])
        .map(([style]) => style)
        .slice(0, 5);
    const disliked = Object.entries(normalizeStyleScores(scores))
        .filter(([, score]) => score <= -1)
        .sort((left, right) => left[1] - right[1])
        .map(([style]) => style)
        .slice(0, 5);
    return [
        liked.length ? `Amplify learned humor traits: ${liked.join(", ")}.` : "",
        disliked.length ? `Avoid learned humor traits: ${disliked.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
}
export function normalizeName(name) {
    const normalized = String(name || "").trim().replace(/\s+/g, "-");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(normalized)) {
        throw new CanvasError("invalid_profile_name", "Use 1-32 letters, digits, hyphens, or underscores.");
    }
    return normalized;
}

export function profilePath(name) {
    return `${PROFILES_DIR}\\${normalizeName(name)}.md`;
}

export function parseProfile(text) {
    const number = (name, fallback) => {
        const match = text.match(new RegExp(`^- ${name}: (\\d+)$`, "m"));
        return match ? Number(match[1]) : fallback;
    };
    const value = (name, fallback) => {
        const match = text.match(new RegExp(`^- ${name}: (.+)$`, "m"));
        return match?.[1]?.trim() || fallback;
    };
    return {
        level: Math.max(0, Math.min(4, Number.parseInt(value("Level", "2/4"), 10))),
        images: value("Images", "rare"),
        censorSafe: value("Censor-safe", "true").toLowerCase() !== "false",
        emoji: value("Emoji", "never"),
        lastReaction: normalizeReaction(value("Last reaction", "none")),
        hits: number("Hits", 0),
        misses: number("Misses", 0),
        ratedTurnId: value("Rated turn", ""),
        styleScores: parseStyleScores(value("Learned humor", "{}")),
        suggestPrMemes: value("Suggest memes in PRs", "false") === "true",
    };
}

export function profileMarkdown(profile) {
    const learnedHumor = Object.keys(profile.styleScores || {}).length
        ? JSON.stringify(profile.styleScores)
        : "{}";
    return `# Lolpilot profile

- Owner: PC
- Level: ${profile.level}/4
- Images: ${profile.images}
- Censor-safe: ${profile.censorSafe}
- Emoji: ${profile.emoji}
- Last reaction: ${profile.lastReaction}
- Hits: ${profile.hits}
- Misses: ${profile.misses}
- Rated turn: ${profile.ratedTurnId}
- Learned humor: ${learnedHumor}
- Suggest memes in PRs: ${profile.suggestPrMemes}
- Style: concise, playful, technically precise
- Never joke in commits, security findings, production incidents, or when safety is at stake
`;
}

export function normalizeProfile(profile) {
    return {
        level: Math.max(0, Math.min(4, Number(profile.level ?? defaultProfile.level))),
        images: ["rare", "often", "never"].includes(profile.images) ? profile.images : defaultProfile.images,
        censorSafe: profile.censorSafe !== false,
        emoji: profile.emoji === "allowed" ? "allowed" : "never",
        lastReaction: String(profile.lastReaction || "none"),
        hits: Math.max(0, Number(profile.hits) || 0),
        misses: Math.max(0, Number(profile.misses) || 0),
        ratedTurnId: String(profile.ratedTurnId || ""),
        styleScores: normalizeStyleScores(profile.styleScores),
        suggestPrMemes: profile.suggestPrMemes === true,
    };
}

export async function getActiveName() {
    try {
        return normalizeName(await readFile(ACTIVE_NAME_PATH, "utf8"));
    } catch {
        return "default";
    }
}

export async function listProfiles() {
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

export async function loadProfile() {
    try {
        return parseProfile(await readFile(ACTIVE_PROFILE_PATH, "utf8"));
    } catch {
        return { ...defaultProfile };
    }
}

export async function loadNamedProfile(name) {
    try {
        return parseProfile(await readFile(profilePath(name), "utf8"));
    } catch {
        throw new CanvasError("profile_not_found", `Profile "${name}" was not found.`);
    }
}

export async function persistActive(name, profile) {
    const normalizedName = normalizeName(name);
    const normalizedProfile = normalizeProfile(profile);
    const text = profileMarkdown(normalizedProfile);
    await mkdir(PROFILES_DIR, { recursive: true });
    await writeFile(profilePath(normalizedName), text, "utf8");
    await writeFile(ACTIVE_PROFILE_PATH, text, "utf8");
    await writeFile(ACTIVE_NAME_PATH, `${normalizedName}\n`, "utf8");
    return { name: normalizedName, ...normalizedProfile };
}

export async function saveActiveProfile(profile) {
    return persistActive(await getActiveName(), profile);
}

export async function createProfile(name, profile = defaultProfile) {
    const normalizedName = normalizeName(name);
    const names = await listProfiles();
    if (names.some((candidate) => candidate.toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
        throw new CanvasError("profile_exists", `Profile "${normalizedName}" already exists.`);
    }
    const text = profileMarkdown(normalizeProfile(profile));
    await writeFile(profilePath(normalizedName), text, "utf8");
    return { name: normalizedName, ...normalizeProfile(profile) };
}

export function validateImportedProfile(payload) {
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

export async function importProfile(payload, overwrite = false) {
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

export async function switchProfile(name) {
    const normalizedName = normalizeName(name);
    return persistActive(normalizedName, await loadNamedProfile(normalizedName));
}

export async function deleteProfile(name) {
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

export function applyReaction(profile, reaction, turnStyles = []) {
    const normalizedReaction = normalizeReaction(reaction);
    const next = { ...profile, lastReaction: normalizedReaction };
    switch (normalizedReaction) {
        case "hit":
            next.hits += 1;
            next.styleScores = adjustStyleScores(next.styleScores, turnStyles, 1);
            break;
        case "miss":
            next.misses += 1;
            next.styleScores = adjustStyleScores(next.styleScores, turnStyles, -1);
            break;
        case "humor+":
            next.level = Math.min(4, next.level + 1);
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
        case "censor-safe":
            next.censorSafe = true;
            break;
        case "censor-off":
            next.censorSafe = false;
            break;
        case "pr-memes-on":
            next.suggestPrMemes = true;
            break;
        case "pr-memes-off":
            next.suggestPrMemes = false;
            break;
        default:
            throw new CanvasError("invalid_reaction", `Unknown reaction: ${reaction}`);
    }

    return next;
}

export function normalizeReaction(reaction) {
    if (reaction === "trafione") return "hit";
    if (reaction === "meh") return "miss";
    return reaction;
}

export function profileContext(profile) {
    const humorDirection = [
        "Humor is off; use a formal, straightforward, official tone.",
        "Use subtle, mostly situational humor. Keep the voice casual and strictly non-bureaucratic.",
        "Use clear, playful humor in a relaxed human voice. No corporate or bureaucratic phrasing.",
        "Use abstract, absurd, sharp, cutting humor in ordinary conversation and technical answers. Deliver at least one strong punchline when the topic allows it; remain contextual, not offensive, and never bureaucratic.",
        "Start with a sharp punchline or cutting one-liner before any explanation. Use fast internet-forum banter, dark deadpan, absurdity, callbacks, and roast the situation or bad ideas. Avoid corporate-safe phrasing and TED-talk moralizing. A dry bureaucratic answer at this level is a style failure. Never target protected groups, real victims, the user, or current real-world tragedies.",
    ][profile.level];
    return [
        "Lolpilot profile:",
        "This is user-facing chat. Respond normally in the user's language; never return a meme metadata JSON object.",
        "Before choosing humor, infer whether the user's prompt is playful, absurd, banter, urgent, frustrated, or serious. Match and extend that register instead of replacing it with an explanation of the extension.",
        "When the user uses diminutives, character bits, repetitions, or invented playful language, answer inside that scene in a compact way. Do not become managerial or meta-analytical unless asked.",
        "Do not use emoji unless the user explicitly asks for emoji.",
        profile.emoji === "allowed" ? "Emoji may be used only when they improve the joke." : "Keep emoji disabled.",
        learnedHumorInstruction(profile.styleScores),
        `humor level ${profile.level}/4`,
        `image preference: ${profile.images}`,
        `censor-safe mode: ${profile.censorSafe ? "on" : "off"}`,
        `last reaction: ${profile.lastReaction}`,
        humorDirection,
        "Be concise and technically precise after the punchline. When the user is just playing, skip the technical footnote. Never let humor obscure findings, risks, safety, or commits.",
        profile.censorSafe
            ? "Keep profanity, sexual references, slurs, and graphic language out of humor."
            : "Censor-safe mode is off; do not force profanity or spicy language. Choose whatever tone fits the joke, while still avoiding slurs and harassment.",
        "Prefer an image or meme only when image preference allows it and the image materially improves the response.",
    ].join("; ");
}

export function suggestPrMeme(prompt, profile) {
    const text = String(prompt || "").toLowerCase();
    if (!/\b(pr|pull request|merge request)\b/.test(text)) return null;
    const isReview = /\b(review|riwju|code review|sprawdź|sprawdz|zreviewuj)\b/.test(text);
    const isOwn = /\b(create|open|prepare|submit|mojego|mój|my)\b/.test(text);
    if (!profile.suggestPrMemes) return null;
    if (isReview && profile.level < 4) return null;
    if (!isReview && !isOwn) return null;
    const suggestions = [
        { tags: ["refactor", "cleanup"], caption: "PR: trzy linijki zmiany, czternaście komentarzy o architekturze wszechświata" },
        { tags: ["fix", "bug", "ci"], caption: "Naprawiono jeden bug. Pozostałe stworzyły nową partię roboczą." },
        { tags: ["review", "comments"], caption: "Reviewer: małe pytanko / PR: kompletna rozprawa" },
        { tags: ["test", "tests"], caption: "Testy dodane. Nadzieja też." },
    ];
    const matched = suggestions.find((item) => item.tags.some((tag) => text.includes(tag)))
        || { tags: [], caption: "Kolejny PR. Trzydziesta minuta spotkania nr 1." };
    return { prompt: prompt.slice(0, 500), caption: matched.caption, tags: matched.tags };
}

export function prMemeInstructions(pendingPrMeme) {
    if (!pendingPrMeme) return "";
    return [
        "Lolpilot detected a PR review meme suggestion.",
        `Suggested caption: ${pendingPrMeme.caption}`,
        "Use this only at humor level 4/4 and only after the substantive review findings, as an optional P.S. suggestion at the very end.",
        "Never mix the meme into a blocking finding or security/reliability result.",
        "Do not upload, attach, or publish any meme to GitHub without explicit user confirmation in this turn.",
    ].join(" ");
}
