import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

const BUILD_LOADED_AT = new Date().toLocaleString("sv-SE", { timeZoneName: "short" });
const ROOT = "C:\\Dev\\lolpilot";
const ACTIVE_PROFILE_PATH = `${ROOT}\\profile.md`;
const PROFILES_DIR = `${ROOT}\\profiles`;
const ACTIVE_NAME_PATH = `${ROOT}\\active-profile.txt`;
const IMAGE_CACHE_DIR = `${ROOT}\\cache\\images`;
const MEME_INDEX_PATH = `${ROOT}\\cache\\meme-index.json`;
const ANALYSIS_DIR = `${ROOT}\\cache\\analysis`;
const servers = new Map();
const execFileAsync = promisify(execFile);
const analysisWorkers = new Map();
let BUILD_ID = "working-tree";
try {
    const { stdout } = await execFileAsync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
    BUILD_ID = stdout.toString().trim() || BUILD_ID;
} catch {
    // The extension still works if Git is unavailable at runtime.
}

const defaultProfile = {
    level: 2,
    images: "rare",
    censorSafe: true,
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

function imageDimensions(mimeType, bytes) {
    try {
        if (mimeType === "image/png" && bytes.length >= 24) {
            return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
        }
        if (mimeType === "image/gif" && bytes.length >= 10) {
            return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
        }
        if (mimeType === "image/jpeg") {
            let offset = 2;
            while (offset + 9 < bytes.length) {
                if (bytes[offset] !== 0xff) {
                    offset += 1;
                    continue;
                }
                const marker = bytes[offset + 1];
                const length = bytes.readUInt16BE(offset + 2);
                const isSizeMarker = marker >= 0xc0 && marker <= 0xc3;
                if (isSizeMarker && offset + 8 < bytes.length) {
                    return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
                }
                offset += 2 + length;
            }
        }
        if (mimeType === "image/webp" && bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF") {
            const kind = bytes.toString("ascii", 12, 16);
            if (kind === "VP8X") {
                return {
                    width: 1 + bytes.readUIntLE(24, 3),
                    height: 1 + bytes.readUIntLE(27, 3),
                };
            }
        }
    } catch {
        // Dimensions are a quality hint; indexing the image still works without them.
    }
    return { width: 0, height: 0 };
}

function qualityScore(image) {
    const pixels = Number(image.width || 0) * Number(image.height || 0);
    if (pixels > 0) return pixels + Math.min(Number(image.byteSize || 0), 8 * 1024 * 1024) / 1000;
    return Number(image.byteSize || 0);
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
    const dimensions = imageDimensions(mimeType, bytes);
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
        width: dimensions.width,
        height: dimensions.height,
        byteSize: bytes.length,
        tags: normalizeTags(tags),
        clue: String(clue || "").trim().slice(0, 240),
        source: String(source || "local-import").trim().slice(0, 240),
        addedAt: new Date().toISOString(),
        uses: 0,
        analysisStatus: "pending",
    };
    index.images.push(image);
    await saveMemeIndex(index);
    return image;
}

function isPrivateAddress(address) {
    if (address === "::1" || address === "::") return true;
    if (address.includes(":")) {
        const normalized = address.toLowerCase();
        return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8")
            || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
    }
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && (b === 168 || b === 0));
}

async function validateImageUrl(url) {
    const parsed = new URL(String(url || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new CanvasError("invalid_image_url", "Use an http or https image URL.");
    }
    if (parsed.username || parsed.password || parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) {
        throw new CanvasError("invalid_image_url", "Local or credentialed URLs are not allowed.");
    }
    const records = isIP(parsed.hostname)
        ? [{ address: parsed.hostname }]
        : await lookup(parsed.hostname, { all: true });
    if (!records.length || records.some(({ address }) => isPrivateAddress(address))) {
        throw new CanvasError("invalid_image_url", "Private network image URLs are not allowed.");
    }
    return parsed;
}

async function fetchImageUrl(url) {
    let current = await validateImageUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
        const marker = "\n__LOLPILOT_HTTP__\n";
        try {
            const { stdout } = await execFileAsync("curl", [
                "--silent",
                "--show-error",
                "--max-time", "20",
                "--connect-timeout", "10",
                "--max-filesize", String(8 * 1024 * 1024),
                "--max-redirs", "0",
                "--proto", "=http,https",
                "--header", "Accept: image/png,image/jpeg,image/gif,image/webp,text/html;q=0.9",
                "--output", "-",
                "--write-out", `${marker}%{http_code}\n%{content_type}\n%{redirect_url}`,
                current.href,
            ], {
                encoding: "buffer",
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true,
            });
            const markerBytes = Buffer.from(marker);
            const markerIndex = stdout.lastIndexOf(markerBytes);
            if (markerIndex < 0) {
                throw new CanvasError("image_url_failed", "Could not read the image response metadata.");
            }
            const bytes = stdout.subarray(0, markerIndex);
            const metadata = stdout.subarray(markerIndex + markerBytes.length).toString("utf8").split("\n");
            const status = Number(metadata[0]);
            const mimeType = metadata[1]?.split(";")[0].trim().toLowerCase();
            const redirectUrl = metadata.slice(2).join("\n").trim();
            if (status >= 300 && status < 400) {
                if (!redirectUrl) {
                    throw new CanvasError("image_url_failed", "Image redirect is missing a destination.");
                }
                current = await validateImageUrl(new URL(redirectUrl, current).href);
                continue;
            }
            return { status, mimeType, bytes, parsed: current };
        } catch (error) {
            if (error instanceof CanvasError) throw error;
            const detail = String(error?.stderr || error?.message || "Image download failed.")
                .replace(/\s+/g, " ").slice(0, 240);
            throw new CanvasError("image_url_failed", detail);
        }
    }
    throw new CanvasError("image_url_failed", "Image URL redirected too many times.");
}

async function addMemeFromUrl(url) {
    let response = await fetchImageUrl(url);
    let { parsed, mimeType } = response;
    const sourceUrl = parsed.href;
    if (mimeType === "text/html") {
        if (response.bytes.length > 1024 * 1024) {
            throw new CanvasError("image_page_too_large", "The page is too large to inspect for an image.");
        }
        const html = response.bytes.toString("utf8");
        const candidates = [
            html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i),
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i),
            html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i),
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i),
        ];
        const imageUrl = candidates.find(Boolean)?.[1]?.replaceAll("&amp;", "&");
        if (!imageUrl) {
            throw new CanvasError("image_not_found", "The page does not advertise an image in og:image or twitter:image.");
        }
        response = await fetchImageUrl(new URL(imageUrl, parsed).href);
        ({ parsed, mimeType } = response);
    }
    if (response.status < 200 || response.status >= 300) {
        throw new CanvasError("image_url_failed", `Image URL returned HTTP ${response.status}.`);
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
        throw new CanvasError("invalid_image_type", "The URL does not point to PNG, JPEG, GIF, or WebP.");
    }
    const bytes = response.bytes;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        throw new CanvasError("invalid_image_size", "Image size must be between 1 byte and 8 MiB.");
    }
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() || "meme");
    return addMeme({
        fileName,
        mimeType,
        dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
        source: sourceUrl,
    });
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

async function updateMeme(id, changes) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    Object.assign(image, changes, { updatedAt: new Date().toISOString() });
    await saveMemeIndex(index);
    return image;
}

async function syncAnalysisResults() {
    await mkdir(ANALYSIS_DIR, { recursive: true });
    let changed = 0;
    for (const name of await readdir(ANALYSIS_DIR)) {
        if (!name.endsWith(".json")) continue;
        if (await syncAnalysisResult(name.slice(0, -5))) changed += 1;
    }
    return changed;
}

async function syncAnalysisResult(id) {
    const path = `${ANALYSIS_DIR}\\${id}.json`;
    try {
        const raw = await readFile(path, "utf8");
        const result = JSON.parse(raw.replace(/^\uFEFF/, ""));
        if (result.id !== id) throw new Error("Analysis result id does not match the queued meme.");
        await storeMemeAnalysis(id, JSON.stringify(result));
        await unlink(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        await updateMeme(id, {
            analysisStatus: "needs-review",
            analysisError: String(error?.message || error).slice(0, 240),
        }).catch(() => {});
        return false;
    }
}

function curatorPrompt(image) {
    const outputPath = `${ANALYSIS_DIR}\\${image.id}.json`;
    return [
        "You are Lolpilot Meme Curator, a specialist in meme templates, visual reactions, pop culture, workplace humor, software engineering, and internet culture.",
        "Do not modify the Lolpilot extension or repository code.",
        `Inspect the local image at "${IMAGE_CACHE_DIR}\\${image.file}" with vision.`,
        "Identify the common template name if recognizable; otherwise use Unknown template.",
        "Describe only visual evidence. Do not infer sensitive personal traits, identity, health, or ownership.",
        "Write exactly one JSON object to this absolute output path:",
        `"${outputPath}"`,
        "Required shape: { template, templateAliases, visualDescription, emotion, tone, captionRules, tags, confidence, id }.",
        `Set id to "${image.id}".`,
        "templateAliases is at most 5 strings; tone at most 5; captionRules at most 8; tags at most 16; confidence is 0..1.",
        "Return no conversational reply beyond confirming the file was written.",
    ].join(" ");
}

function findCopilotCli() {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    const packageRoot = join(localAppData, "copilot", "pkg", process.platform === "win32" ? "win32-x64" : "linux-x64");
    try {
        const versions = readdirSync(packageRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
            .reverse();
        for (const version of versions) {
            const entry = join(packageRoot, version, "cli-main.js");
            if (existsSync(entry)) return entry;
        }
    } catch {
        return null;
    }
    return null;
}

async function analyzeMeme(id) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    if (image.analysisStatus === "analyzing") return image;
    await updateMeme(id, { analysisStatus: "analyzing" });
    const cli = findCopilotCli();
    if (!cli) {
        await updateMeme(id, {
            analysisStatus: "needs-review",
            analysisError: "Local Copilot CLI worker is unavailable.",
        });
        throw new CanvasError("curator_unavailable", "Local Copilot CLI worker is unavailable.");
    }
    try {
        if (analysisWorkers.has(id)) return { ...image, analysisStatus: "analyzing" };
        const child = execFile("node", [
            cli,
            `--prompt=${curatorPrompt(image)}`,
            "--silent",
            "--allow-all-tools",
            "--trust-folder",
            "--model=auto",
            `--name=Lolpilot-Meme-Curator-${id}`,
            "--disable-client-telemetry",
        ], {
            cwd: ROOT,
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024,
            timeout: 240000,
        }, async (error, stdout, stderr) => {
            analysisWorkers.delete(id);
            const output = `${stdout || ""}\n${stderr || ""}`.trim().slice(0, 240);
            try {
                const consumed = await syncAnalysisResult(id);
                if (!consumed) {
                    await updateMeme(id, {
                        analysisStatus: "needs-review",
                        analysisError: error?.message || output || "Curator finished without writing an analysis file.",
                    });
                }
            } catch (syncError) {
                await updateMeme(id, {
                    analysisStatus: "needs-review",
                    analysisError: String(syncError?.message || syncError).slice(0, 240),
                }).catch(() => {});
            }
        });
        analysisWorkers.set(id, child);
        return { ...image, analysisStatus: "analyzing", workerPid: child.pid || undefined };
    } catch (error) {
        await updateMeme(id, {
            analysisStatus: "needs-review",
            analysisError: String(error?.message || "Meme analysis failed.").slice(0, 240),
        });
        throw error;
    }
}

function parseAnalysisContent(content) {
    const text = String(content || "").trim();
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    }
}

async function storeMemeAnalysis(id, content) {
    const result = parseAnalysisContent(content);
    const confidence = Number(result?.confidence);
    if (!result || !Number.isFinite(confidence)) {
        throw new Error("The analysis result did not contain a valid confidence value.");
    }
    const analyzed = await updateMeme(id, {
        template: String(result.template || "Unknown template").slice(0, 120),
        templateAliases: (result.templateAliases || []).map((value) => String(value).slice(0, 120)).slice(0, 5),
        visualDescription: String(result.visualDescription || "").slice(0, 500),
        emotion: String(result.emotion || "").slice(0, 80),
        tone: (result.tone || []).map((value) => String(value).slice(0, 60)).slice(0, 5),
        captionRules: (result.captionRules || []).map((value) => String(value).slice(0, 180)).slice(0, 8),
        tags: normalizeTags((result.tags || []).join(",")),
        confidence,
        analysisStatus: confidence < 0.55 ? "needs-review" : "analyzed",
        analysisError: "",
    });
    const index = await loadMemeIndex();
    const sameTemplate = index.images.find((image) =>
        image.id !== analyzed.id
        && image.template
        && analyzed.template.toLocaleLowerCase() !== "unknown template"
        && image.template.toLocaleLowerCase() === analyzed.template.toLocaleLowerCase()
    );
    if (sameTemplate) {
        return updateMeme(id, {
            duplicateOf: sameTemplate.id,
            replacementSuggested: qualityScore(analyzed) > qualityScore(sameTemplate),
            analysisStatus: "needs-review",
            analysisError: `Similar template already exists: ${sameTemplate.template}.`,
        });
    }
    return analyzed;
}

async function replaceMeme(existingId, replacementId) {
    const index = await loadMemeIndex();
    const existing = index.images.find((image) => image.id === existingId);
    const replacement = index.images.find((image) => image.id === replacementId);
    if (!existing || !replacement) throw new CanvasError("meme_not_found", "Replacement record was not found.");
    const mergedTags = [...new Set([...(existing.tags || []), ...(replacement.tags || [])])];
    await unlink(`${IMAGE_CACHE_DIR}\\${existing.file}`);
    index.images = index.images.filter((image) => image.id !== existingId);
    replacement.templateAliases = [...new Set([
        ...(replacement.templateAliases || []),
        existing.template,
        ...(existing.templateAliases || []),
    ].filter(Boolean))].slice(0, 8);
    replacement.tags = mergedTags;
    replacement.duplicateOf = "";
    replacement.replacementSuggested = false;
    replacement.analysisStatus = replacement.confidence < 0.55 ? "needs-review" : "analyzed";
    await saveMemeIndex(index);
    return replacement;
}

async function analyzePendingMemes() {
    const pending = (await loadMemeIndex()).images.filter((image) =>
        ["pending", "needs-review"].includes(image.analysisStatus)
    );
    const results = [];
    for (const image of pending) {
        try {
            results.push(await analyzeMeme(image.id));
        } catch (error) {
            results.push({ id: image.id, analysisStatus: "needs-review", error: String(error?.message || error) });
        }
    }
    return results;
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
        censorSafe: value("Censor-safe", "true").toLowerCase() !== "false",
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
- Censor-safe: ${profile.censorSafe}
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
        censorSafe: profile.censorSafe !== false,
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
        case "censor-safe":
            next.censorSafe = true;
            break;
        case "censor-off":
            next.censorSafe = false;
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
        `censor-safe mode: ${profile.censorSafe ? "on" : "off"}`,
        `last reaction: ${profile.lastReaction}`,
        "Be concise and technically precise. Never let humor obscure findings, risks, safety, or commits.",
        profile.censorSafe
            ? "Keep profanity, sexual references, slurs, and graphic language out of humor."
            : "Censor-safe mode is off; do not force profanity or spicy language. Choose whatever tone fits the joke, while still avoiding slurs and harassment.",
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
      <button class="meme-card ${image.analysisStatus === "analyzing" ? "analyzing" : ""}"
        data-status="${escapeHtml(image.analysisStatus)}"
        data-meme-id="${escapeHtml(image.id)}" data-meme='${escapeHtml(JSON.stringify(image))}'>
        <span class="status-dot status-${escapeHtml(image.analysisStatus)}"
          title="${escapeHtml(image.analysisStatus)}" aria-label="${escapeHtml(image.analysisStatus)}"></span>
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
    .censor-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 13px;
      padding: 10px 12px; border: 2px solid ${profile.censorSafe ? "#16a34a" : "#dc2626"};
      border-radius: 6px; background: ${profile.censorSafe ? "#16a34a18" : "#dc26261a"}; }
    .censor-copy strong, .censor-copy small { display: block; }
    .censor-copy small { color: var(--lp-muted); }
    .censor-switch { position: relative; width: 58px; height: 30px; min-height: 30px; flex: 0 0 auto; padding: 0;
      overflow: hidden; border-radius: 999px;
      border: 2px solid ${profile.censorSafe ? "#16a34a" : "#dc2626"};
      background: ${profile.censorSafe ? "#16a34a" : "#dc2626"}; }
    .censor-switch::after { content: ""; position: absolute; top: 3px; left: ${profile.censorSafe ? "29px" : "3px"};
      width: 20px; height: 20px; border-radius: 50%; background: white; transition: left .15s ease; }
    .censor-status { font-weight: 800; color: ${profile.censorSafe ? "#16a34a" : "#dc2626"}; }
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
    .library-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 8px; }
    .library-summary button { min-width: 150px; }
    .library-page { display: none; }
    body.library-open main { max-width: none; }
    body.library-open > main > .brand, body.library-open > main > .profile-card { display: none; }
    body.library-open .control-page { display: none; }
    body.library-open .library-page { display: block; }
    body.library-open .library-page > .card { margin: 0; }
    .library-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .library-header h2 { margin: 0; flex: 1; }
    .library-filters { display: grid; grid-template-columns: auto 170px minmax(160px, 1fr) auto; align-items: center;
      gap: 8px; margin-bottom: 10px; }
    .library-filters select { width: auto; min-width: 170px; }
    .meme-detail { max-width: min(620px, calc(100vw - 28px)); }
    .meme-detail img { display: block; width: 100%; max-height: 55vh; object-fit: contain; border-radius: 5px; background: #000; }
    .meme-detail dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 7px 12px; }
    .meme-detail dt { color: var(--lp-muted); }
    .meme-detail dd { margin: 0; overflow-wrap: anywhere; }
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
      .add-menu { grid-template-columns: 1fr; }
      .meme-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .library-filters { grid-template-columns: 1fr; }
      .library-filters select { width: 100%; }
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
      <div class="meter">${levels.slice(1).map((_, index) => `<div class="bar ${index < profile.level ? "on" : ""}"></div>`).join("")}</div>
      <strong>${profile.level}/3</strong>
    </div>
    <div class="buttons">
      <button class="cool" data-reaction="humor-">🧊 Dial it down</button>
      <button class="hot" data-reaction="humor+">🔥 More chaos</button>
      <button class="neutral wide" data-reaction="humor-stop">🧑‍💼 Full serious mode</button>
    </div>
    <div class="censor-toggle">
      <div class="censor-copy">
        <strong>Censor-safe</strong>
        <small class="censor-status">${profile.censorSafe ? "ON · clean mode" : "OFF · flexible mode"}</small>
      </div>
      <button class="censor-switch" data-reaction="${profile.censorSafe ? "censor-off" : "censor-safe"}"
        role="switch" aria-checked="${profile.censorSafe}" aria-label="Censor-safe"></button>
    </div>
  </section>
  <section class="card">
    <div class="eyebrow">React to the last answer</div>
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
    <span>Last: <strong>${escapeHtml(profile.lastReaction)}</strong></span>
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
    <div class="library-filters">
      <label for="statusFilter">Status</label>
      <select id="statusFilter">
        <option value="all">All</option>
        <option value="analyzed">Analyzed</option>
        <option value="needs-review">Needs review</option>
        <option value="analyzing">Analyzing</option>
        <option value="pending">Pending</option>
      </select>
      <input id="memeSearch" type="search" placeholder="Search template, tags, emotion…">
      <span id="filterCount" class="fine"></span>
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
      <div class="meme-grid">
        ${memeCards || '<p class="fine">No local memes yet.</p>'}
      </div>
    </section>
  </div>

  <dialog id="memeDetail" class="meme-detail">
    <img id="detailImage" alt="">
    <h2 id="detailTitle"></h2>
    <dl id="detailData"></dl>
    <div class="dialog-actions">
      <button type="button" id="closeMemeDetail">Close</button>
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
  let memeSignature = "";
  async function refreshMemeStatus() {
    try {
      const response = await fetch("/api/memes/status", { cache: "no-store" });
      if (!response.ok) return;
      const state = await response.json();
      if (memeSignature && state.signature !== memeSignature) location.assign("?view=library");
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
    document.querySelector("#filterCount").textContent =
      visible + " of " + cards.length + " shown";
  }
  statusFilter.addEventListener("change", filterLibrary);
  memeSearch.addEventListener("input", filterLibrary);
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
    button.addEventListener("click", () => run(() => post("/api/reaction", { reaction: button.dataset.reaction })));
  }
  document.querySelector("#profile").addEventListener("change", (event) =>
    run(() => post("/api/profile/switch", { name: event.target.value })));

  async function importMemeResult(result) {
    status.textContent = "Imported. Agent analysis will run next.";
    await post("/api/meme/analyze", { id: result.id });
    location.assign("?view=library");
  }

  const memeFile = document.querySelector("#memeFile");
  const memeStatus = document.querySelector("#memeStatus");
  const addButton = document.querySelector("#addMeme");
  const addMenu = document.querySelector("#addMenu");
  addButton.addEventListener("click", () => addMenu.classList.toggle("open"));
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
      const result = await post("/api/meme/import", {
        fileName: file.name,
        mimeType: file.type,
        dataUrl
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
  let selectedMeme;
  for (const button of document.querySelectorAll("[data-meme-id]")) {
    button.addEventListener("click", () => {
      selectedMeme = JSON.parse(button.dataset.meme);
      const image = document.querySelector("#detailImage");
      image.src = "/api/meme/image?id=" + encodeURIComponent(selectedMeme.id);
      image.alt = selectedMeme.template || selectedMeme.file;
      document.querySelector("#detailTitle").textContent = selectedMeme.template || "Awaiting analysis";
      const rows = [
        ["Status", selectedMeme.analysisStatus],
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
  deleteMemeButton.addEventListener("click", () =>
    selectedMeme && run(() => post("/api/meme/delete", { id: selectedMeme.id })));

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
            if (request.method === "POST" && url.pathname === "/api/meme/import-url") {
                const body = await readBody(request);
                sendJson(response, await addMemeFromUrl(body.url));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/meme/analyze") {
                const body = await readBody(request);
                sendJson(response, await analyzeMeme(body.id));
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
                                enum: ["trafione", "meh", "humor+", "humor-", "humor-stop", "images-on", "images-rare", "images-off", "censor-safe", "censor-off"],
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
