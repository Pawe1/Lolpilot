import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const ROOT = "C:\\Dev\\lolpilot";
export const ACTIVE_PROFILE_PATH = `${ROOT}\\profile.md`;
export const PROFILES_DIR = `${ROOT}\\profiles`;
export const ACTIVE_NAME_PATH = `${ROOT}\\active-profile.txt`;
export const IMAGE_CACHE_DIR = `${ROOT}\\cache\\images`;
export const MEME_INDEX_PATH = `${ROOT}\\cache\\meme-index.json`;
export const ANALYSIS_DIR = `${ROOT}\\cache\\analysis`;
export const BUILD_LOADED_AT = new Date().toLocaleString("sv-SE", { timeZoneName: "short" });
export let BUILD_ID = "working-tree";
const execFileAsync = promisify(execFile);
try {
    const { stdout } = await execFileAsync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
    BUILD_ID = stdout.toString().trim() || BUILD_ID;
} catch {}
