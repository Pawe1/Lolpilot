import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { CanvasError } from "@github/copilot-sdk/extension";
import { ROOT, ANALYSIS_DIR, IMAGE_CACHE_DIR, MEME_INDEX_PATH } from "./config.mjs";

const analysisWorkers = new Map();
const MAX_ANALYSIS_WORKERS = 3;
const execFileAsync = promisify(execFile);
export async function loadMemeIndex() {
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

export async function saveMemeIndex(index) {
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

export async function recoverAnalysisState() {
    const index = await loadMemeIndex();
    let changed = false;
    for (const image of index.images) {
        if (image.analysisStatus === "analyzing") {
            image.analysisStatus = "pending";
            image.analysisError = "Recovered after extension reload.";
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
        `Set id to "${image.id}".`,
        "templateAliases is at most 5 strings; tone at most 5; captionRules at most 8; tags at most 16; confidence is 0..1.",
        "Return no conversational reply beyond confirming the file was written.",
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

export async function analyzeMeme(id, hint = "") {
    const index = await loadMemeIndex();
    const image = index.images.find((candidate) => candidate.id === id);
    if (!image) throw new CanvasError("meme_not_found", "Meme not found.");
    if (image.analysisStatus === "analyzing") return image;
    await updateMeme(id, { analysisStatus: "analyzing", analysisHint: String(hint || "").slice(0, 500) });
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
            `--prompt=${curatorPrompt({ ...image, analysisHint: hint || image.analysisHint })}`,
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
    const sameTemplate = index.images.find((image) => {
        if (image.id === analyzed.id) return false;
        const candidateNames = [image.template, ...(image.templateAliases || [])]
            .filter(Boolean).map((value) => value.toLocaleLowerCase());
        const analyzedNames = [analyzed.template, ...(analyzed.templateAliases || [])]
            .filter(Boolean).map((value) => value.toLocaleLowerCase());
        const knownNameMatch = !analyzedNames.includes("unknown template")
            && candidateNames.some((name) => analyzedNames.includes(name));
        const descriptionMatch = image.visualDescription && analyzed.visualDescription
            && normalizeTags(image.visualDescription).slice(0, 12).filter((tag) =>
                normalizeTags(analyzed.visualDescription).includes(tag)
            ).length >= 5;
        return knownNameMatch || descriptionMatch || perceptualDistance(image, analyzed) <= 8;
    });
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
