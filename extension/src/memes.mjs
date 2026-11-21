import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { CanvasError } from "@github/copilot-sdk/extension";
import { ROOT, ANALYSIS_DIR, IMAGE_CACHE_DIR, MEME_INDEX_PATH } from "./config.mjs";

const analysisWorkers = new Map();
const MAX_ANALYSIS_WORKERS = 3;
const execFileAsync = promisify(execFile);
export let LAST_INDEX_RECOVERY = false;
export async function loadMemeIndex() {
    try {
        const parsed = JSON.parse(await readFile(MEME_INDEX_PATH, "utf8"));
        LAST_INDEX_RECOVERY = false;
        return {
            version: 1,
            images: Array.isArray(parsed.images) ? parsed.images : [],
        };
    } catch (error) {
        const recovered = await restoreMemeIndexBackup();
        if (recovered) {
            LAST_INDEX_RECOVERY = true;
            return recovered;
        }
        return { version: 1, images: [] };
    }
}

export async function backupMemeIndex() {
    const backupDirectory = `${IMAGE_CACHE_DIR}\\..\\backups`;
    await mkdir(backupDirectory, { recursive: true });
    try {
        const existing = await readFile(MEME_INDEX_PATH, "utf8");
        JSON.parse(existing);
        const files = (await readdir(backupDirectory))
            .filter((name) => /^meme-index-.*\.json$/.test(name))
            .sort()
            .reverse();
        if (files.length) {
            const newestPath = `${backupDirectory}\\${files[0]}`;
            const newest = await readFile(newestPath, "utf8");
            if (newest === existing) return;
            const age = Date.now() - (await stat(newestPath)).mtimeMs;
            if (age >= 0 && age < 6 * 60 * 60 * 1000) return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        await writeFile(`${backupDirectory}\\meme-index-${timestamp}.json`, existing, "utf8");
        for (const name of files.slice(13)) {
            await unlink(`${backupDirectory}\\${name}`);
        }
        return true;
    } catch (error) {
        if (error?.code !== "ENOENT") {
            return 0;
        }
    }
}

async function restoreMemeIndexBackup() {
    const backupDirectory = `${IMAGE_CACHE_DIR}\\..\\backups`;
    try {
        const files = (await readdir(backupDirectory))
            .filter((name) => /^meme-index-.*\.json$/.test(name))
            .sort()
            .reverse();
        for (const file of files) {
            try {
                const parsed = JSON.parse(await readFile(`${backupDirectory}\\${file}`, "utf8"));
                if (Array.isArray(parsed.images)) {
                    await writeFile(MEME_INDEX_PATH, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
                    return parsed;
                }
            } catch {
                continue;
            }
        }
    } catch {
        return null;
    }
    return null;
}

export async function saveMemeIndex(index) {
    await backupMemeIndex();
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    await writeFile(MEME_INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
}

export function normalizeTags(tags) {
    return [...new Set(String(tags || "")
        .split(/[,#\n]/)
        .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, "-"))
        .filter(Boolean))]
        .slice(0, 24);
}
export function imageDimensions(mimeType, bytes) {
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

export function qualityScore(image) {
    const pixels = Number(image.width || 0) * Number(image.height || 0);
    if (pixels > 0) return pixels + Math.min(Number(image.byteSize || 0), 8 * 1024 * 1024) / 1000;
    return Number(image.byteSize || 0);
}

function perceptualDistance(left, right) {
    if (!left?.perceptualHash || !right?.perceptualHash
        || left.perceptualHash.length !== right.perceptualHash.length) return Number.POSITIVE_INFINITY;
    let distance = 0;
    for (let index = 0; index < left.perceptualHash.length; index += 1) {
        if (left.perceptualHash[index] !== right.perceptualHash[index]) distance += 1;
    }
    return distance;
}

export async function addMeme({
    fileName, mimeType, dataUrl, tags, clue, source = "local-import", perceptualHash = ""
}) {
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
        if (perceptualHash && !existing.perceptualHash) existing.perceptualHash = perceptualHash;
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
        perceptualHash: /^[01]{256}$/.test(perceptualHash) ? perceptualHash : "",
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

export async function replaceMemeImage(id, {
    fileName, mimeType, dataUrl
}) {
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType)) {
        throw new CanvasError("invalid_image_type", "Use PNG, JPEG, GIF, or WebP.");
    }
    const match = String(dataUrl || "").match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new CanvasError("invalid_image", "The selected image could not be read.");
    const bytes = Buffer.from(match[1], "base64");
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
        throw new CanvasError("invalid_image_size", "Image size must be between 1 byte and 8 MiB.");
    }
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash === image.hash) return image;
    const duplicate = index.images.find((candidate) => candidate.id !== id && candidate.hash === hash);
    if (duplicate) {
        throw new CanvasError("image_already_exists", `This image is already stored as ${duplicate.template || duplicate.file}.`);
    }
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mimeType];
    const dimensions = imageDimensions(mimeType, bytes);
    const safeBase = String(fileName || image.template || "meme").replace(/\.[^.]+$/, "")
        .replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "meme";
    const nextFile = `${safeBase}-${id}-${hash.slice(0, 8)}.${extension}`;
    const previousFile = image.file;
    const archivedImage = {
        file: previousFile,
        mimeType: image.mimeType,
        hash: image.hash,
        width: image.width,
        height: image.height,
        byteSize: image.byteSize,
        archivedAt: new Date().toISOString(),
    };
    await mkdir(IMAGE_CACHE_DIR, { recursive: true });
    await writeFile(`${IMAGE_CACHE_DIR}\\${nextFile}`, bytes);
    Object.assign(image, {
        file: nextFile,
        mimeType,
        hash,
        width: dimensions.width,
        height: dimensions.height,
        byteSize: bytes.length,
        perceptualHash: "",
        imageHistory: [...(image.imageHistory || []), archivedImage],
        updatedAt: new Date().toISOString(),
    });
    await saveMemeIndex(index);
    return image;
}

export function isPrivateAddress(address) {
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

export async function validateImageUrl(url) {
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

export async function fetchImageUrl(url) {
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

export async function addMemeFromUrl(url) {
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

export function findMemes(index, query) {
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

export async function deleteMeme(id) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    await unlink(`${IMAGE_CACHE_DIR}\\${image.file}`);
    index.images = index.images.filter((candidate) => candidate.id !== id);
    await saveMemeIndex(index);
    return { deleted: id };
}

export async function updateMeme(id, changes) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    Object.assign(image, changes, { updatedAt: new Date().toISOString() });
    await saveMemeIndex(index);
    return image;
}

export async function setMemeGuidance(id, input) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    const guidance = String(input.guidance || "").trim().slice(0, 2000);
    if (guidance) image.usageHints = guidance;
    else image.usageHints = "";
    image.captionRules = [...new Set([
        ...(image.captionRules || []).filter((rule) =>
            !String(rule).startsWith("User usage guidance:")
        ),
        ...(guidance ? [`User usage guidance: ${guidance}`] : []),
    ])].slice(-12);
    image.updatedAt = new Date().toISOString();
    await saveMemeIndex(index);
    return image;
}

export async function syncAnalysisResults() {
    await mkdir(ANALYSIS_DIR, { recursive: true });
    let changed = 0;
    for (const name of await readdir(ANALYSIS_DIR)) {
        if (!name.endsWith(".json")) continue;
        if (await syncAnalysisResult(name.slice(0, -5))) changed += 1;
    }
    return changed;
}

export async function syncAnalysisResult(id) {
    const path = `${ANALYSIS_DIR}\\${id}.json`;
    let resultId = id;
    try {
        const raw = await readFile(path, "utf8");
        const result = JSON.parse(raw.replace(/^\uFEFF/, ""));
        resultId = String(result.id || "").trim();
        if (!resultId) throw new Error("Analysis result id is missing.");
        const index = await loadMemeIndex();
        if (!index.images.some((image) => image.id === resultId)) {
            throw new Error("Analysis result id does not match a known meme.");
        }
        await storeMemeAnalysis(resultId, JSON.stringify(result));
        await unlink(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        await updateMeme(resultId, {
            analysisStatus: "needs-review",
            analysisError: String(error?.message || error).slice(0, 240),
        }).catch(() => {});
        return false;
    }
}

export async function recoverAnalysisState() {
    const index = await loadMemeIndex();
    let changed = false;
    for (const image of index.images) {
        const duplicate = image.duplicateOf
            ? index.images.find((candidate) => candidate.id === image.duplicateOf)
            : null;
        if (duplicate && image.analysisStatus === "duplicate") {
            const names = [image.template, ...(image.templateAliases || [])].filter(Boolean)
                .map((value) => value.toLocaleLowerCase());
            const duplicateNames = [duplicate.template, ...(duplicate.templateAliases || [])].filter(Boolean)
                .map((value) => value.toLocaleLowerCase());
            const sameName = names.some((name) => duplicateNames.includes(name));
            const visuallyClose = perceptualDistance(image, duplicate) <= 8;
            if (!sameName && !visuallyClose) {
                image.duplicateOf = "";
                image.replacementSuggested = false;
                image.analysisStatus = Number(image.confidence || 0) >= 0.55 ? "analyzed" : "needs-review";
                image.analysisError = "";
                changed = true;
                continue;
            }
        }
        if (image.duplicateOf && image.analysisStatus === "needs-review") {
            image.analysisStatus = "duplicate";
            changed = true;
        }
        if (image.analysisStatus === "analyzing") {
            if (image.template && Number(image.confidence || 0) >= 0.55) {
                image.analysisStatus = image.duplicateOf ? "duplicate" : "analyzed";
                image.analysisError = "";
            } else {
                image.analysisStatus = "pending";
                image.analysisError = "Recovered after extension reload.";
            }
            changed = true;
        } else if (
            image.analysisStatus === "pending"
            && image.analysisError === "Recovered after extension reload."
            && image.template
            && Number(image.confidence || 0) >= 0.55
        ) {
            image.analysisStatus = image.duplicateOf ? "duplicate" : "analyzed";
            image.analysisError = "";
            changed = true;
        } else if (
            image.analysisStatus === "needs-review"
            && !image.duplicateOf
            && image.template
            && Number(image.confidence || 0) >= 0.55
        ) {
            image.analysisStatus = "analyzed";
            image.analysisError = "";
            changed = true;
        }
    }
    if (changed) await saveMemeIndex(index);
    return index.images.filter((image) => image.analysisStatus === "pending").length;
}

export function curatorPrompt(image) {
    const outputPath = `${ANALYSIS_DIR}\\${image.id}.json`;
    return [
        "You are Lolpilot Meme Curator, a specialist in meme templates, visual reactions, pop culture, workplace humor, software engineering, and internet culture.",
        "Do not modify the Lolpilot extension or repository code.",
        `Inspect the local image at "${IMAGE_CACHE_DIR}\\${image.file}" with vision.`,
        image.analysisHint
            ? `The user suggested this identity hint: "${String(image.analysisHint).replaceAll('"', "'")}". Treat it as a hypothesis to verify, not a fact.`
            : "",
        "Identify the common template name if recognizable; otherwise use Unknown template.",
        "Describe only visual evidence. Do not infer sensitive personal traits, identity, health, or ownership.",
        "Write exactly one JSON object to this absolute output path:",
        `"${outputPath}"`,
        "Required shape: { template, templateAliases, visualDescription, emotion, tone, captionRules, tags, confidence, id }.",
        "Also include captionZones: normalized text box regions with id, role, captionHint, x, y, w, h where 0..1 are fractions of image width/height.",
        "For each captionHint describe the joke shape normally used there, such as setup, rejection, escalation, punchline, bad option, tempting option, observation, or sarcastic reply.",
        `Set id to "${image.id}".`,
        "templateAliases is at most 5 strings; tone at most 5; captionRules at most 8; tags at most 16; confidence is 0..1.",
        "Return no conversational reply beyond confirming the file was written.",
    ].join(" ");
}

export function curatorExamplePrompt(image, referenceHint = "") {
    const hasCaptionZones = Array.isArray(image.captionZones) && image.captionZones.length > 0;
    return [
        "Analyze this completed meme as a visual/caption reference for an existing template.",
        `Target template: "${image.template || "Unknown template"}".`,
        hasCaptionZones
            ? "The target template already has authoritative captionZones. Do not return replacement captionZones or captionHint values."
            : "Extract exact caption placement as normalized captionZones with id, role, captionHint, x, y, w, h.",
        "Infer the humor pattern from the visible wording: irony, deadpan, absurdity, wordplay, self-deprecation, escalation, reversal, overreaction, sarcasm, callback, or other concise tone tags.",
        "Return exampleCaptions with texts in reading order, locale, and note describing the rhythm/structure.",
        "Return tone and captionRules to merge with the target template. Keep facts separate from confidence.",
        "Also return tags, emotion, and visualDescription when supported by the reference image; these may fill fields that are currently empty.",
        referenceHint ? `Reference note: "${String(referenceHint).replaceAll('"', "'")}".` : "",
        `Set id to "${image.id}".`,
    ].filter(Boolean).join(" ");
}

export function curatorCaptionZonesPrompt(image) {
    const outputPath = `${ANALYSIS_DIR}\\${image.id}.json`;
    return [
        "Analyze only the caption placement for this meme template.",
        `Inspect the local image at "${IMAGE_CACHE_DIR}\\${image.file}" with vision.`,
        "Return captionZones as normalized text box regions with id, role, captionHint, x, y, w, h.",
        "Each coordinate is a fraction of the image width or height and each box must surround an intended caption area.",
        "For captionHint, describe the joke function used in that position, not proposed caption text.",
        "Do not return template, templateAliases, exampleCaptions, visualDescription, emotion, tone, tags, or captionRules.",
        "Return confidence as a number from 0 to 1 and set the id exactly.",
        `Set id to "${image.id}".`,
        `Write exactly one JSON object to this absolute output path: "${outputPath}".`,
    ].join(" ");
}

export function findCopilotCli() {
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

export async function analyzeMeme(id, hint = "", boxesOnly = false) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    if (image.analysisStatus === "analyzing") return image;
    const analysisHint = boxesOnly ? "Caption zone analysis only" : String(hint || "").slice(0, 500);
    await updateMeme(id, { analysisStatus: "analyzing", analysisHint });
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
            `--prompt=${boxesOnly
                ? curatorCaptionZonesPrompt(image)
                : curatorPrompt({ ...image, analysisHint: hint || image.analysisHint })}`,
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
            setTimeout(drainAnalysisQueue, 500);
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

export async function analyzeMemeExample(id, input) {
    const image = (await loadMemeIndex()).images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    const temporaryId = `${id}-example-${Date.now()}`;
    const match = String(input.dataUrl || "").match(/^data:[^;]+;base64,(.+)$/);
    if (!match) throw new CanvasError("invalid_image", "The reference image could not be read.");
    const bytes = Buffer.from(match[1], "base64");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[input.mimeType];
    if (!extension) throw new CanvasError("invalid_image_type", "Use PNG, JPEG, GIF, or WebP.");
    await mkdir(ANALYSIS_DIR, { recursive: true });
    const referencePath = `${ANALYSIS_DIR}\\${temporaryId}.${extension}`;
    await writeFile(referencePath, bytes);
    await updateMeme(id, {
        analysisStatus: "analyzing",
        analysisHint: `Reference image supplied at ${referencePath}`,
    });
    const cli = findCopilotCli();
    if (!cli) throw new CanvasError("curator_unavailable", "Local Copilot CLI worker is unavailable.");
    const prompt = curatorExamplePrompt(image) +
        ` Inspect the supplied reference image attachment and write the result JSON to ` +
        `${ANALYSIS_DIR}\\${id}.json`;
    const child = execFile("node", [
        cli,
        `--prompt=${prompt}`,
        "--silent",
        "--allow-all-tools",
        "--trust-folder",
        "--model=auto",
        `--attachment=${referencePath}`,
        `--name=Lolpilot-Meme-Example-${id}`,
        "--disable-client-telemetry",
    ], {
        cwd: ROOT,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 240000,
    }, async (error, stdout, stderr) => {
        try {
            const consumed = await syncAnalysisResult(id);
            if (!consumed) {
                await updateMeme(id, {
                    analysisStatus: "needs-review",
                    analysisError: error?.message || `${stdout || ""}\n${stderr || ""}`.trim().slice(0, 240),
                });
            }
        } finally {
            await unlink(referencePath).catch(() => {});
        }
    });
    return { id, analysisStatus: "analyzing", workerPid: child.pid || undefined };
}

export async function analyzeMemeExampleFromUrl(id, url) {
    const parsed = await fetchImageUrl(url);
    if (parsed.status < 200 || parsed.status >= 300) {
        throw new CanvasError("image_url_failed", `Reference URL returned HTTP ${parsed.status}.`);
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(parsed.mimeType)) {
        throw new CanvasError("invalid_image_type", "The reference URL must point to PNG, JPEG, GIF, or WebP.");
    }
    return analyzeMemeExample(id, {
        fileName: parsed.parsed.pathname.split("/").pop() || "reference",
        mimeType: parsed.mimeType,
        dataUrl: `data:${parsed.mimeType};base64,${parsed.bytes.toString("base64")}`,
    });
}

export function parseAnalysisContent(content) {
    const text = String(content || "").trim();
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    }
}

export async function storeMemeAnalysis(id, content) {
    const result = parseAnalysisContent(content);
    if (!result) {
        throw new Error("The analysis result did not contain valid JSON.");
    }
    const existing = (await loadMemeIndex()).images.find((image) => image.id === id);
    if (!existing) throw new CanvasError("meme_not_found", "Meme not found.");
    const referenceAnalysis = String(existing.analysisHint || "").startsWith("Reference image supplied at ");
    const confidenceValues = typeof result.confidence === "object" && result.confidence
        ? Object.values(result.confidence).map(Number).filter(Number.isFinite)
        : [Number(result.confidence)];
    const preferredConfidence = typeof result.confidence === "object" && result.confidence
        ? Number(result.confidence.overall ?? result.confidence.targetTemplate)
        : Number(result.confidence);
    const confidence = Number.isFinite(preferredConfidence)
        ? preferredConfidence
        : confidenceValues.length
            ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
            : referenceAnalysis && Number.isFinite(Number(existing.confidence))
                ? Number(existing.confidence)
                : Number.NaN;
    if (!Number.isFinite(confidence)) {
        throw new Error("The analysis result did not contain a valid confidence value.");
    }
    const preserveExistingZones = String(existing.analysisHint || "").startsWith("Reference image supplied at ")
        && Array.isArray(existing.captionZones) && existing.captionZones.length > 0;
    const captionZonesOnly = existing.analysisHint === "Caption zone analysis only";
    if (captionZonesOnly) {
        if (!Array.isArray(result.captionZones) || !result.captionZones.length) {
            throw new Error("The caption zone analysis did not return any zones.");
        }
        return updateMeme(id, {
            captionZones: result.captionZones.map((zone, index) => ({
                id: String(zone.id || `zone-${index + 1}`).slice(0, 40),
                role: String(zone.role || `text-${index + 1}`).slice(0, 80),
                captionHint: String(zone.captionHint || "").slice(0, 180),
                x: Math.max(0, Math.min(1, Number(zone.x) || 0)),
                y: Math.max(0, Math.min(1, Number(zone.y) || 0)),
                w: Math.max(0.05, Math.min(1, Number(zone.w) || 0.9)),
                h: Math.max(0.05, Math.min(1, Number(zone.h) || 0.15)),
            })).slice(0, 8),
            analysisStatus: confidence < 0.55 ? "needs-review" : "analyzed",
            analysisError: "",
        });
    }
    const analyzed = await updateMeme(id, {
        template: String(result.template || existing.template || "Unknown template").slice(0, 120),
        templateAliases: [...new Set([
            ...(existing.templateAliases || []),
            ...(result.templateAliases || []).map((value) => String(value).slice(0, 120)),
        ])].slice(0, 8),
        visualDescription: String(result.visualDescription || existing.visualDescription || "").slice(0, 500),
        emotion: String(result.emotion || existing.emotion || "").slice(0, 80),
        tone: [...new Set([
            ...(existing.tone || []),
            ...(result.tone || []).map((value) => String(value).slice(0, 60)),
        ])].slice(0, 8),
        captionRules: [...new Set([
            ...(existing.captionRules || []),
            ...(result.captionRules || []).map((value) => String(value).slice(0, 180)),
        ])].slice(0, 12),
        exampleCaptions: (() => {
            const incoming = Array.isArray(result.exampleCaptions) ? result.exampleCaptions.map((example) => ({
                texts: Array.isArray(example.texts) ? example.texts.map(String).slice(0, 8) : [],
                locale: String(example.locale || "").slice(0, 20),
                note: String(example.note || "").slice(0, 180),
            })) : [];
            const examples = [...(existing.exampleCaptions || []), ...incoming];
            return [...new Map(examples.map((example) =>
                [`${example.locale || ""}:${(example.texts || []).join("\n")}`, example]
            )).values()].slice(-8);
        })(),
        captionZones: !preserveExistingZones && Array.isArray(result.captionZones) && result.captionZones.length
            ? result.captionZones.map((zone, index) => ({
                id: String(zone.id || `zone-${index + 1}`).slice(0, 40),
                role: String(zone.role || `text-${index + 1}`).slice(0, 80),
                captionHint: String(zone.captionHint || "").slice(0, 180),
                x: Math.max(0, Math.min(1, Number(zone.x) || 0)),
                y: Math.max(0, Math.min(1, Number(zone.y) || 0)),
                w: Math.max(0.05, Math.min(1, Number(zone.w) || 0.9)),
                h: Math.max(0.05, Math.min(1, Number(zone.h) || 0.15)),
            })).slice(0, 8)
            : existing.captionZones || [],
        tags: normalizeTags([...(existing.tags || []), ...(result.tags || [])].join(",")),
        confidence,
        analysisStatus: confidence < 0.55 ? "needs-review" : "analyzed",
        analysisError: "",
    });
    const index = await loadMemeIndex();
    const sameTemplate = index.images.find((image) => {
        if (image.id === analyzed.id) return false;
        const candidateNames = [image.template, ...(image.templateAliases || [])]
            .filter(Boolean).map((value) => value.toLocaleLowerCase());
        const analyzedNames = [analyzed.template, ...(analyzed.templateAliases || [])]
            .filter(Boolean).map((value) => value.toLocaleLowerCase());
        const knownNameMatch = !analyzedNames.includes("unknown template")
            && candidateNames.some((name) => analyzedNames.includes(name));
        return knownNameMatch || perceptualDistance(image, analyzed) <= 8;
    });
    if (sameTemplate) {
        return updateMeme(id, {
            duplicateOf: sameTemplate.id,
            replacementSuggested: qualityScore(analyzed) > qualityScore(sameTemplate),
            analysisStatus: "duplicate",
            analysisError: `Similar template already exists: ${sameTemplate.template}.`,
        });
    }
    return analyzed;
}

export async function replaceMeme(existingId, replacementId) {
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

export async function keepMeme(id) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    image.duplicateOf = "";
    image.replacementSuggested = false;
    image.analysisStatus = Number(image.confidence || 0) < 0.55 ? "needs-review" : "analyzed";
    image.analysisError = "";
    await saveMemeIndex(index);
    return image;
}

export async function setKnowYourMemeUrl(id, value) {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    const raw = String(value || "").trim();
    if (raw) {
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "knowyourmeme.com"
            && !url.hostname.endsWith(".knowyourmeme.com")) {
            throw new CanvasError("invalid_kym_url", "Use a URL from knowyourmeme.com.");
        }
        image.knowYourMemeUrl = url.href;
    } else {
        image.knowYourMemeUrl = "";
    }
    image.updatedAt = new Date().toISOString();
    await saveMemeIndex(index);
    return image;
}

export async function analyzePendingMemes() {
    const available = Math.max(0, MAX_ANALYSIS_WORKERS - analysisWorkers.size);
    if (!available) return [];
    const pending = (await loadMemeIndex()).images.filter((image) =>
        image.analysisStatus === "pending"
    ).slice(0, available);
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

export async function drainAnalysisQueue() {
    if (analysisWorkers.size >= MAX_ANALYSIS_WORKERS) return;
    await analyzePendingMemes().catch(() => {});
}
