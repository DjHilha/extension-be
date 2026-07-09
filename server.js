const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const WALLETS_FILE = path.join(DATA_DIR, "wallets.json");
const QUEUE_FILE = path.join(DATA_DIR, "shop_queue.json");
const WATCHERS_FILE = path.join(DATA_DIR, "watchers.json");
const FORGERY_FILE = path.join(DATA_DIR, "forgery.json");
const TRAINING_FILE = path.join(DATA_DIR, "training_center.json");
const STREAMER_CHANNELS_FILE = path.join(DATA_DIR, "streamer_channels.json");
const STREAMER_CHANNELS_REPO_FILE = path.join(__dirname, "streamer_channels.json");

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SECRET_KEY);

if (USE_SUPABASE) {
    console.log("[SUPABASE] Enabled. Wallets will load from Supabase, not local JSON.");
} else {
    console.log("[SUPABASE] Disabled. Wallets will use local JSON and may reset on redeploy.");
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PRICES = {
    CREATE_COMPANION: 500,
    BUY_TRAIL: 100,
    BUY_RELIC: 125,
    BUY_ANCIENT_RELIC: 200,
    REROLL_RELIC: 150,
    REROLL_ANCIENT_RELIC: 200,
    BOTTLE_RHUM: 100,
    PAY_DEBT: 300,
    REROLL_LEGENDARY: 500,
    FORGERY_CUSTOM_RELIC: 200,
    FORGERY_MODIFIER: 100,
    FORGERY_REROLL: 200,
    FORGERY_CUSTOM_ANCIENT_RELIC: 300,
    FORGERY_ANCIENT_MODIFIER: 150,
    TRAINING_BASIC: 50,
    TRAINING_ADVANCED: 150,
    TRAINING_ELITE: 300,
    TRAINING_STUDY: 120,
    TRAINING_AGILITY: 150,
    TRAINING_RELIC_RESEARCH: 150,
    TRAINING_EXPEDITION: 150,
    TRAINING_MODIFIER_RESEARCH: 200,
    TRAINING_REST: 100,
    TRAINING_MINIGAME: 75,
    TRAINING_SPARRING: 125,
    TRAINING_SPECIALIZATION: 250
};

let companionsData = { companions: [] };
let tasksData = { active: false, tasks: [] };
let shopActionQueue = [];
let wallets = {};
let watchers = {};
let forgeryData = {};
let trainingData = {};
let streamerChannels = {};

const CANONICAL_CHANNELS = {
    meowtys_s3: {
        djhilha: { id: "145555184", displayName: "DjHilha", ownerName: "Hilha" },
        hilha: { id: "145555184", displayName: "DjHilha", ownerName: "Hilha" },
        halosiapaage: { id: "133543020", displayName: "HalosiaPaage", ownerName: "HalosiaPaage" }
    }
};

const PLACEHOLDER_CHANNEL_IDS = new Set(["123456789"]);

function canonicalChannelForInput(channelInput, serverIdOverride = "") {
    const sid = normalizeServerId(serverIdOverride || firstEnabledServerId());
    const wanted = normalizeViewer(channelInput);
    const serverMap = CANONICAL_CHANNELS[sid] || {};
    return serverMap[wanted] || null;
}

function isPlaceholderChannelId(channelId) {
    return PLACEHOLDER_CHANNEL_IDS.has(normalizeChannelId(channelId));
}

function configuredChannelIds(serverIdOverride = "") {
    const sid = normalizeServerId(serverIdOverride || firstEnabledServerId());
    const ids = new Set();
    const config = streamerChannels?.servers?.[sid] || {};
    for (const id of Object.keys(config.channels || {})) {
        const clean = normalizeChannelId(id);
        if (clean && !isPlaceholderChannelId(clean)) ids.add(clean);
    }
    const canonicalMap = CANONICAL_CHANNELS[sid] || {};
    for (const channel of Object.values(canonicalMap)) {
        const clean = normalizeChannelId(channel.id);
        if (clean && !isPlaceholderChannelId(clean)) ids.add(clean);
    }
    return ids;
}

function isAllowedChannelId(channelId, serverIdOverride = "") {
    const clean = normalizeChannelId(channelId);
    if (!clean || isPlaceholderChannelId(clean)) return false;
    const allowed = configuredChannelIds(serverIdOverride);
    return allowed.size === 0 || allowed.has(clean);
}

function resolveViewerIdInput(viewerInput, serverIdOverride = "") {
    const wanted = normalizeViewer(viewerInput);
    if (!wanted) return "";
    const parsed = parseScopedViewerKey(wanted);
    if (parsed.viewerId && parsed.viewerId !== wanted) return normalizeViewer(parsed.viewerId);
    if (/^\d+$/.test(wanted)) return wanted;
    const sid = normalizeServerId(serverIdOverride || firstEnabledServerId());
    const canonicalMap = CANONICAL_CHANNELS[sid] || {};
    const canonical = canonicalMap[wanted];
    if (canonical && canonical.id) return normalizeViewer(canonical.id);
    const config = streamerChannels?.servers?.[sid] || {};
    for (const [id, name] of Object.entries(config.channels || {})) {
        if (normalizeViewer(name) === wanted) return normalizeViewer(id);
    }
    return "";
}

function applyCanonicalChannelOverrides() {
    for (const [serverId, channelMap] of Object.entries(CANONICAL_CHANNELS)) {
        if (!streamerChannels.servers[serverId]) {
            streamerChannels.servers[serverId] = { enabled: true, name: serverId, channels: {}, owners: {} };
        }

        const config = streamerChannels.servers[serverId];
        if (!config.channels || typeof config.channels !== "object") config.channels = {};
        if (!config.owners || typeof config.owners !== "object") config.owners = {};

        for (const badId of PLACEHOLDER_CHANNEL_IDS) {
            delete config.channels[badId];
            delete config.owners[badId];
        }

        for (const canonical of Object.values(channelMap)) {
            for (const [id, name] of Object.entries({ ...config.channels })) {
                if (normalizeViewer(name) === normalizeViewer(canonical.displayName) && normalizeChannelId(id) !== canonical.id) {
                    delete config.channels[id];
                    delete config.owners[id];
                }
            }
            config.channels[canonical.id] = canonical.displayName;
            config.owners[canonical.id] = canonical.ownerName;
        }
    }
}

function prunePlaceholderWalletsFromMemory() {
    let removed = 0;
    for (const [key, wallet] of Object.entries(wallets || {})) {
        const parsed = parseScopedViewerKey(wallet?.viewer || key);
        if (isPlaceholderChannelId(parsed.channelId)) {
            delete wallets[key];
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`[WALLET] Removed ${removed} placeholder-channel wallet(s) from memory/cache.`);
        writeJsonFile(WALLETS_FILE, wallets);
    }
}

function pruneInvalidChannelWalletsFromMemory() {
    let removed = 0;
    for (const [key, wallet] of Object.entries(wallets || {})) {
        const parsed = parseScopedViewerKey(wallet?.viewer || key);
        const serverId = normalizeServerId(parsed.serverId || wallet?.serverId || firstEnabledServerId());
        const channelId = normalizeChannelId(parsed.channelId || "");
        if (!isAllowedChannelId(channelId, serverId)) {
            delete wallets[key];
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`[WALLET] Removed ${removed} invalid-channel wallet(s) from memory/cache.`);
        writeJsonFile(WALLETS_FILE, wallets);
    }
}

async function purgePlaceholderWalletsFromSupabase() {
    if (!USE_SUPABASE) return;
    for (const channelId of PLACEHOLDER_CHANNEL_IDS) {
        try {
            await supabaseRequest(`/wallets?channel_id=eq.${encodeURIComponent(channelId)}`, {
                method: "DELETE",
                headers: { Prefer: "return=minimal" }
            });
            console.log(`[SUPABASE] Purged placeholder wallet rows for channel_id=${channelId}.`);
        } catch (error) {
            console.error(`[SUPABASE] Failed purging placeholder wallet rows for channel_id=${channelId}.`, error);
        }
    }
}

async function purgeInvalidChannelWalletsFromSupabase() {
    if (!USE_SUPABASE) return;
    try {
        const rows = await supabaseRequest("/wallets?select=server_id,channel_id", { method: "GET" });
        if (!Array.isArray(rows)) return;
        const badChannels = new Set();
        for (const row of rows) {
            const serverId = normalizeServerId(row.server_id || firstEnabledServerId());
            const channelId = normalizeChannelId(row.channel_id || "");
            if (!isAllowedChannelId(channelId, serverId)) {
                badChannels.add(`${serverId}::${channelId}`);
            }
        }
        for (const value of badChannels) {
            const [serverId, channelId] = value.split("::");
            await supabaseRequest(`/wallets?server_id=eq.${encodeURIComponent(serverId)}&channel_id=eq.${encodeURIComponent(channelId)}`, {
                method: "DELETE",
                headers: { Prefer: "return=minimal" }
            });
            console.log(`[SUPABASE] Purged invalid wallet rows for server_id=${serverId}, channel_id=${channelId}.`);
        }
    } catch (error) {
        console.error("[SUPABASE] Failed purging invalid-channel wallet rows.", error);
    }
}


function defaultStreamerChannels() {
    return {
        servers: {
            meowtys_s3: {
                enabled: true,
                name: "Meowtys S3",
                channels: {
                    "145555184": "DjHilha"
                },
                owners: {
                    "145555184": "Hilha"
                }
            }
        }
    };
}

function loadStreamerChannels() {
    /*
     * Prefer streamer_channels.json committed next to server.js.
     * DATA_DIR is Render's runtime data folder, so files uploaded to Git are not
     * found there unless we explicitly check __dirname too.
     */
    let loaded = null;

    try {
        if (fs.existsSync(STREAMER_CHANNELS_REPO_FILE)) {
            const raw = fs.readFileSync(STREAMER_CHANNELS_REPO_FILE, "utf8");
            loaded = raw.trim() ? JSON.parse(raw) : null;
            console.log(`[CHANNELS] Loaded ${STREAMER_CHANNELS_REPO_FILE}`);
        }
    } catch (error) {
        console.error(`[CHANNELS] Failed reading ${STREAMER_CHANNELS_REPO_FILE}`, error);
    }

    if (!loaded) {
        loaded = readJsonFile(STREAMER_CHANNELS_FILE, defaultStreamerChannels());
        console.log(`[CHANNELS] Loaded ${STREAMER_CHANNELS_FILE}`);
    }

    streamerChannels = loaded;
    if (!streamerChannels || typeof streamerChannels !== "object") streamerChannels = defaultStreamerChannels();
    if (!streamerChannels.servers || typeof streamerChannels.servers !== "object") streamerChannels.servers = defaultStreamerChannels().servers;

    applyCanonicalChannelOverrides();

    // Keep a runtime cache copy in DATA_DIR too.
    writeJsonFile(STREAMER_CHANNELS_FILE, streamerChannels);

    const enabledServers = Object.entries(streamerChannels.servers || {}).filter(([, c]) => c && c.enabled !== false);
    const channelCount = enabledServers.reduce((sum, [, c]) => sum + Object.keys(c.channels || {}).length, 0);
    console.log(`[CHANNELS] Active servers: ${enabledServers.length}, allowed channels: ${channelCount}`);
}

function firstEnabledServerId() {
    for (const [serverId, config] of Object.entries(streamerChannels.servers || {})) {
        if (config && config.enabled !== false) return serverId;
    }
    return "meowtys_s3";
}

function firstChannelId(serverIdOverride = "") {
    const serverId = normalizeServerId(serverIdOverride || firstEnabledServerId());
    const config = streamerChannels?.servers?.[serverId];
    const channels = config?.channels || {};
    const first = Object.keys(channels)[0];
    return normalizeChannelId(first || "145555184");
}

function resolveServerIdFromChannel(channelId) {
    const wanted = String(channelId || "").trim();
    const wantedNorm = normalizeViewer(wanted);
    for (const [serverId, channelMap] of Object.entries(CANONICAL_CHANNELS || {})) {
        if (channelMap[wantedNorm]) return serverId;
    }
    for (const [serverId, config] of Object.entries(streamerChannels.servers || {})) {
        if (!config || config.enabled === false) continue;
        const channels = config.channels || {};
        if (!wanted) return serverId;
        if (Object.prototype.hasOwnProperty.call(channels, wanted)) return serverId;
        for (const name of Object.values(channels)) {
            if (String(name || "").toLowerCase() === wanted.toLowerCase()) return serverId;
        }
    }
    return firstEnabledServerId();
}

function normalizeOwnerName(value) {
    return String(value || "").trim().toLowerCase();
}

function addOwnerCandidate(set, value) {
    const raw = String(value || "").trim();
    if (!raw) return;

    set.add(normalizeOwnerName(raw));

    // Your Twitch channel is DjHilha, but your Minecraft owner name is Hilha.
    // This keeps channel filtering working for names that use the DJ prefix.
    if (/^dj/i.test(raw) && raw.length > 2) {
        set.add(normalizeOwnerName(raw.slice(2)));
    }
}

function ownerCandidatesForRequest(req, serverId, channelId) {
    const candidates = new Set();

    const sid = normalizeServerId(serverId);
    const config = streamerChannels?.servers?.[sid] || {};
    const channels = config.channels || {};
    const owners = config.owners || {};

    let cleanChannel = normalizeChannelId(channelId || "");

    // Public /companions must NEVER trust viewer/companion ownerName query params.
    // Those values can be stale or can come from the viewer profile, which is what
    // caused DjHilha's stream to load another player's companion named "Hilha".
    // Only the configured broadcaster channel -> Minecraft owner mapping decides
    // which owners are visible on a stream.

    // If Twitch sends a display name instead of the numeric broadcaster id,
    // convert it back to the matching configured channel id.
    if (cleanChannel && !Object.prototype.hasOwnProperty.call(channels, cleanChannel)) {
        for (const [id, name] of Object.entries(channels)) {
            if (normalizeViewer(name) === normalizeViewer(cleanChannel)) {
                cleanChannel = normalizeChannelId(id);
                break;
            }
        }
    }

    // If no usable broadcaster id is supplied, default to the first configured
    // broadcaster for this server. For your current config that is DjHilha -> Hilha.
    if (!cleanChannel || !Object.prototype.hasOwnProperty.call(channels, cleanChannel)) {
        cleanChannel = firstChannelId(sid);
    }

    // The owners mapping is the source of truth:
    // Twitch channel id -> Minecraft owner name.
    if (cleanChannel && Object.prototype.hasOwnProperty.call(owners, cleanChannel)) {
        addOwnerCandidate(candidates, owners[cleanChannel]);
    } else if (cleanChannel && Object.prototype.hasOwnProperty.call(channels, cleanChannel)) {
        // Backwards-compatible fallback if an older config has no owners block.
        addOwnerCandidate(candidates, channels[cleanChannel]);
    }

    if (candidates.size === 0 && sid === "meowtys_s3") {
        addOwnerCandidate(candidates, "Hilha");
    }

    return Array.from(candidates).filter(Boolean);
}

function companionOwnerName(c) {
    return normalizeOwnerName(c?.owner || c?.ownerName || c?.minecraftName || "");
}

function companionMatchesLinked(c, linked) {
    if (!c || !linked || !linked.companionName) return false;

    const wantedServer = normalizeServerId(linked.serverId || firstEnabledServerId());
    const wantedName = String(linked.companionName || "").trim().toLowerCase();
    const wantedOwnerUuid = String(linked.ownerUuid || "").trim().toLowerCase();
    const wantedOwnerName = String(linked.ownerName || "").trim().toLowerCase();

    const cServer = normalizeServerId(c.serverId || wantedServer);
    const cName = String(c.name || "").trim().toLowerCase();
    const cOwnerUuid = String(c.ownerUuid || "").trim().toLowerCase();
    const cOwnerName = companionOwnerName(c);

    if (cServer !== wantedServer || cName !== wantedName) return false;
    if (wantedOwnerUuid && cOwnerUuid === wantedOwnerUuid) return true;
    if (wantedOwnerName && cOwnerName === wantedOwnerName) return true;
    return false;
}

function normalizeServerId(serverId) {
    return String(serverId || firstEnabledServerId() || "meowtys_s3").trim().toLowerCase();
}

function normalizeChannelId(channelId) {
    return String(channelId || "").trim().toLowerCase();
}

function scopedViewerKey(viewer, channelId = "", serverIdOverride = "") {
    const raw = normalizeViewer(viewer);
    if (!raw) return "";
    if (raw.includes("::")) return raw;
    const channel = normalizeChannelId(channelId);
    if (!channel) return raw;
    const serverId = normalizeServerId(serverIdOverride || resolveServerIdFromChannel(channel));
    return `${serverId}::${channel}::${raw}`;
}

function scopeViewerFromRequest(req, viewer) {
    return scopedViewerKey(
        viewer,
        req?.body?.channelId || req?.query?.channelId || req?.headers?.["x-channel-id"] || "",
        req?.body?.serverId || req?.query?.serverId || ""
    );
}

function parseScopedViewerKey(viewer) {
    const raw = normalizeViewer(viewer);
    const parts = raw.split("::");
    if (parts.length >= 3 && streamerChannels?.servers?.[parts[0]]) {
        return {
            serverId: normalizeServerId(parts[0]),
            channelId: normalizeChannelId(parts[1]),
            viewerId: parts.slice(2).join("::")
        };
    }
    return {
        serverId: firstEnabledServerId(),
        channelId: "",
        viewerId: raw
    };
}

function encodeCompanionLink(serverId, ownerUuid, ownerName, companionName) {
    const cleanServer = normalizeServerId(serverId);
    const cleanOwnerUuid = String(ownerUuid || "").trim();
    const cleanOwnerName = String(ownerName || "").trim();
    const cleanCompanion = String(companionName || "").trim();
    if (!cleanOwnerUuid || !cleanCompanion) return cleanCompanion;
    return `${cleanServer}::${cleanOwnerUuid}::${cleanOwnerName.replace(/:/g, "_")}::${cleanCompanion}`;
}

function parseCompanionLink(value) {
    const raw = String(value || "").trim();
    const parts = raw.split("::");
    if (parts.length >= 4) {
        return {
            serverId: normalizeServerId(parts[0]),
            ownerUuid: parts[1],
            ownerName: parts[2],
            companionName: parts.slice(3).join("::")
        };
    }
    return { serverId: firstEnabledServerId(), ownerUuid: "", ownerName: "", companionName: raw };
}

function companionStateKeyFor(viewer, companionName) {
    const wallet = getWalletResolved(viewer, false) || (wallets[normalizeViewer(viewer)] || null);
    const linked = parseCompanionLink(wallet && wallet.companionName);
    const scoped = parseScopedViewerKey(wallet?.viewer || viewer);
    const requested = String(companionName || "").trim();
    const serverId = normalizeServerId(scoped.serverId || linked.serverId || firstEnabledServerId());
    const channelId = normalizeChannelId(scoped.channelId || "default");
    const viewerId = normalizeViewer(scoped.viewerId || viewer);

    if (linked.ownerUuid && (!requested || linked.companionName.toLowerCase() === requested.toLowerCase())) {
        return `${serverId}::${channelId}::${viewerId}::${linked.ownerUuid}::${linked.companionName.toLowerCase()}`;
    }

    return `${serverId}::${channelId}::${viewerId}::viewer::${requested.toLowerCase()}`;
}

function findExportedCompanion(serverId, minecraftName, companionName) {
    const sid = normalizeServerId(serverId);
    const ownerWanted = String(minecraftName || "").trim().toLowerCase();
    const companionWanted = String(companionName || "").trim().toLowerCase();
    if (!ownerWanted || !companionWanted || !Array.isArray(companionsData.companions)) return null;
    return companionsData.companions.find(c => {
        const cServer = normalizeServerId(c.serverId || firstEnabledServerId());
        const cOwner = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        const cName = String(c.name || "").trim().toLowerCase();
        return cServer === sid && cOwner === ownerWanted && cName === companionWanted;
    }) || null;
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeJsonFile(file, data) {
    try {
        ensureDataDir();
        const tmp = file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, file);
    } catch (e) {
        console.error(`[DATA] Failed writing ${file}`, e);
    }
}

function readJsonFile(file, fallback) {
    try {
        ensureDataDir();
        if (!fs.existsSync(file)) {
            writeJsonFile(file, fallback);
            return fallback;
        }
        const raw = fs.readFileSync(file, "utf8");
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[DATA] Failed reading ${file}`, e);
        return fallback;
    }
}

async function loadPersistentData() {
    loadStreamerChannels();

    if (USE_SUPABASE) {
        wallets = {};
    } else {
        wallets = readJsonFile(WALLETS_FILE, {});
    }

    shopActionQueue = readJsonFile(QUEUE_FILE, []);
    watchers = readJsonFile(WATCHERS_FILE, {});

    // Local JSON is still used as a fallback/cache, but when Supabase is enabled
    // Training Center and Forgery state are loaded from Supabase so progress
    // survives Render restarts/redeploys.
    forgeryData = readJsonFile(FORGERY_FILE, {});
    trainingData = readJsonFile(TRAINING_FILE, {});

    await loadWalletsFromSupabase();
    prunePlaceholderWalletsFromMemory();
    pruneInvalidChannelWalletsFromMemory();
    await purgePlaceholderWalletsFromSupabase();
    await purgeInvalidChannelWalletsFromSupabase();
    await loadTrainingFromSupabase();
    await loadForgeryFromSupabase();

    console.log(`[DATA] Loaded ${Object.keys(wallets).length} wallets, ${Object.keys(trainingData).length} training states, ${Object.keys(forgeryData).length} forgery states and ${shopActionQueue.length} queued shop actions and ${Object.keys(watchers).length} watchers.`);
}


function saveWallets() {
    writeJsonFile(WALLETS_FILE, wallets);
    syncWalletsToSupabaseSoon();
}

function saveQueue() { writeJsonFile(QUEUE_FILE, shopActionQueue); }
function saveWatchers() { writeJsonFile(WATCHERS_FILE, watchers); }
function saveForgery() {
    writeJsonFile(FORGERY_FILE, forgeryData);
    syncForgeryToSupabaseSoon();
}
function saveTraining() {
    writeJsonFile(TRAINING_FILE, trainingData);
    syncTrainingToSupabaseSoon();
}

function walletToSupabaseRow(wallet) {
    const parsed = parseScopedViewerKey(wallet?.viewer || "");
    const serverId = normalizeServerId(parsed.serverId || firstEnabledServerId());
    const channelId = normalizeChannelId(parsed.channelId || firstChannelId(serverId));
    const viewerId = normalizeViewer(parsed.viewerId || wallet?.viewer || "");

    return {
        // IMPORTANT: keep viewer as the raw Twitch viewer ID.
        // Channel/server separation belongs in server_id + channel_id.
        viewer: viewerId,
        server_id: serverId,
        channel_id: channelId,
        dirt: Number(wallet.dirt || 0),
        twitch_id: String(wallet.twitchId || ""),
        display_name: safeDisplayName(wallet.displayName, wallet.twitchId || viewerId || ""),
        companion_name: String(wallet.companionName || ""),
        updated_at: wallet.updatedAt || new Date().toISOString()
    };
}

function supabaseRowToWallet(row) {
    const serverId = normalizeServerId(row.server_id || firstEnabledServerId());
    const channelId = normalizeChannelId(row.channel_id || firstChannelId(serverId));
    const rawViewer = normalizeViewer(row.viewer || "");
    const viewer = scopedViewerKey(rawViewer, channelId, serverId);

    return {
        viewer,
        dirt: Number(row.dirt || 0),
        twitchId: String(row.twitch_id || ""),
        displayName: safeDisplayName(row.display_name, row.twitch_id || rawViewer || ""),
        companionName: String(row.companion_name || ""),
        manualAlias: false,
        updatedAt: String(row.updated_at || new Date().toISOString())
    };
}

async function supabaseRequest(pathname, options = {}) {
    if (!USE_SUPABASE) {
        throw new Error("Supabase is not configured.");
    }

    const url = SUPABASE_URL + "/rest/v1" + pathname;

    const response = await fetch(url, {
        ...options,
        headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(options.headers || {})
        }
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Supabase ${response.status}: ${text}`);
    }

    if (!text) {
        return null;
    }

    return JSON.parse(text);
}

let walletSyncTimer = null;

function syncWalletsToSupabaseSoon() {
    if (!USE_SUPABASE) {
        return;
    }

    if (walletSyncTimer) {
        clearTimeout(walletSyncTimer);
    }

    walletSyncTimer = setTimeout(() => {
        walletSyncTimer = null;
        syncAllWalletsToSupabase().catch(error => {
            console.error("[SUPABASE] Failed syncing wallets.", error);
        });
    }, 500);
}

async function syncAllWalletsToSupabase() {
    if (!USE_SUPABASE) {
        return;
    }

    const rows = Object.values(wallets)
        .filter(wallet => {
            return String(wallet.twitchId || "").trim()
                || String(wallet.companionName || "").trim()
                || /^\d+$/.test(String(wallet.viewer || ""));
        })
        .map(walletToSupabaseRow)
        .filter(row => isAllowedChannelId(row.channel_id, row.server_id));

    if (rows.length === 0) {
        return;
    }

    await supabaseRequest("/wallets?on_conflict=server_id,channel_id,viewer", {
        method: "POST",
        headers: {
            Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify(rows)
    });

    console.log(`[SUPABASE] Synced ${rows.length} wallet(s).`);
}

async function syncViewerLinkToSupabase(wallet) {
    // Viewer links are not used anymore.
    // The wallets table is the single source of truth for:
    // viewer, dirt, twitch_id, display_name, companion_name, updated_at.
    // Keeping this disabled avoids Supabase errors caused by viewer_links
    // missing wallet columns such as dirt.
    return;
}

async function loadWalletsFromSupabase() {
    if (!USE_SUPABASE) {
        console.log("[SUPABASE] Not configured. Using local JSON wallets.");
        return;
    }

    try {
        const rows = await supabaseRequest("/wallets?select=*", {
            method: "GET"
        });

        if (!Array.isArray(rows)) {
            return;
        }

        for (const row of rows) {
            if (!isAllowedChannelId(row.channel_id, row.server_id)) {
                continue;
            }

            const wallet = supabaseRowToWallet(row);

            if (wallet.viewer) {
                wallets[wallet.viewer] = wallet;
            }
        }

        // Repair legacy rows where display_name was accidentally stored as
        // meowtys_s3::channel::viewer. This keeps Supabase from restoring the
        // bad display name after you manually edit it.
        for (const wallet of Object.values(wallets)) {
            repairWalletDisplayName(wallet, "");
        }

        writeJsonFile(WALLETS_FILE, wallets);
        syncWalletsToSupabaseSoon();

        console.log(`[SUPABASE] Loaded ${rows.length} wallet(s).`);

    } catch (error) {
        console.error("[SUPABASE] Failed loading wallets. Falling back to local JSON.", error);
    }
}


function stateRowToObject(row, fallbackCompanionName = "") {
    const key = String(row.key || "");
    const data = row.data && typeof row.data === "object" ? row.data : {};

    return {
        ...data,
        viewer: String(data.viewer || row.viewer || "").toLowerCase(),
        companionName: String(data.companionName || row.companion_name || fallbackCompanionName || ""),
        serverId: String(data.serverId || row.server_id || firstEnabledServerId()),
        channelId: String(data.channelId || row.channel_id || ""),
        updatedAt: String(data.updatedAt || row.updated_at || new Date().toISOString()),
        __key: key
    };
}

function stateObjectToSupabaseRow(key, state) {
    const parts = String(key || "").split("::");
    const keyLooksScoped = parts.length >= 3 && streamerChannels?.servers?.[parts[0]];
    const serverId = normalizeServerId(state?.serverId || (keyLooksScoped ? parts[0] : firstEnabledServerId()));
    const channelId = normalizeChannelId(state?.channelId || (keyLooksScoped ? parts[1] : firstChannelId(serverId)));
    const viewer = normalizeViewer(state?.viewer || (keyLooksScoped ? parts[2] : parts[0]));
    const companionName = String(state?.companionName || "").trim();
    const cleanState = { ...(state || {}) };
    delete cleanState.__key;
    cleanState.serverId = serverId;
    cleanState.channelId = channelId;

    return {
        key,
        server_id: serverId,
        channel_id: channelId,
        viewer,
        companion_name: companionName,
        data: cleanState,
        updated_at: cleanState.updatedAt || new Date().toISOString()
    };
}

async function loadTrainingFromSupabase() {
    if (!USE_SUPABASE) {
        console.log("[SUPABASE] Not configured. Using local JSON training state.");
        return;
    }

    try {
        const rows = await supabaseRequest("/training_center?select=*", { method: "GET" });

        if (!Array.isArray(rows)) {
            return;
        }

        if (rows.length > 0) {
            const loaded = {};
            for (const row of rows) {
                const key = String(row.key || "");
                if (!key) continue;
                loaded[key] = stateRowToObject(row);
            }
            trainingData = loaded;
            writeJsonFile(TRAINING_FILE, trainingData);
            console.log(`[SUPABASE] Loaded ${rows.length} training state(s).`);
            return;
        }

        // First run after creating the table: migrate any local JSON cache into Supabase.
        const localCount = Object.keys(trainingData || {}).length;
        if (localCount > 0) {
            await syncAllTrainingToSupabase();
            console.log(`[SUPABASE] Migrated ${localCount} local training state(s) to Supabase.`);
        } else {
            console.log("[SUPABASE] No training states found yet.");
        }
    } catch (error) {
        console.error("[SUPABASE] Failed loading training states. Falling back to local JSON.", error);
    }
}

async function loadForgeryFromSupabase() {
    if (!USE_SUPABASE) {
        console.log("[SUPABASE] Not configured. Using local JSON forgery state.");
        return;
    }

    try {
        const rows = await supabaseRequest("/forgery?select=*", { method: "GET" });

        if (!Array.isArray(rows)) {
            return;
        }

        if (rows.length > 0) {
            const loaded = {};
            for (const row of rows) {
                const key = String(row.key || "");
                if (!key) continue;
                loaded[key] = stateRowToObject(row);
            }
            forgeryData = loaded;
            writeJsonFile(FORGERY_FILE, forgeryData);
            console.log(`[SUPABASE] Loaded ${rows.length} forgery state(s).`);
            return;
        }

        // First run after creating the table: migrate any local JSON cache into Supabase.
        const localCount = Object.keys(forgeryData || {}).length;
        if (localCount > 0) {
            await syncAllForgeryToSupabase();
            console.log(`[SUPABASE] Migrated ${localCount} local forgery state(s) to Supabase.`);
        } else {
            console.log("[SUPABASE] No forgery states found yet.");
        }
    } catch (error) {
        console.error("[SUPABASE] Failed loading forgery states. Falling back to local JSON.", error);
    }
}

let trainingSyncTimer = null;
let forgerySyncTimer = null;

function syncTrainingToSupabaseSoon() {
    if (!USE_SUPABASE) return;

    if (trainingSyncTimer) {
        clearTimeout(trainingSyncTimer);
    }

    trainingSyncTimer = setTimeout(() => {
        trainingSyncTimer = null;
        syncAllTrainingToSupabase().catch(error => {
            console.error("[SUPABASE] Failed syncing training states.", error);
        });
    }, 500);
}

function syncForgeryToSupabaseSoon() {
    if (!USE_SUPABASE) return;

    if (forgerySyncTimer) {
        clearTimeout(forgerySyncTimer);
    }

    forgerySyncTimer = setTimeout(() => {
        forgerySyncTimer = null;
        syncAllForgeryToSupabase().catch(error => {
            console.error("[SUPABASE] Failed syncing forgery states.", error);
        });
    }, 500);
}

async function syncAllTrainingToSupabase() {
    if (!USE_SUPABASE) return;

    const rows = Object.entries(trainingData || {})
        .filter(([key, state]) => key && state)
        .map(([key, state]) => stateObjectToSupabaseRow(key, state));

    if (rows.length === 0) return;

    await supabaseRequest("/training_center?on_conflict=server_id,channel_id,key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows)
    });

    console.log(`[SUPABASE] Synced ${rows.length} training state(s).`);
}

async function syncAllForgeryToSupabase() {
    if (!USE_SUPABASE) return;

    const rows = Object.entries(forgeryData || {})
        .filter(([key, state]) => key && state)
        .map(([key, state]) => stateObjectToSupabaseRow(key, state));

    if (rows.length === 0) return;

    await supabaseRequest("/forgery?on_conflict=server_id,channel_id,key", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(rows)
    });

    console.log(`[SUPABASE] Synced ${rows.length} forgery state(s).`);
}

function normalizeViewer(viewer) { return String(viewer || "").trim().toLowerCase(); }

function nowMs() {
    return Date.now();
}

function getWatcher(viewer) {
    const key = normalizeViewer(viewer);

    if (!key) return null;

    if (!watchers[key]) {
        watchers[key] = {
            viewer: key,
            twitchId: "",
            displayName: key,
            identityShared: false,
            lastHeartbeatAt: 0,
            lastRewardAt: 0,
            pendingCheck: false,
            checkId: "",
            checkExpiresAt: 0,
            sleeping: false,
            totalWatchMinutes: 0
        };

        saveWatchers();
    }

    return watchers[key];
}

function makeCheckId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function shouldSpawnAfkCheck(watcher, now) {
    if (watcher.pendingCheck) return false;
    if (watcher.sleeping) return false;

    const lastRewardAt = Number(watcher.lastRewardAt || 0);

    if (lastRewardAt <= 0) return false;

    const minutesSinceReward =
        (now - lastRewardAt) / 60000;

    if (minutesSinceReward < 8) return false;

    return Math.random() < 0.18;
}

function publicWatchState(watcher) {
    return {
        viewer: watcher.viewer,
        displayName: watcher.displayName,
        identityShared: !!watcher.identityShared,
        dirt: getWallet(watcher.viewer)?.dirt || 0,
        pendingCheck: !!watcher.pendingCheck,
        checkId: watcher.checkId || "",
        checkExpiresAt: watcher.checkExpiresAt || 0,
        sleeping: !!watcher.sleeping,
        nextRewardInMs: Math.max(0, 300000 - (nowMs() - Number(watcher.lastRewardAt || 0))),
        totalWatchMinutes: watcher.totalWatchMinutes || 0
    };
}


function getWallet(viewer) {
    const key = normalizeViewer(viewer);
    if (!key) return null;

    if (!wallets[key]) {
        wallets[key] = {
            viewer: key,
            dirt: 0,
            twitchId: "",
            displayName: key,
            companionName: "",
            manualAlias: false,
            updatedAt: new Date().toISOString()
        };
        saveWallets();
    } else {
        wallets[key].viewer = wallets[key].viewer || key;
        wallets[key].dirt = Number(wallets[key].dirt || 0);
        wallets[key].twitchId = String(wallets[key].twitchId || "");
        wallets[key].displayName = String(wallets[key].displayName || key);
        wallets[key].companionName = String(wallets[key].companionName || "");
        wallets[key].manualAlias = !!wallets[key].manualAlias;
        wallets[key].updatedAt = wallets[key].updatedAt || new Date().toISOString();
    }

    return wallets[key];
}

function looksLikeNumericId(value) {
    return /^\d+$/.test(String(value || "").trim());
}

function looksLikeInternalScopedId(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return false;
    if (raw.includes("::")) return true;
    return /^meowtys[_-]s\d+::/.test(raw);
}

function safeDisplayName(value, fallback = "") {
    const raw = String(value || "").trim();
    if (!raw || looksLikeNumericId(raw) || looksLikeInternalScopedId(raw)) {
        return String(fallback || "").trim();
    }
    return raw;
}


function findReadableDisplayNameForIdentity(identifier) {
    const wanted = normalizeViewer(identifier);
    if (!wanted) return "";

    for (const wallet of Object.values(wallets || {})) {
        if (!wallet) continue;
        const parsed = parseScopedViewerKey(wallet.viewer || "");
        const candidates = [wallet.twitchId, parsed.viewerId, wallet.viewer].map(normalizeViewer);
        if (!candidates.includes(wanted)) continue;

        const clean = safeDisplayName(wallet.displayName, "");
        if (clean) return clean;
    }

    return "";
}

function repairWalletDisplayName(wallet, preferredName = "") {
    if (!wallet) return false;

    // Manual aliases are authoritative. Admin commands like /mm dirt must not
    // rename a wallet just because the command used another readable name.
    if (wallet.manualAlias && safeDisplayName(wallet.displayName, "")) {
        return false;
    }

    const preferred = safeDisplayName(preferredName, "");
    if (preferred) {
        if (wallet.displayName !== preferred) {
            wallet.displayName = preferred;
            wallet.updatedAt = new Date().toISOString();
            return true;
        }
        return false;
    }

    const current = safeDisplayName(wallet.displayName, "");
    if (current) return false;

    const parsed = parseScopedViewerKey(wallet.viewer || "");
    const found = findReadableDisplayNameForIdentity(wallet.twitchId || parsed.viewerId || wallet.viewer);
    const fallback = found || String(wallet.twitchId || parsed.viewerId || "").trim();

    if (fallback && wallet.displayName !== fallback) {
        wallet.displayName = fallback;
        wallet.updatedAt = new Date().toISOString();
        return true;
    }

    return false;
}

function updateWalletIdentity(viewer, twitchId, displayName) {
    const wallet = getWallet(viewer);
    if (!wallet) return null;

    const cleanTwitchId = String(twitchId || "").trim();
    const cleanDisplayName = String(displayName || "").trim();

    if (cleanTwitchId) {
        wallet.twitchId = cleanTwitchId;
    }

    /*
     * Twitch mobile/identity heartbeats can send a stale or wrong displayName.
     * IMPORTANT: never overwrite an existing readable displayName automatically,
     * because /mm walletalias stores the corrected name in displayName.
     * Only fill displayName when the current value is missing, numeric, scoped,
     * or otherwise not readable. Manual/admin aliases stay permanent.
     */
    const currentDisplayName = safeDisplayName(wallet.displayName, "");
    const incomingDisplayName = safeDisplayName(cleanDisplayName, "");

    if (wallet.manualAlias && currentDisplayName) {
        // Keep the alias set by /mm walletalias.
    } else if (!currentDisplayName && incomingDisplayName) {
        wallet.displayName = incomingDisplayName;
    } else if (!currentDisplayName) {
        repairWalletDisplayName(wallet, "");
    }

    wallet.updatedAt = new Date().toISOString();
    saveWallets();

    syncViewerLinkToSupabase(wallet).catch(error => {
        console.error("[SUPABASE] Failed syncing wallet identity.", error);
    });

    return wallet;
}

function linkWalletCompanion(viewer, twitchId, displayName, companionName, minecraftName = "", channelId = "", serverIdOverride = "") {
    const wallet = updateWalletIdentity(viewer, twitchId, displayName);
    if (!wallet) return null;

    const cleanCompanionName = String(companionName || "").trim();
    const serverId = normalizeServerId(serverIdOverride || resolveServerIdFromChannel(channelId));
    const companion = findExportedCompanion(serverId, minecraftName, cleanCompanionName);

    if (cleanCompanionName) {
        if (companion && companion.ownerUuid) {
            wallet.companionName = encodeCompanionLink(serverId, companion.ownerUuid, companion.owner || companion.ownerName || minecraftName, cleanCompanionName);
        } else if (minecraftName) {
            // Allow linking before the exporter has seen the companion; it will still be isolated by owner name.
            wallet.companionName = encodeCompanionLink(serverId, `ownername:${String(minecraftName).trim().toLowerCase()}`, minecraftName, cleanCompanionName);
        } else {
            wallet.companionName = cleanCompanionName;
        }
    }

    wallet.updatedAt = new Date().toISOString();
    saveWallets();

    syncViewerLinkToSupabase(wallet).catch(error => {
        console.error("[SUPABASE] Failed syncing viewer link.", error);
    });

    console.log(`[LINK] ${wallet.viewer} | ${wallet.displayName || "-"} | ${wallet.companionName || "-"}`);

    return wallet;
}

function resolveWalletKey(identifier) {
    const wanted = normalizeViewer(identifier);
    if (!wanted) return "";

    // Exact key must win first, especially for scoped keys such as
    // meowtys_s3::145555184::viewerId. Otherwise displayName aliases from
    // another streamer/channel could steal the wallet.
    if (wallets[wanted]) {
        return wanted;
    }

    /*
     * IMPORTANT:
     * Resolve companion/display aliases AFTER direct wallet keys.
     * Public extension traffic should pass scoped keys. Admin commands can
     * still resolve display names as a convenience.
     */

    for (const [key, wallet] of Object.entries(wallets)) {
        if (wallet.companionName && normalizeViewer(wallet.companionName) === wanted) {
            return key;
        }
    }

    for (const [key, wallet] of Object.entries(wallets)) {
        if (wallet.displayName && normalizeViewer(wallet.displayName) === wanted) {
            return key;
        }
    }

    for (const [key, wallet] of Object.entries(wallets)) {
        if (wallet.twitchId && normalizeViewer(wallet.twitchId) === wanted) {
            return key;
        }
    }

    for (const [key, wallet] of Object.entries(wallets)) {
        if (wallet.viewer && normalizeViewer(wallet.viewer) === wanted) {
            return key;
        }
    }

    return "";
}

function getWalletResolved(identifier, createIfMissing = false) {
    const resolvedKey = resolveWalletKey(identifier);

    if (resolvedKey) {
        return getWallet(resolvedKey);
    }

    return createIfMissing ? getWallet(identifier) : null;
}


function resolveChannelIdInput(channelInput, serverIdOverride = "") {
    const raw = String(channelInput || "").trim();
    const wanted = normalizeViewer(raw);
    const serverId = normalizeServerId(serverIdOverride || resolveServerIdFromChannel(raw));
    const config = streamerChannels?.servers?.[serverId] || {};
    const channels = config.channels || {};

    const canonical = canonicalChannelForInput(raw, serverId);
    if (canonical) {
        return canonical.id;
    }

    if (!wanted) {
        return firstChannelId(serverId);
    }

    if (Object.prototype.hasOwnProperty.call(channels, wanted)) {
        return normalizeChannelId(wanted);
    }

    for (const [id, name] of Object.entries(channels)) {
        if (normalizeViewer(name) === wanted) {
            return normalizeChannelId(id);
        }
    }

    // Also accept owner/Minecraft names from the owners map, for commands like
    // /mm dirtallchannel 100 Hilha or /mm dirt DjHilha 100 HalosiaPaage.
    const owners = config.owners || {};
    for (const [id, ownerName] of Object.entries(owners)) {
        if (normalizeViewer(ownerName) === wanted) {
            return normalizeChannelId(id);
        }
    }

    // If a numeric channel id is supplied before it is present in config, still
    // use it so scoped wallets can be targeted directly.
    if (/^\d+$/.test(wanted)) {
        return normalizeChannelId(wanted);
    }

    return "";
}

function collectViewerAliases(identifier) {
    const wanted = normalizeViewer(identifier);
    const aliases = new Set();

    if (!wanted) return aliases;

    aliases.add(wanted);

    const canonicalViewerId = resolveViewerIdInput(wanted);
    if (canonicalViewerId) aliases.add(canonicalViewerId);

    const parsedWanted = parseScopedViewerKey(wanted);
    if (parsedWanted.viewerId) aliases.add(normalizeViewer(parsedWanted.viewerId));

    /*
     * Admin commands may use a readable Twitch name such as DjHilha while the
     * target channel wallet stores only the numeric Twitch viewer id.
     * Example:
     *   /mm dirt DjHilha 100 HalosiaPaage
     * must resolve DjHilha -> 145555184, then update the wallet where
     * channel_id = HalosiaPaage's channel and viewer/twitch_id = 145555184.
     *
     * We collect aliases globally first, then match inside the requested channel.
     * This prevents creating duplicate wallets like viewer="djhilha".
     */
    for (const wallet of Object.values(wallets || {})) {
        if (!wallet) continue;

        const parsed = parseScopedViewerKey(wallet.viewer || "");
        const linked = parseCompanionLink(wallet.companionName || "");

        const candidates = [
            wallet.viewer,
            parsed.viewerId,
            wallet.displayName,
            wallet.twitchId,
            linked.companionName,
            linked.ownerName,
            wallet.companionName
        ].map(normalizeViewer).filter(Boolean);

        if (candidates.includes(wanted)) {
            for (const candidate of candidates) {
                aliases.add(candidate);
            }
        }
    }

    return aliases;
}

function walletMatchesIdentifierInChannel(wallet, requestedViewer, channelId, serverIdOverride = "") {
    if (!wallet) return false;

    const aliases = collectViewerAliases(requestedViewer);
    if (aliases.size === 0) return false;

    const parsed = parseScopedViewerKey(wallet.viewer || "");
    const serverId = normalizeServerId(serverIdOverride || parsed.serverId || firstEnabledServerId());
    const wantedChannel = normalizeChannelId(channelId || "");

    if (wantedChannel && normalizeChannelId(parsed.channelId || "") !== wantedChannel) {
        return false;
    }

    const linked = parseCompanionLink(wallet.companionName || "");
    const candidates = [
        wallet.viewer,
        parsed.viewerId,
        wallet.displayName,
        wallet.twitchId,
        linked.companionName,
        linked.ownerName,
        wallet.companionName
    ].map(normalizeViewer).filter(Boolean);

    return candidates.some(candidate => aliases.has(candidate));
}

function resolveWalletKeyForChannel(requestedViewer, channelInput, serverIdOverride = "") {
    const raw = String(requestedViewer || "").trim();
    const normalized = normalizeViewer(raw);
    if (!normalized) return { key: "", channelId: "", serverId: normalizeServerId(serverIdOverride), matchedBy: "missing" };

    const parsedInput = parseScopedViewerKey(raw);
    const serverId = normalizeServerId(serverIdOverride || parsedInput.serverId || resolveServerIdFromChannel(channelInput));
    const channelId = resolveChannelIdInput(channelInput || parsedInput.channelId, serverId);
    const canonicalViewerId = resolveViewerIdInput(raw, serverId);

    // Known Twitch/channel names such as DjHilha must resolve to their numeric
    // Twitch id before any display_name matching. This prevents a bad row like
    // viewer=133543020, display_name=DjHilha from stealing the command intended
    // for viewer/twitch_id=145555184.
    if (channelId && canonicalViewerId) {
        const exactCanonicalScoped = scopedViewerKey(canonicalViewerId, channelId, serverId);
        if (wallets[exactCanonicalScoped]) {
            return { key: exactCanonicalScoped, channelId, serverId, matchedBy: "canonical_scoped_key" };
        }

        for (const [key, wallet] of Object.entries(wallets)) {
            const parsed = parseScopedViewerKey(wallet?.viewer || key);
            if (normalizeChannelId(parsed.channelId || "") !== channelId) continue;
            const viewerId = normalizeViewer(parsed.viewerId || "");
            const twitchId = normalizeViewer(wallet?.twitchId || "");
            if (viewerId === canonicalViewerId || twitchId === canonicalViewerId) {
                return { key, channelId, serverId, matchedBy: "canonical_viewer_id" };
            }
        }

        return { key: "", channelId, serverId, matchedBy: "canonical_not_found" };
    }

    // Exact scoped key first: server::channel::viewer
    if (channelId && !normalized.includes("::")) {
        const exactScoped = scopedViewerKey(raw, channelId, serverId);
        if (wallets[exactScoped]) {
            return { key: exactScoped, channelId, serverId, matchedBy: "scoped_key" };
        }
    }

    // Exact raw key, but only if it belongs to this channel when scoped.
    if (wallets[normalized]) {
        const parsed = parseScopedViewerKey(normalized);
        if (!channelId || !parsed.channelId || normalizeChannelId(parsed.channelId) === channelId) {
            return { key: normalized, channelId: channelId || normalizeChannelId(parsed.channelId || ""), serverId, matchedBy: "exact_key" };
        }
    }

    for (const [key, wallet] of Object.entries(wallets)) {
        if (walletMatchesIdentifierInChannel(wallet, raw, channelId, serverId)) {
            return { key, channelId, serverId, matchedBy: "channel_alias" };
        }
    }

    return { key: "", channelId, serverId, matchedBy: "not_found" };
}

function walletKeysForChannel(channelInput, serverIdOverride = "") {
    const serverId = normalizeServerId(serverIdOverride || resolveServerIdFromChannel(channelInput));
    const channelId = resolveChannelIdInput(channelInput, serverId);
    if (!channelId) return { keys: [], channelId: "", serverId };

    const keys = Object.entries(wallets)
        .filter(([key, wallet]) => {
            const parsed = parseScopedViewerKey(wallet?.viewer || key);
            return normalizeServerId(parsed.serverId || serverId) === serverId
                && normalizeChannelId(parsed.channelId || "") === channelId;
        })
        .map(([key]) => key);

    return { keys, channelId, serverId };
}

function publicWallet(wallet) {
    if (!wallet) return null;
    const linked = parseCompanionLink(wallet.companionName);

    return {
        viewer: wallet.viewer,
        channelId: parseScopedViewerKey(wallet.viewer).channelId || "",
        rawViewer: parseScopedViewerKey(wallet.viewer).viewerId || wallet.viewer,
        dirt: Number(wallet.dirt || 0),
        twitchId: String(wallet.twitchId || ""),
        displayName: String(wallet.displayName || wallet.viewer || ""),
        serverId: linked.serverId || firstEnabledServerId(),
        ownerUuid: linked.ownerUuid || "",
        ownerName: linked.ownerName || "",
        minecraftName: linked.ownerName || "",
        companionName: linked.companionName || "",
        companionKey: linked.ownerUuid ? `${linked.serverId}::${linked.ownerUuid}::${String(linked.companionName || "").toLowerCase()}` : "",
        updatedAt: String(wallet.updatedAt || "")
    };
}


function exportedCompanionExistsForLink(linked) {
    if (!linked || !linked.companionName || !Array.isArray(companionsData.companions)) return false;
    const wantedServer = normalizeServerId(linked.serverId || firstEnabledServerId());
    const wantedName = String(linked.companionName || "").trim().toLowerCase();
    const wantedOwnerUuid = String(linked.ownerUuid || "").trim().toLowerCase();
    const wantedOwnerName = String(linked.ownerName || "").trim().toLowerCase();

    return companionsData.companions.some(c => {
        const cServer = normalizeServerId(c.serverId || wantedServer);
        const cName = String(c.name || "").trim().toLowerCase();
        const cOwnerUuid = String(c.ownerUuid || "").trim().toLowerCase();
        const cOwnerName = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        if (cServer !== wantedServer || cName !== wantedName) return false;
        if (wantedOwnerUuid && cOwnerUuid === wantedOwnerUuid) return true;
        if (wantedOwnerName && cOwnerName === wantedOwnerName) return true;
        if (!wantedOwnerUuid && !wantedOwnerName) {
            const matches = companionsData.companions.filter(other =>
                normalizeServerId(other.serverId || wantedServer) === wantedServer &&
                String(other.name || "").trim().toLowerCase() === wantedName
            );
            return matches.length === 1;
        }
        return false;
    });
}

function clearStaleCompanionLinkIfNeeded(wallet) {
    if (!wallet || !wallet.companionName) return false;
    const linked = parseCompanionLink(wallet.companionName);
    if (!linked.companionName) return false;
    if (!Array.isArray(companionsData.companions) || companionsData.companions.length === 0) return false;
    if (exportedCompanionExistsForLink(linked)) return false;
    console.log(`[LINK] Clearing stale companion link for ${wallet.viewer}: ${wallet.companionName}`);
    wallet.companionName = "";
    wallet.updatedAt = new Date().toISOString();
    saveWallets();
    return true;
}

function companionNameExistsForOwner(serverId, minecraftName, companionName) {
    const sid = normalizeServerId(serverId);
    const ownerWanted = String(minecraftName || "").trim().toLowerCase();
    const nameWanted = String(companionName || "").trim().toLowerCase();
    if (!nameWanted || !Array.isArray(companionsData.companions)) return false;

    return companionsData.companions.some(c => {
        const cServer = normalizeServerId(c.serverId || sid);
        const cName = String(c.name || "").trim().toLowerCase();
        const cOwner = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        if (cServer !== sid || cName !== nameWanted) return false;
        return ownerWanted ? cOwner === ownerWanted : true;
    });
}


function truthyBodyValue(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined) return false;
    const raw = String(value).trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes" || raw === "y" || raw === "owned" || raw === "equipped" || raw === "filled";
}

function numericBodyValue(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function isEmptyRelicSlotValue(value) {
    if (value === null || value === undefined || value === false) return true;
    if (typeof value === "string") {
        const raw = value.trim().toLowerCase();
        return raw === "" || raw === "empty" || raw === "none" || raw === "null" || raw === "undefined";
    }
    return false;
}

function isFilledRelicSlot(slot) {
    if (isEmptyRelicSlotValue(slot)) return false;
    if (typeof slot === "string") return true;
    if (Array.isArray(slot)) return slot.some(isFilledRelicSlot);
    if (typeof slot === "object") {
        if (truthyBodyValue(slot.empty) || truthyBodyValue(slot.isEmpty) || truthyBodyValue(slot.unlockedEmpty)) return false;
        if (truthyBodyValue(slot.owned) || truthyBodyValue(slot.equipped) || truthyBodyValue(slot.filled) || truthyBodyValue(slot.hasRelic)) return true;
        if (Array.isArray(slot.modifiers) && slot.modifiers.length > 0) return true;
        if (Array.isArray(slot.modifierIds) && slot.modifierIds.length > 0) return true;
        if (Array.isArray(slot.inscriptions) && slot.inscriptions.length > 0) return true;
        for (const field of ["id", "name", "type", "key", "modifier", "value", "model", "rarity", "relicType", "slotType"]) {
            if (!isEmptyRelicSlotValue(slot[field])) return true;
        }
        return Object.keys(slot).length > 0;
    }
    return true;
}

function valueLooksAncientRelic(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value > 0;
    if (typeof value === "string") {
        const raw = value.trim().toLowerCase();
        if (!raw || raw === "false" || raw === "0" || raw === "empty" || raw === "none") return false;
        return raw.includes("ancient");
    }
    if (Array.isArray(value)) return value.some(valueLooksAncientRelic);
    if (typeof value === "object") {
        if (truthyBodyValue(value.isAncient) || truthyBodyValue(value.ancient) || truthyBodyValue(value.hasAncientRelic) || truthyBodyValue(value.ancientRelicOwned)) return true;
        for (const field of ["type", "relicType", "slotType", "kind", "id", "name", "key", "rarity", "item", "itemId"]) {
            if (valueLooksAncientRelic(value[field])) return true;
        }
        // Some exporters put all NBT/raw data under value/tag/nbt. Search one level deeper.
        for (const field of ["value", "tag", "nbt", "data", "relic"]) {
            if (valueLooksAncientRelic(value[field])) return true;
        }
    }
    return false;
}

function isFilledAncientRelicSlot(slot) {
    return isFilledRelicSlot(slot) && valueLooksAncientRelic(slot);
}

function countFilledRelicSlotsFromSource(source, ancientOnly = false) {
    if (Array.isArray(source)) {
        /*
         * Vault Hunters exports can store the Ancient Relic as the 5th relic slot
         * instead of putting it in a dedicated ancientRelic/ancientRelics field.
         * Slots 0-3 = normal relic slots, slot 4+ = ancient relic slot(s).
         * If the slot itself explicitly says ancient, that still counts too.
         */
        return source.filter((slot, index) => {
            const filled = isFilledRelicSlot(slot);
            if (!filled) return false;
            const explicitAncient = isFilledAncientRelicSlot(slot);
            const indexAncient = index >= 4;
            if (ancientOnly) return explicitAncient || indexAncient;
            return index < 4 && !explicitAncient;
        }).length;
    }
    return ancientOnly ? (isFilledAncientRelicSlot(source) ? 1 : 0) : (isFilledRelicSlot(source) && !isFilledAncientRelicSlot(source) ? 1 : 0);
}

function countFilledRelicSlotsFromCompanion(companion) {
    if (!companion || typeof companion !== "object") return 0;
    const sources = [
        companion.relics,
        companion.relicSlots,
        companion.relic_slots,
        companion.companionRelics,
        companion.companion_relics
    ];
    let count = 0;
    for (const source of sources) {
        if (source !== undefined) count = Math.max(count, countFilledRelicSlotsFromSource(source, false));
    }
    return count;
}

function countFilledAncientRelicSlotsFromCompanion(companion) {
    if (!companion || typeof companion !== "object") return 0;
    const ancientSources = [
        companion.ancientRelics,
        companion.ancient_relics,
        companion.ancientRelicSlots,
        companion.ancient_relic_slots,
        companion.ancientRelic,
        companion.ancient_relic,
        companion.ancient,
        companion.ancientSlot,
        companion.ancient_slot
    ];
    const mixedSources = [
        companion.relics,
        companion.relicSlots,
        companion.relic_slots,
        companion.companionRelics,
        companion.companion_relics
    ];
    let count = 0;
    for (const source of ancientSources) {
        if (source !== undefined) {
            // Dedicated ancient fields usually mean the source itself is the ancient slot,
            // even if the value does not literally contain the word "ancient".
            if (Array.isArray(source)) count = Math.max(count, source.filter(isFilledRelicSlot).length);
            else if (isFilledRelicSlot(source)) count = Math.max(count, 1);
        }
    }
    for (const source of mixedSources) {
        if (source !== undefined) count = Math.max(count, countFilledRelicSlotsFromSource(source, true));
    }
    return count;
}

function countFilledRelicSlotsFromBody(req, ancientOnly = false) {
    const body = req?.body || {};
    const numberFields = ancientOnly
        ? ["ancientRelicsFilled", "ancientRelicSlotsFilled", "ancientRelicFilled", "ancientSlotsFilled"]
        : ["relicsFilled", "relicSlotsFilled", "normalRelicsFilled", "normalRelicSlotsFilled"];
    let count = 0;
    for (const field of numberFields) {
        if (body[field] !== undefined) count = Math.max(count, numericBodyValue(body[field], 0));
    }

    // Some viewer builds only send total relic count. In your layout the 5th filled
    // relic slot is the Ancient Relic slot, so total relicsFilled >= 5 means ancient owned.
    if (ancientOnly) {
        for (const field of ["relicsFilled", "relicSlotsFilled", "totalRelicsFilled", "filledRelics"]) {
            if (body[field] !== undefined && numericBodyValue(body[field], 0) >= 5) count = Math.max(count, 1);
        }
    }

    const arrayFields = ancientOnly
        ? ["ancientRelics", "ancientRelicSlots", "ancient_relics", "ancient_relic_slots"]
        : ["relics", "relicSlots", "relic_slots", "companionRelics", "companion_relics"];
    for (const field of arrayFields) {
        if (body[field] !== undefined) count = Math.max(count, countFilledRelicSlotsFromSource(body[field], ancientOnly));
    }

    if (ancientOnly) {
        for (const field of ["ancientRelic", "ancient_relic", "ancient", "ancientSlot", "ancientRelicSlot"]) {
            if (body[field] !== undefined && isFilledRelicSlot(body[field])) count = Math.max(count, 1);
        }
        if (truthyBodyValue(body.hasAncientRelic) || truthyBodyValue(body.ancientRelicOwned) || truthyBodyValue(body.hasAncientRelicSlot)) count = Math.max(count, 1);
    }

    return count;
}

function findCompanionForViewerAndName(viewer, companionName) {
    if (!Array.isArray(companionsData.companions)) return null;

    const wallet = getWalletResolved(viewer, false) || wallets[normalizeViewer(viewer)] || null;
    const linked = wallet ? parseCompanionLink(wallet.companionName || "") : null;

    if (linked && linked.companionName) {
        const exact = companionsData.companions.find(c => companionMatchesLinked(c, linked));
        if (exact) return exact;
    }

    const wantedName = String(companionName || linked?.companionName || "").trim().toLowerCase();
    if (!wantedName) return null;

    const parsed = parseScopedViewerKey(wallet?.viewer || viewer);
    const serverId = normalizeServerId(parsed.serverId || linked?.serverId || firstEnabledServerId());
    const ownerWanted = String(linked?.ownerName || "").trim().toLowerCase();
    const ownerUuidWanted = String(linked?.ownerUuid || "").trim().toLowerCase();

    const matches = companionsData.companions.filter(c => {
        const cServer = normalizeServerId(c.serverId || serverId);
        const cName = String(c.name || "").trim().toLowerCase();
        if (cServer !== serverId || cName !== wantedName) return false;
        const cOwner = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        const cOwnerUuid = String(c.ownerUuid || "").trim().toLowerCase();
        if (ownerUuidWanted && cOwnerUuid === ownerUuidWanted) return true;
        if (ownerWanted && cOwner === ownerWanted) return true;
        return !ownerWanted && !ownerUuidWanted;
    });

    return matches.length === 1 ? matches[0] : null;
}

function relicSlotStatusForRequest(req, viewer, companionName) {
    const companion = findCompanionForViewerAndName(viewer, companionName);
    const exportedRelicsFilled = countFilledRelicSlotsFromCompanion(companion);
    const exportedAncientRelicsFilled = countFilledAncientRelicSlotsFromCompanion(companion);
    const bodyRelicsFilled = countFilledRelicSlotsFromBody(req, false);
    const bodyAncientFilled = countFilledRelicSlotsFromBody(req, true);

    const relicsFilled = Math.max(bodyRelicsFilled, exportedRelicsFilled);
    const ancientRelicsFilled = Math.max(bodyAncientFilled, exportedAncientRelicsFilled);

    return {
        companionFound: !!companion,
        relicsFilled,
        ancientRelicsFilled,
        hasAncientRelic: ancientRelicsFilled >= 1,
        debug: {
            bodyRelicsFilled,
            bodyAncientFilled,
            exportedRelicsFilled,
            exportedAncientRelicsFilled
        }
    };
}

const FORGERY_MODIFIERS = new Set([
    "companion_challenge",
    "extended",
    "gilded_cascade",
    "living_cascade",
    "ornate_cascade",
    "coin_cascade",
    "wooden_cascade",
    "gilded",
    "living",
    "ornate",
    "wooden_bonus",
    "coin_pile",
    "phoenix",
    "plentiful",
    "xp_gain",
    "pandoras_box"
]);

const STARTER_FORGING_MODIFIERS = new Set([
    "wooden_cascade",
    "living_cascade",
    "gilded_cascade",
    "ornate_cascade"
]);

const MODIFIER_RESEARCH = {
    common: {
        costDirt: 250,
        costFragments: 5,
        durationMs: 30 * 60 * 1000,
        modifiers: [
            "companion_challenge",
            "wooden_cascade",
            "living_cascade",
            "gilded_cascade",
            "ornate_cascade",
            "coin_cascade",
            "plentiful"
        ]
    },
    rare: {
        costDirt: 500,
        costFragments: 15,
        durationMs: 2 * 60 * 60 * 1000,
        modifiers: [
            "wooden_bonus",
            "gilded",
            "living",
            "ornate",
            "coin_pile"
        ]
    },
    legendary: {
        costDirt: 1000,
        costFragments: 50,
        durationMs: 12 * 60 * 60 * 1000,
        modifiers: [
            "phoenix",
            "extended",
            "xp_gain",
            "pandoras_box"
        ]
    }
};

const MODIFIER_LABELS = {
    companion_challenge: "Companion Challenge",
    extended: "Extended",
    gilded_cascade: "Gilded",
    living_cascade: "Living",
    ornate_cascade: "Ornate",
    coin_cascade: "Bonus Coins",
    wooden_cascade: "Wooden",
    gilded: "Bonus Gilded",
    living: "Bonus Living",
    ornate: "Bonus Ornate",
    wooden_bonus: "Bonus Wooden",
    coin_pile: "Bonus Coins",
    phoenix: "Phoenix",
    plentiful: "Plentiful",
    xp_gain: "XP Gain",
    pandoras_box: "Pandora's Box"
};

function modifierResearchTier(modifier) {
    for (const [tier, config] of Object.entries(MODIFIER_RESEARCH)) {
        if (config.modifiers.includes(modifier)) {
            return tier;
        }
    }
    return "common";
}

function modifierResearchConfig(modifier, academyLevel = 1) {
    const tier = modifierResearchTier(modifier);
    const base = MODIFIER_RESEARCH[tier];
    const level = Math.max(1, Math.min(10, Number(academyLevel || 1)));
    const speedBonus = level >= 10 ? 0.25 : level >= 3 ? 0.10 : 0;
    const dirtDiscount = level >= 6 ? 0.10 : 0;
    const fragmentDiscount = level >= 8 ? 0.10 : 0;

    return {
        tier,
        label: MODIFIER_LABELS[modifier] || modifier,
        costDirt: Math.max(1, Math.ceil(base.costDirt * (1 - dirtDiscount))),
        costFragments: Math.max(1, Math.ceil(base.costFragments * (1 - fragmentDiscount))),
        durationMs: Math.max(60 * 1000, Math.ceil(base.durationMs * (1 - speedBonus)))
    };
}

function forgeryKey(viewer, companionName) {
    return companionStateKeyFor(viewer, companionName);
}

function rollForgerySlots() {
    /* Lower numbers are common, 8-9 are very rare. */
    const weighted = [
        { slots: 1, weight: 360 },
        { slots: 2, weight: 260 },
        { slots: 3, weight: 170 },
        { slots: 4, weight: 95 },
        { slots: 5, weight: 55 },
        { slots: 6, weight: 30 },
        { slots: 7, weight: 16 },
        { slots: 8, weight: 8 },
        { slots: 9, weight: 3 }
    ];
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * total;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) return entry.slots;
    }
    return 1;
}

function rollAncientForgerySlots() {
    const weighted = [
        { slots: 6, weight: 65 },
        { slots: 7, weight: 25 },
        { slots: 8, weight: 8 },
        { slots: 9, weight: 2 }
    ];
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let roll = Math.random() * total;
    for (const entry of weighted) {
        roll -= entry.weight;
        if (roll <= 0) return entry.slots;
    }
    return 6;
}

function getForgeryState(viewer, companionName) {
    const key = forgeryKey(viewer, companionName);
    if (!key || key === "::") return null;

    if (!forgeryData[key]) {
        forgeryData[key] = {
            viewer: normalizeViewer(viewer),
            companionName: String(companionName || "").trim(),
            customRelic: null,
            history: [],
            updatedAt: new Date().toISOString()
        };
        saveForgery();
    }

    return forgeryData[key];
}

function publicForgeryState(state) {
    if (!state) return null;
    const training = getTrainingState(state.viewer, state.companionName);
    finalizeTrainingState(training);
    return {
        viewer: state.viewer,
        companionName: state.companionName,
        customRelic: state.customRelic || null,
        relicFragments: Number(training?.relicFragments || 0),
        ancientRelicFragments: Number(training?.ancientRelicFragments || 0),
        unlockedModifiers: training ? getUnlockedModifiers(training) : ["companion_challenge"],
        updatedAt: state.updatedAt || ""
    };
}

function makeCustomRelic(viewer, companionName, relicType = "normal") {
    const type = relicType === "ancient" ? "ancient" : "normal";
    const slots = type === "ancient" ? rollAncientForgerySlots() : rollForgerySlots();
    return {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type,
        slots,
        modifiers: Array(slots).fill(null),
        modifierCost: type === "ancient" ? PRICES.FORGERY_ANCIENT_MODIFIER : PRICES.FORGERY_MODIFIER,
        spentOnModifiers: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        viewer: normalizeViewer(viewer),
        companionName: String(companionName || "").trim()
    };
}

function resolveViewerForState(identifier) {
    const raw = String(identifier || "").trim();
    const normalized = normalizeViewer(raw);
    if (!normalized) return "";

    // Public extension calls should usually send scoped keys: server::channel::viewer.
    // Resolve exact/scoped first. If not found, keep the scoped key so state and Dirt
    // remain channel-isolated instead of falling back to another channel's displayName.
    const resolved = resolveWalletKey(raw) || resolveWalletKey(normalized);
    if (resolved) return resolved;
    return normalized;
}

function validateForgeryBody(req) {
    const scopedInput = scopeViewerFromRequest(req, req.body.viewer);
    const viewer = resolveViewerForState(scopedInput);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) {
        return { ok: false, status: 400, error: "Missing viewer or companion" };
    }
    return { ok: true, viewer, companionName, requestedViewer: String(req.body.viewer || "").trim() };
}

function hasUnlockedModifier(viewer, companionName, modifier) {
    const state = getTrainingState(viewer, companionName);
    finalizeTrainingState(state);
    return getUnlockedModifiers(state).includes(modifier);
}

function spendTrainingFragments(state, normalAmount, ancientAmount, reason) {
    const normal = Math.max(0, Math.floor(Number(normalAmount || 0)));
    const ancient = Math.max(0, Math.floor(Number(ancientAmount || 0)));
    state.relicFragments = Number(state.relicFragments || 0);
    state.ancientRelicFragments = Number(state.ancientRelicFragments || 0);

    if (state.relicFragments < normal) {
        return { ok: false, error: "Not enough Relic Fragments", required: normal, current: state.relicFragments };
    }
    if (state.ancientRelicFragments < ancient) {
        return { ok: false, error: "Not enough Ancient Relic Fragments", required: ancient, current: state.ancientRelicFragments };
    }

    state.relicFragments -= normal;
    state.ancientRelicFragments -= ancient;
    state.updatedAt = new Date().toISOString();
    addTrainingHistory(state, `${reason}: spent ${normal} Relic Fragment(s) and ${ancient} Ancient Relic Fragment(s).`);
    saveTraining();
    return { ok: true, relicFragments: state.relicFragments, ancientRelicFragments: state.ancientRelicFragments };
}

function transferWalletBalance(fromViewer, toViewer) {
    const fromKey = normalizeViewer(fromViewer);
    const toKey = normalizeViewer(toViewer);

    if (!fromKey || !toKey || fromKey === toKey) {
        return {
            ok: true,
            from: fromKey,
            to: toKey,
            transferred: 0
        };
    }

    const fromWallet = getWallet(fromKey);
    const toWallet = getWallet(toKey);

    const amount = Number(fromWallet.dirt || 0);

    if (amount > 0) {
        toWallet.dirt += amount;
        fromWallet.dirt = 0;
        saveWallets();

        console.log(`[WALLET] Transferred ${amount} Dirt from ${fromKey} to ${toKey}.`);
    }

    return {
        ok: true,
        from: fromKey,
        to: toKey,
        transferred: amount,
        fromDirt: fromWallet.dirt,
        toDirt: toWallet.dirt
    };
}


function spendDirt(viewer, amount, reason) {
    const requested = normalizeViewer(viewer);
    const resolvedKey = resolveWalletKey(viewer) || (wallets[requested] ? requested : "");
    const wallet = resolvedKey ? getWallet(resolvedKey) : null;
    const cost = Math.floor(Number(amount || 0));
    if (!wallet) return { ok: false, error: "Wallet not found for this channel. Viewer must open/link the extension on this stream first.", viewer: requested };
    if (!Number.isFinite(cost) || cost <= 0) return { ok: false, error: "Invalid amount" };
    if (wallet.dirt < cost) {
        return { ok: false, error: "Not enough Dirt", viewer: wallet.viewer, dirt: wallet.dirt, required: cost };
    }
    wallet.dirt -= cost;
    saveWallets();
    console.log(`[WALLET] -${cost} Dirt from ${wallet.viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`);
    return { ok: true, viewer: wallet.viewer, dirt: wallet.dirt, spent: cost, reason };
}

function queueShopAction(action) {
    const parsed = parseScopedViewerKey(action && action.viewer || "");
    const request = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toISOString(),
        serverId: action.serverId || parsed.serverId || firstEnabledServerId(),
        channelId: action.channelId || parsed.channelId || "",
        ...action
    };
    shopActionQueue.push(request);
    saveQueue();
    console.log(`[SHOP] Queued ${request.action} for ${request.viewer}`);
    return request;
}

function shopCompanionFields(req, serverId = "") {
    const ownerName = String(req.body.ownerName || req.body.minecraftName || "").trim();
    return {
        companionUuid: String(req.body.companionUuid || req.body.uuid || "").trim(),
        ownerUuid: String(req.body.ownerUuid || "").trim(),
        ownerName,
        minecraftName: ownerName,
        channelId: normalizeChannelId(req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || ""),
        serverId: normalizeServerId(serverId || req.body.serverId || resolveServerIdFromChannel(req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || ""))
    };
}

function requireApiKey(req, res, next) {
    const key = req.headers["x-api-key"];
    if (!key || key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
    next();
}

// Data is loaded before the server starts at the bottom of this file.

app.get("/streamer-channels", (req, res) => res.json({ ok: true, ...streamerChannels }));
app.get("/", (req, res) => res.json({ ok: true, service: "Meowtys backend", prices: PRICES, channels: { servers: Object.keys(streamerChannels.servers || {}).length, activeServer: firstEnabledServerId() }, persistence: { dataDir: DATA_DIR, wallets: Object.keys(wallets).length, queuedActions: shopActionQueue.length } }));
app.get("/servers", (req, res) => {
    const servers = {};
    for (const [serverId, config] of Object.entries(streamerChannels.servers || {})) {
        if (!config || config.enabled === false) continue;
        servers[serverId] = {
            enabled: true,
            name: String(config.name || serverId),
            channels: config.channels || {}
        };
    }
    res.json({
        ok: true,
        servers,
        count: Object.keys(servers).length,
        allowedChannels: Object.values(servers).reduce((sum, server) => sum + Object.keys(server.channels || {}).length, 0)
    });
});

app.get("/channel-config", (req, res) => {
    res.json({ ok: true, config: streamerChannels });
});

app.get("/prices", (req, res) => res.json({ ok: true, prices: PRICES }));
app.get("/companions", (req, res) => {
    const channelId = req.query.channelId || req.headers["x-channel-id"] || "";
    const serverId = normalizeServerId(req.query.serverId || resolveServerIdFromChannel(channelId));
    let list = Array.isArray(companionsData.companions) ? companionsData.companions.slice() : [];

    // Only show companions for the resolved server.
    list = list.filter(c => normalizeServerId(c.serverId || serverId) === serverId);

    // IMPORTANT:
    // Multi-streamer safety. A stream must only expose companions owned by that
    // streamer's Minecraft owner name. This prevents DjHilha's stream from ever
    // showing HalosiaPaage/Aslakx/etc companions with the same companion name.
    const ownerCandidates = ownerCandidatesForRequest(req, serverId, channelId);
    if (ownerCandidates.length > 0) {
        const allowedOwners = new Set(ownerCandidates);
        list = list.filter(c => allowedOwners.has(companionOwnerName(c)));
    }

    const requestedViewer = String(req.query.viewer || "").trim();
    const scopedViewer = requestedViewer ? scopeViewerFromRequest(req, requestedViewer) : "";
    const wallet = scopedViewer ? getWalletResolved(scopedViewer, false) : null;
    const linked = wallet ? parseCompanionLink(wallet.companionName) : null;

    if (wallet && linked && linked.companionName) {
        const exact = list.find(c => companionMatchesLinked(c, linked));

        if (exact) {
            // Return only the exact linked companion. Do not fall back to another
            // companion with the same name.
            list = [exact];
        } else {
            // The linked companion was deleted or belongs to a different owner.
            // Clear the stale wallet link and return no companion.
            console.log(`[LINK] Linked companion not found for ${wallet.viewer}; clearing stale link: ${wallet.companionName}`);
            wallet.companionName = "";
            wallet.updatedAt = new Date().toISOString();
            saveWallets();
            list = [];
        }
    }

    res.json({
        ...companionsData,
        serverId,
        ownerFilter: ownerCandidates,
        companions: list
    });
});


app.get("/viewer-init/:viewer", (req, res) => {
    const channelId = req.query.channelId || req.headers["x-channel-id"] || "";
    const serverId = normalizeServerId(req.query.serverId || resolveServerIdFromChannel(channelId));
    const requestedViewer = String(req.params.viewer || req.query.viewer || "").trim();
    const scopedViewer = requestedViewer ? scopeViewerFromRequest(req, requestedViewer) : "";

    let wallet = scopedViewer ? getWalletResolved(scopedViewer, false) : null;
    if (!wallet && requestedViewer) wallet = getWalletResolved(requestedViewer, false);

    let list = Array.isArray(companionsData.companions) ? companionsData.companions.slice() : [];
    list = list.filter(c => normalizeServerId(c.serverId || serverId) === serverId);

    const ownerCandidates = ownerCandidatesForRequest(req, serverId, channelId);
    if (ownerCandidates.length > 0) {
        const allowedOwners = new Set(ownerCandidates);
        list = list.filter(c => allowedOwners.has(companionOwnerName(c)));
    }

    let companion = null;
    let clearedStaleCompanion = false;

    if (wallet && wallet.companionName) {
        const linked = parseCompanionLink(wallet.companionName);
        if (linked && linked.companionName) {
            companion = list.find(c => companionMatchesLinked(c, linked)) || null;

            if (!companion) {
                console.log(`[VIEWER-INIT] Clearing stale companion link for ${wallet.viewer}: ${wallet.companionName}`);
                wallet.companionName = "";
                wallet.updatedAt = new Date().toISOString();
                saveWallets();
                clearedStaleCompanion = true;
            }
        }
    }

    // If the wallet was not linked yet but this stream owner has exactly one active
    // companion with the same name as the viewer's selected companion, do not guess.
    // Returning no companion is safer than name-only fallback across multi-streamer data.

    res.json({
        ok: true,
        serverId,
        ownerFilter: ownerCandidates,
        wallet: wallet ? publicWallet(wallet) : null,
        companion,
        companions: companion ? [companion] : [],
        clearedStaleCompanion
    });
});
app.post("/companions", requireApiKey, (req, res) => {
    if (!req.body || !Array.isArray(req.body.companions)) {
        return res.status(400).json({ ok: false, error: "Expected body with companions array" });
    }

    const serverId = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(req.body.channelId));
    const incoming = req.body.companions.map(c => ({ ...c, serverId }));

    // The Minecraft exporter sends the FULL current companion list.
    // Replace this server's cached list instead of merging, otherwise deleted
    // companions stay cached on Render forever.
    const existingOtherServers = Array.isArray(companionsData.companions)
        ? companionsData.companions.filter(c => normalizeServerId(c.serverId || serverId) !== serverId)
        : [];

    companionsData = {
        serverId,
        companions: existingOtherServers.concat(incoming)
    };

    console.log(`[COMPANIONS] Replaced companion list for ${serverId}. Incoming: ${incoming.length}, total cached: ${companionsData.companions.length}`);

    res.json({ ok: true, serverId, count: companionsData.companions.length, updated: incoming.length, mode: "replace" });
});
app.get("/tasks", (req, res) => res.json(tasksData));
app.post("/tasks", requireApiKey, (req, res) => {
    if (!req.body || typeof req.body.active !== "boolean" || !Array.isArray(req.body.tasks)) return res.status(400).json({ ok: false, error: "Expected body with active boolean and tasks array" });

    const previousSignature =
        Array.isArray(tasksData.tasks)
            ? tasksData.tasks.map(task => task.description || "").join("|")
            : "";

    const nextSignature =
        req.body.tasks.map(task => task.description || "").join("|");

    tasksData = req.body;

    if (tasksData.active && !tasksData.startedAt) {
        tasksData.startedAt =
            previousSignature === nextSignature && tasksData.startedAt
                ? tasksData.startedAt
                : Date.now();
    }

    res.json({ ok: true, active: tasksData.active, count: tasksData.tasks.length });
});
app.get("/wallet/:viewer", (req, res) => {
    const scopedViewer = scopeViewerFromRequest(req, req.params.viewer);
    const wallet = getWalletResolved(scopedViewer, false) || getWalletResolved(req.params.viewer, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found",
            viewer: req.params.viewer
        });
    }

    const clearedStaleCompanion = clearStaleCompanionLinkIfNeeded(wallet);
    res.json({ ok: true, ...publicWallet(wallet), clearedStaleCompanion });
});
app.post("/wallet/add", requireApiKey, (req, res) => {
    const requestedViewer = String(req.body.viewer || "").trim();
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "manual");
    const requestedChannel = String(req.body.channelId || req.body.channel || req.query.channelId || req.query.channel || "").trim();
    const requestedServer = String(req.body.serverId || req.query.serverId || "").trim();

    if (!requestedViewer) return res.status(400).json({ ok: false, error: "Missing viewer" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    let wallet = null;
    let channelResolution = null;

    if (requestedChannel) {
        channelResolution = resolveWalletKeyForChannel(requestedViewer, requestedChannel, requestedServer);
        wallet = channelResolution.key ? getWallet(channelResolution.key) : null;
    } else {
        wallet = getWalletResolved(requestedViewer, false);
    }

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: requestedChannel
                ? "Wallet not found in that channel. Viewer must log in with Twitch on that channel first."
                : "Wallet not found. Viewer must log in with Twitch first, or the companion must be linked.",
            requestedViewer,
            requestedChannel: requestedChannel || "",
            resolvedChannelId: channelResolution?.channelId || "",
            serverId: channelResolution?.serverId || ""
        });
    }

    const added = Math.floor(amount);

    wallet.dirt += added;
    // IMPORTANT: giving Dirt must never rename the wallet.
    // /mm dirt grim_stoner should add Dirt only; it must not overwrite a
    // corrected /mm walletalias such as MommyNikki284.
    repairWalletDisplayName(wallet, "");
    wallet.updatedAt = new Date().toISOString();

    saveWallets();

    console.log(`[WALLET] +${added} Dirt to ${wallet.viewer} via "${requestedViewer}" | Channel: ${requestedChannel || "any"} | Reason: ${reason} | Balance: ${wallet.dirt}`);

    res.json({
        ok: true,
        ...publicWallet(wallet),
        requestedViewer,
        requestedChannel: requestedChannel || "",
        resolvedChannelId: channelResolution?.channelId || parseScopedViewerKey(wallet.viewer).channelId || "",
        matchedBy: channelResolution?.matchedBy || "global",
        added,
        reason
    });
});

app.post("/wallet/add-all", requireApiKey, (req, res) => {
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "manual_all");

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            ok: false,
            error: "Invalid amount"
        });
    }

    const added = Math.floor(amount);
    const keys = Object.keys(wallets);

    for (const key of keys) {
        const wallet = getWallet(key);
        wallet.dirt += added;
    }

    saveWallets();

    console.log(`[WALLET] +${added} Dirt to all wallets. Count: ${keys.length} | Reason: ${reason}`);

    res.json({
        ok: true,
        added,
        count: keys.length,
        reason
    });
});


app.post("/wallet/add-channel", requireApiKey, (req, res) => {
    const amount = Number(req.body.amount || 0);
    const requestedChannel = String(req.body.channelId || req.body.channel || req.query.channelId || req.query.channel || "").trim();
    const requestedServer = String(req.body.serverId || req.query.serverId || "").trim();
    const reason = String(req.body.reason || "manual_channel");

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid amount" });
    }

    if (!requestedChannel) {
        return res.status(400).json({ ok: false, error: "Missing channel or channelId" });
    }

    const resolved = walletKeysForChannel(requestedChannel, requestedServer);
    if (!resolved.channelId) {
        return res.status(404).json({ ok: false, error: "Channel not found", requestedChannel });
    }

    const added = Math.floor(amount);
    const affected = [];

    for (const key of resolved.keys) {
        const wallet = getWallet(key);
        wallet.dirt += added;
        wallet.updatedAt = new Date().toISOString();
        affected.push(publicWallet(wallet));
    }

    saveWallets();

    console.log(`[WALLET] +${added} Dirt to channel ${resolved.channelId} (${requestedChannel}). Count: ${affected.length} | Reason: ${reason}`);

    res.json({
        ok: true,
        added,
        count: affected.length,
        requestedChannel,
        channelId: resolved.channelId,
        serverId: resolved.serverId,
        reason,
        wallets: affected
    });
});

app.post("/wallet/spend", requireApiKey, (req, res) => {
    const result = spendDirt(req.body.viewer, req.body.amount, String(req.body.reason || "spend"));
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
});

app.post("/wallet/transfer", requireApiKey, (req, res) => {
    const fromViewer = normalizeViewer(req.body.fromViewer || req.body.from);
    const toViewer = normalizeViewer(req.body.toViewer || req.body.to);

    if (!fromViewer || !toViewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing fromViewer or toViewer"
        });
    }

    const result = transferWalletBalance(fromViewer, toViewer);

    res.json(result);
});

app.post("/wallet/reset-all", requireApiKey, (req, res) => {
    const count = Object.keys(wallets).length;
    for (const key of Object.keys(wallets)) wallets[key].dirt = 0;
    saveWallets();
    console.log(`[WALLET] Reset all wallets to 0. Count: ${count}`);
    res.json({ ok: true, reset: count });
});
app.post("/wallet/reset", requireApiKey, (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    if (!viewer) return res.status(400).json({ ok: false, error: "Missing viewer" });
    const wallet = getWalletResolved(viewer, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found",
            viewer
        });
    }

    wallet.dirt = 0;
    saveWallets();
    console.log(`[WALLET] Reset ${viewer} to 0 Dirt.`);
    res.json({ ok: true, viewer: wallet.viewer, dirt: wallet.dirt });
});

app.post("/admin/reset-player", requireApiKey, (req, res) => {
    const requestedViewer = String(req.body.viewer || req.body.twitchName || req.body.displayName || "").trim();
    const minecraftName = String(req.body.minecraftName || req.body.ownerName || requestedViewer || "").trim();
    const scopedViewer = requestedViewer ? scopeViewerFromRequest(req, requestedViewer) : "";
    const walletKey = resolveWalletKey(scopedViewer) || resolveWalletKey(requestedViewer) || normalizeViewer(scopedViewer || requestedViewer);

    if (!requestedViewer && !minecraftName) {
        return res.status(400).json({ ok: false, error: "Missing viewer or minecraftName" });
    }

    let walletDeleted = false;
    let walletBefore = null;
    if (walletKey && wallets[walletKey]) {
        walletBefore = publicWallet(wallets[walletKey]);
        delete wallets[walletKey];
        walletDeleted = true;
    }

    const wantedMinecraft = minecraftName.toLowerCase();
    const beforeCompanions = Array.isArray(companionsData.companions) ? companionsData.companions.length : 0;
    companionsData.companions = (Array.isArray(companionsData.companions) ? companionsData.companions : []).filter(c => {
        const owner = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        return owner !== wantedMinecraft;
    });
    const removedCompanions = beforeCompanions - companionsData.companions.length;

    let removedTraining = 0;
    for (const key of Object.keys(trainingData || {})) {
        const state = trainingData[key] || {};
        if (
            normalizeViewer(state.viewer || "") === normalizeViewer(walletKey || requestedViewer) ||
            String(state.companionName || "").trim().toLowerCase() === wantedMinecraft
        ) {
            delete trainingData[key];
            removedTraining++;
        }
    }

    let removedForgery = 0;
    for (const key of Object.keys(forgeryData || {})) {
        const state = forgeryData[key] || {};
        if (
            normalizeViewer(state.viewer || "") === normalizeViewer(walletKey || requestedViewer) ||
            String(state.companionName || "").trim().toLowerCase() === wantedMinecraft
        ) {
            delete forgeryData[key];
            removedForgery++;
        }
    }

    saveWallets();
    saveTraining();
    saveForgery();

    console.log(`[ADMIN] Reset player. viewer=${requestedViewer} minecraftName=${minecraftName} walletDeleted=${walletDeleted} companionsRemoved=${removedCompanions}`);

    res.json({
        ok: true,
        requestedViewer,
        minecraftName,
        walletKey,
        walletDeleted,
        walletBefore,
        removedCompanions,
        removedTraining,
        removedForgery
    });
});


app.post("/watch/identity", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const twitchId = String(req.body.twitchId || "").trim();
    const displayName = String(req.body.displayName || viewer).trim();

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    const watcher = getWatcher(viewer);

    watcher.twitchId = twitchId;
    watcher.displayName = displayName || viewer;
    watcher.identityShared = true;
    watcher.sleeping = false;

    const wallet = updateWalletIdentity(viewer, twitchId, displayName || viewer);

    saveWatchers();

    res.json({
        ok: true,
        wallet: publicWallet(wallet),
        watch: publicWatchState(watcher)
    });
});

app.post("/watch/heartbeat", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const twitchId = String(req.body.twitchId || "").trim();
    const displayName = String(req.body.displayName || viewer).trim();

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    const watcher = getWatcher(viewer);
    const now = nowMs();

    watcher.twitchId = twitchId || watcher.twitchId || "";
    watcher.displayName = displayName || watcher.displayName || viewer;
    watcher.identityShared = !!watcher.identityShared || !!twitchId;
    watcher.lastHeartbeatAt = now;

    updateWalletIdentity(viewer, watcher.twitchId, watcher.displayName);

    if (watcher.pendingCheck && now > Number(watcher.checkExpiresAt || 0)) {
        watcher.pendingCheck = false;
        watcher.checkId = "";
        watcher.checkExpiresAt = 0;
        watcher.sleeping = true;
        saveWatchers();

        return res.json({
            ok: true,
            awarded: false,
            reason: "sleeping_on_duty",
            watch: publicWatchState(watcher)
        });
    }

    if (watcher.sleeping) {
        saveWatchers();

        return res.json({
            ok: true,
            awarded: false,
            reason: "sleeping_on_duty",
            watch: publicWatchState(watcher)
        });
    }

    if (watcher.pendingCheck) {
        saveWatchers();

        return res.json({
            ok: true,
            awarded: false,
            reason: "afk_check_pending",
            watch: publicWatchState(watcher)
        });
    }

    if (shouldSpawnAfkCheck(watcher, now)) {
        watcher.pendingCheck = true;
        watcher.checkId = makeCheckId();
        watcher.checkExpiresAt = now + 120000;
        saveWatchers();

        return res.json({
            ok: true,
            awarded: false,
            reason: "afk_check_required",
            watch: publicWatchState(watcher)
        });
    }

    const lastRewardAt = Number(watcher.lastRewardAt || 0);

    if (lastRewardAt <= 0) {
        watcher.lastRewardAt = now;
        saveWatchers();

        return res.json({
            ok: true,
            awarded: false,
            reason: "watch_started",
            watch: publicWatchState(watcher)
        });
    }

    if (now - lastRewardAt >= 300000) {
        const wallet = getWallet(viewer);

        wallet.dirt += 1;
        watcher.lastRewardAt = now;
        watcher.totalWatchMinutes = Number(watcher.totalWatchMinutes || 0) + 5;

        saveWallets();
        saveWatchers();

        console.log(`[WATCH] +1 Dirt to ${viewer} for watchtime. Balance: ${wallet.dirt}`);

        return res.json({
            ok: true,
            awarded: true,
            amount: 1,
            reason: "watchtime_5_minutes",
            wallet,
            watch: publicWatchState(watcher)
        });
    }

    saveWatchers();

    res.json({
        ok: true,
        awarded: false,
        reason: "waiting",
        watch: publicWatchState(watcher)
    });
});

app.post("/watch/confirm", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const checkId = String(req.body.checkId || "").trim();

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    const watcher = getWatcher(viewer);
    const now = nowMs();

    if (!watcher.pendingCheck) {
        watcher.sleeping = false;
        saveWatchers();

        return res.json({
            ok: true,
            confirmed: true,
            watch: publicWatchState(watcher)
        });
    }

    if (watcher.checkId !== checkId) {
        return res.status(400).json({
            ok: false,
            error: "Wrong duty check"
        });
    }

    if (now > Number(watcher.checkExpiresAt || 0)) {
        watcher.pendingCheck = false;
        watcher.checkId = "";
        watcher.checkExpiresAt = 0;
        watcher.sleeping = true;
        saveWatchers();

        return res.status(400).json({
            ok: false,
            error: "Too late, sleeping on duty",
            watch: publicWatchState(watcher)
        });
    }

    watcher.pendingCheck = false;
    watcher.checkId = "";
    watcher.checkExpiresAt = 0;
    watcher.sleeping = false;
    watcher.lastRewardAt = now;

    saveWatchers();

    res.json({
        ok: true,
        confirmed: true,
        watch: publicWatchState(watcher)
    });
});

app.get("/watch/:viewer", (req, res) => {
    const watcher = getWatcher(scopeViewerFromRequest(req, req.params.viewer));

    if (!watcher) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    res.json({
        ok: true,
        watch: publicWatchState(watcher)
    });
});


app.post("/shop/create-companion", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const minecraftName = String(
        req.body.minecraftName ||
        req.body.minecraftNameOverride ||
        req.body.ownerName ||
        companionName
    ).trim();
    const channelId = req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || "";
    const serverId = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(channelId));

    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion name" });

    if (companionNameExistsForOwner(serverId, minecraftName, companionName)) {
        return res.status(400).json({
            ok: false,
            error: "You already have a companion with that name",
            companionName,
            minecraftName
        });
    }

    const spend = spendDirt(viewer, PRICES.CREATE_COMPANION, "create_companion");
    if (!spend.ok) return res.status(400).json(spend);

    const linkedWallet =
            linkWalletCompanion(
                    viewer,
                    req.body.twitchId || "",
                    req.body.displayName || viewer,
                    companionName,
                    minecraftName,
                    channelId,
                    serverId
            );

    const request = queueShopAction({
        action: "create_companion",
        viewer,
        companionName,
        minecraftName,
        ownerName: minecraftName,
        serverId,
        cost: PRICES.CREATE_COMPANION
    });

    res.json({
        ok: true,
        request,
        wallet: {
            ok: true,
            ...publicWallet(linkedWallet || getWallet(viewer)),
            spent: spend.spent
        }
    });
});
app.post("/shop/buy-trail", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const trailType = Number(req.body.trailType);
    const color = Number(req.body.color);
    const trailTypeName = String(req.body.trailTypeName || "").trim();
    const colorName = String(req.body.colorName || "").trim();
    const allowedTrailTypes = new Set([0, 1, 2, 3]);
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    if (!allowedTrailTypes.has(trailType)) return res.status(400).json({ ok: false, error: "Invalid trail type" });
    if (Number.isNaN(color)) return res.status(400).json({ ok: false, error: "Invalid color" });
    const spend = spendDirt(viewer, PRICES.BUY_TRAIL, "buy_trail");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_trail", viewer, companionName, ...shopCompanionFields(req), trailType, trailTypeName, color, colorName, slot: Number.isInteger(Number(req.body.slot)) ? Number(req.body.slot) : -1, cost: PRICES.BUY_TRAIL });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/trail", (req, res) => { req.body.companionName = req.body.companionName || req.body.viewer; return app._router.handle({ ...req, url: "/shop/buy-trail", method: "POST" }, res, () => {}); });
app.post("/shop/buy-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_RELIC, "buy_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_relic", viewer, companionName, ...shopCompanionFields(req), cost: PRICES.BUY_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/buy-ancient-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_ANCIENT_RELIC, "buy_ancient_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_ancient_relic", viewer, companionName, ...shopCompanionFields(req), cost: PRICES.BUY_ANCIENT_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/reroll-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const slot = Number(req.body.slot);
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return res.status(400).json({ ok: false, error: "Invalid relic slot" });
    const spend = spendDirt(viewer, PRICES.REROLL_RELIC, "reroll_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "reroll_relic", viewer, companionName, ...shopCompanionFields(req), slot, cost: PRICES.REROLL_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/reroll-ancient-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const slot = Number(req.body.slot || 0);
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    if (!Number.isInteger(slot) || slot < 0 || slot > 0) return res.status(400).json({ ok: false, error: "Invalid ancient relic slot" });
    const spend = spendDirt(viewer, PRICES.REROLL_ANCIENT_RELIC, "reroll_ancient_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "reroll_ancient_relic", viewer, companionName, ...shopCompanionFields(req), slot, cost: PRICES.REROLL_ANCIENT_RELIC });
    res.json({ ok: true, request, wallet: spend });
});

function createPaidShopRoute(path, actionName, price, extraBuilder) {
    app.post(path, (req, res) => {
        const viewer = scopeViewerFromRequest(req, req.body.viewer);
        const companionName = String(req.body.companionName || req.body.viewer || "").trim();
        if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });

        const spend = spendDirt(viewer, price, actionName);
        if (!spend.ok) return res.status(400).json(spend);

        const extra = extraBuilder ? extraBuilder(req) : {};
        const request = queueShopAction({ action: actionName, viewer, companionName, ...shopCompanionFields(req), cost: price, ...extra });
        res.json({ ok: true, request, wallet: spend });
    });
}

createPaidShopRoute("/shop/bottle-rhum", "bottle_rhum", PRICES.BOTTLE_RHUM);
createPaidShopRoute("/shop/pay-debt", "pay_debt", PRICES.PAY_DEBT);
createPaidShopRoute("/shop/reroll-legendary", "reroll_legendary", PRICES.REROLL_LEGENDARY);

app.post("/shop/switch-skin", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const skinName = String(req.body.skinName || "").trim();
    if (!viewer || !companionName || !skinName) return res.status(400).json({ ok: false, error: "Missing viewer, companion, or skin" });
    const request = queueShopAction({ action: "switch_skin", viewer, companionName, ...shopCompanionFields(req), skinName, cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/crew-quarters", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "crew_quarters", viewer, companionName, ...shopCompanionFields(req), cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/back-to-work", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "back_to_work", viewer, companionName, ...shopCompanionFields(req), cost: 0 });
    res.json({ ok: true, request });
});


app.get("/forgery/:viewer/:companionName", (req, res) => {
    const requestedViewer = String(req.params.viewer || "").trim();
    const viewer = resolveViewerForState(scopeViewerFromRequest(req, requestedViewer));
    const companionName = String(req.params.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const state = getForgeryState(viewer, companionName);
    res.json({
        ok: true,
        requestedViewer,
        resolvedViewer: viewer,
        forgery: publicForgeryState(state)
    });
});

app.post("/forgery/create", (req, res) => {
    const valid = validateForgeryBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const level = Number(req.body.level || 0);
    if (level < 10) return res.status(400).json({ ok: false, error: "Forgery unlocks at companion level 10." });

    const relicType = String(req.body.relicType || req.body.type || "normal").toLowerCase() === "ancient" ? "ancient" : "normal";
    const slotStatus = relicSlotStatusForRequest(req, valid.viewer, valid.companionName);

    if (relicType === "ancient" && !slotStatus.hasAncientRelic) {
        return res.status(400).json({
            ok: false,
            error: "You need an Ancient Relic equipped before you can craft an Ancient Custom Relic.",
            slotStatus
        });
    }

    const state = getForgeryState(valid.viewer, valid.companionName);
    if (state.customRelic && Array.isArray(state.customRelic.modifiers)) {
        return res.status(400).json({ ok: false, error: "You already have a custom relic in progress.", forgery: publicForgeryState(state) });
    }

    const training = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(training);

    const dirtCost = relicType === "ancient" ? PRICES.FORGERY_CUSTOM_ANCIENT_RELIC : PRICES.FORGERY_CUSTOM_RELIC;
    const normalFragments = relicType === "ancient" ? 0 : 5;
    const ancientFragments = relicType === "ancient" ? 10 : 0;

    if (Number(training.relicFragments || 0) < normalFragments) {
        return res.status(400).json({ ok: false, error: "Not enough Relic Fragments", required: normalFragments, current: Number(training.relicFragments || 0) });
    }
    if (Number(training.ancientRelicFragments || 0) < ancientFragments) {
        return res.status(400).json({ ok: false, error: "Not enough Ancient Relic Fragments", required: ancientFragments, current: Number(training.ancientRelicFragments || 0) });
    }

    const spend = spendDirt(valid.viewer, dirtCost, relicType === "ancient" ? "forgery_custom_ancient_relic" : "forgery_custom_relic");
    if (!spend.ok) return res.status(400).json(spend);

    const fragmentSpend = spendTrainingFragments(training, normalFragments, ancientFragments, relicType === "ancient" ? "Ancient Forgery" : "Forgery");
    if (!fragmentSpend.ok) return res.status(400).json(fragmentSpend);

    state.customRelic = makeCustomRelic(valid.viewer, valid.companionName, relicType);
    state.updatedAt = new Date().toISOString();
    saveForgery();

    res.json({ ok: true, wallet: spend, fragments: fragmentSpend, forgery: publicForgeryState(state), training: publicTrainingState(training) });
});

app.post("/forgery/create-ancient", (req, res) => {
    req.body.relicType = "ancient";
    return app._router.handle({ ...req, url: "/forgery/create", method: "POST" }, res, () => {});
});

app.post("/forgery/buy-modifier", (req, res) => {
    const valid = validateForgeryBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const slot = Number(req.body.slot);
    const modifier = String(req.body.modifier || "").trim();
    if (!FORGERY_MODIFIERS.has(modifier)) return res.status(400).json({ ok: false, error: "Invalid modifier" });

    const state = getForgeryState(valid.viewer, valid.companionName);
    const relic = state.customRelic;
    if (!relic) return res.status(400).json({ ok: false, error: "Create a custom relic first." });
    if (!Number.isInteger(slot) || slot < 0 || slot >= Number(relic.slots || 0)) return res.status(400).json({ ok: false, error: "Invalid custom relic slot." });
    if (relic.modifiers[slot]) return res.status(400).json({ ok: false, error: "That slot is already filled." });

    if (!hasUnlockedModifier(valid.viewer, valid.companionName, modifier)) {
        return res.status(400).json({ ok: false, error: "Research this modifier in the Training Center before using it in Forgery.", modifier });
    }

    const modifierCost = relic.type === "ancient" ? PRICES.FORGERY_ANCIENT_MODIFIER : PRICES.FORGERY_MODIFIER;
    const spend = spendDirt(valid.viewer, modifierCost, relic.type === "ancient" ? "forgery_ancient_modifier" : "forgery_modifier");
    if (!spend.ok) return res.status(400).json(spend);

    relic.modifiers[slot] = modifier;
    relic.modifierCost = modifierCost;
    relic.spentOnModifiers = Number(relic.spentOnModifiers || 0) + modifierCost;
    relic.updatedAt = new Date().toISOString();
    state.updatedAt = relic.updatedAt;
    saveForgery();

    res.json({ ok: true, wallet: spend, forgery: publicForgeryState(state) });
});

app.post("/forgery/reroll", (req, res) => {
    const valid = validateForgeryBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const state = getForgeryState(valid.viewer, valid.companionName);
    const oldRelic = state.customRelic;
    const relicType = oldRelic?.type === "ancient" ? "ancient" : "normal";
    const refund = oldRelic ? Number(oldRelic.spentOnModifiers || 0) : 0;

    if (refund > 0) {
        const wallet = getWallet(valid.viewer);
        wallet.dirt += refund;
        wallet.updatedAt = new Date().toISOString();
        saveWallets();
        console.log(`[FORGERY] Refunded ${refund} modifier Dirt to ${valid.viewer} before reroll.`);
    }

    const spend = spendDirt(valid.viewer, PRICES.FORGERY_REROLL, "forgery_reroll_slots");
    if (!spend.ok) return res.status(400).json(spend);

    state.customRelic = makeCustomRelic(valid.viewer, valid.companionName, relicType);
    state.history = Array.isArray(state.history) ? state.history : [];
    if (oldRelic) state.history.push({ ...oldRelic, rerolledAt: new Date().toISOString(), refundedModifiers: refund });
    state.updatedAt = new Date().toISOString();
    saveForgery();

    const wallet = getWallet(valid.viewer);
    res.json({ ok: true, refunded: refund, wallet: { ok: true, ...publicWallet(wallet), spent: PRICES.FORGERY_REROLL }, forgery: publicForgeryState(state) });
});

app.post("/forgery/forge", (req, res) => {
    const valid = validateForgeryBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const state = getForgeryState(valid.viewer, valid.companionName);
    const relic = state.customRelic;
    if (!relic) return res.status(400).json({ ok: false, error: "Create a custom relic first." });

    const relicType = relic.type === "ancient" ? "ancient" : "normal";
    const slotStatus = relicSlotStatusForRequest(req, valid.viewer, valid.companionName);

    let replaceSlot = Number(req.body.replaceSlot);

    if (relicType === "ancient") {
        replaceSlot = 0;
        if (!slotStatus.hasAncientRelic) return res.status(400).json({ ok: false, error: "You need an Ancient Relic equipped before forging an Ancient Custom Relic.", slotStatus });
    } else {
        const relicsFilled = Number(slotStatus.relicsFilled || 0);
        if (!Number.isInteger(replaceSlot) || replaceSlot < 0 || replaceSlot > 3) return res.status(400).json({ ok: false, error: "Invalid relic slot to replace." });
        if (relicsFilled < 4) return res.status(400).json({ ok: false, error: "All 4 relic slots must be filled before forging.", slotStatus });
    }

    if (!Array.isArray(relic.modifiers) || relic.modifiers.length !== Number(relic.slots || 0) || relic.modifiers.some(mod => !mod)) {
        return res.status(400).json({ ok: false, error: "Fill every custom relic slot before forging." });
    }

    const request = queueShopAction({
        action: relicType === "ancient" ? "forge_custom_ancient_relic" : "forge_custom_relic",
        viewer: valid.viewer,
        companionName: valid.companionName,
        replaceSlot,
        relicType,
        modifiers: relic.modifiers,
        customSlots: relic.slots,
        cost: 0
    });

    state.lastForgedRelic = { ...relic, replaceSlot, relicType, forgedAt: new Date().toISOString(), queueId: request.id };
    state.customRelic = null;
    state.updatedAt = new Date().toISOString();
    saveForgery();

    res.json({ ok: true, request, forgery: publicForgeryState(state) });
});

/* =========================
   Companion Training Center
   ========================= */
const TRAINING_TIERS = {
    basic: { label: "Basic Combat Training", cost: PRICES.TRAINING_BASIC, xpPercent: 0.03, cooldownMs: 2 * 60 * 60 * 1000 },
    advanced: { label: "Advanced Combat Training", cost: PRICES.TRAINING_ADVANCED, xpPercent: 0.08, cooldownMs: 4 * 60 * 60 * 1000 },
    elite: { label: "Elite Combat Training", cost: PRICES.TRAINING_ELITE, xpPercent: 0.15, cooldownMs: 8 * 60 * 60 * 1000 }
};

const STUDY_FOCUSES = ["vault_xp", "watchtime_dirt", "quest_rewards"];
const TRAINING_MODIFIERS = Array.from(FORGERY_MODIFIERS || []);
const EXPEDITION_DURATION_MS = 5 * 60 * 1000;

const STUDY_MANUAL_CAP = 10;
const STUDY_SPARRING_CAP = 25;
const CAPTAIN_NAMES = new Set(["djhilha", "hilha"]);
const CAPTAIN_WIN_MESSAGES = [
    "Another victory for the Captain!",
    "The Captain remains undefeated!",
    "Captain Hilha sent another challenger overboard!",
    "Mutiny?! Quartermaster?!"
];
const SPARRING_BONUS_RATING = {
    basic: 1,
    advanced: 2,
    elite: 5,
    agility: 2,
    study: 2,
    expedition: 5,
    sparring: 2,
    specialization: 2
};
const SPARRING_BONUS_LABELS = {
    basic: "Basic",
    advanced: "Advanced",
    elite: "Elite",
    agility: "Agility",
    study: "Study",
    expedition: "Expedition",
    sparring: "Sparring",
    specialization: "Specialization"
};

function trainingKey(viewer, companionName) {
    return companionStateKeyFor(viewer, companionName);
}

function getTrainingState(viewer, companionName) {
    const key = trainingKey(viewer, companionName);
    if (!key || key === "::") return null;
    if (!trainingData[key]) {
        trainingData[key] = {
            viewer: normalizeViewer(viewer),
            companionName: String(companionName || "").trim(),
            academyLevel: 1,
            masteryXp: 0,
            masteryLevel: 1,
            cooldowns: {},
            dailyLastAt: 0,
            study: { vault_xp: 0, watchtime_dirt: 0, quest_rewards: 0 },
            relicFragments: 0,
            ancientRelicFragments: 0,
            modifierKnowledge: { companion_challenge: true },
            starterModifierChosen: false,
            starterModifier: "",
            activeResearch: [],
            expedition: null,
            sparWins: 0,
            sparLosses: 0,
            currentWinStreak: 0,
            bestWinStreak: 0,
            sparringBonuses: {},
            history: [],
            updatedAt: new Date().toISOString()
        };
        saveTraining();
    }

    const state = trainingData[key];
    state.cooldowns = state.cooldowns || {};
    state.study = state.study || { vault_xp: 0, watchtime_dirt: 0, quest_rewards: 0 };
    state.modifierKnowledge = state.modifierKnowledge || {};
    state.modifierKnowledge.companion_challenge = true;
    state.activeResearch = Array.isArray(state.activeResearch) ? state.activeResearch : [];
    state.sparWins = Number(state.sparWins || 0);
    state.sparLosses = Number(state.sparLosses || 0);
    state.currentWinStreak = Number(state.currentWinStreak || 0);
    state.bestWinStreak = Number(state.bestWinStreak || 0);
    state.sparringBonuses = state.sparringBonuses && typeof state.sparringBonuses === "object" ? state.sparringBonuses : {};
    state.relicFragments = Number(state.relicFragments || 0);
    state.ancientRelicFragments = Number(state.ancientRelicFragments || 0);
    state.academyLevel = Math.max(1, Math.min(10, Number(state.academyLevel || 1)));
    state.masteryLevel = Math.max(1, Number(state.masteryLevel || 1));
    return state;
}

function academyAncientFragmentChance(state) {
    const level = Math.max(1, Math.min(10, Number(state?.academyLevel || 1)));
    return Math.min(0.50, level * 0.05);
}

function researchQueueLimit(state) {
    const level = Number(state?.academyLevel || 1);
    if (level >= 10) return 3;
    if (level >= 5) return 2;
    return 1;
}

function getUnlockedModifiers(state) {
    if (!state) return ["companion_challenge"];
    state.modifierKnowledge = state.modifierKnowledge || {};
    state.modifierKnowledge.companion_challenge = true;
    return Object.keys(state.modifierKnowledge).filter(key => !!state.modifierKnowledge[key] && FORGERY_MODIFIERS.has(key));
}

function researchCatalogForState(state) {
    const level = Number(state?.academyLevel || 1);
    const catalog = {};
    for (const [tier, data] of Object.entries(MODIFIER_RESEARCH)) {
        catalog[tier] = data.modifiers.map(modifier => ({
            id: modifier,
            label: MODIFIER_LABELS[modifier] || modifier,
            unlocked: getUnlockedModifiers(state).includes(modifier),
            ...modifierResearchConfig(modifier, level)
        }));
    }
    return catalog;
}

function finalizeTrainingState(state) {
    if (!state) return state;
    state.activeResearch = Array.isArray(state.activeResearch) ? state.activeResearch : [];
    const now = Date.now();
    let changed = false;
    const stillActive = [];

    for (const job of state.activeResearch) {
        if (Number(job.completeAt || 0) <= now) {
            state.modifierKnowledge = state.modifierKnowledge || {};
            state.modifierKnowledge[job.modifier] = true;
            addTrainingHistory(state, `Research complete: ${MODIFIER_LABELS[job.modifier] || job.modifier}.`);
            changed = true;
        } else {
            stillActive.push(job);
        }
    }

    if (changed || stillActive.length !== state.activeResearch.length) {
        state.activeResearch = stillActive;
        state.updatedAt = new Date().toISOString();
        saveTraining();
    }

    return state;
}

function publicTrainingState(state) {
    if (!state) return null;
    finalizeTrainingState(state);
    const unlockedModifiers = getUnlockedModifiers(state);
    const totalModifiers = TRAINING_MODIFIERS.length;
    return {
        viewer: state.viewer,
        companionName: state.companionName,
        academyLevel: Number(state.academyLevel || 1),
        masteryXp: Number(state.masteryXp || 0),
        masteryLevel: Number(state.masteryLevel || 1),
        cooldowns: state.cooldowns || {},
        dailyLastAt: Number(state.dailyLastAt || 0),
        dailyReady: Date.now() - Number(state.dailyLastAt || 0) >= 24 * 60 * 60 * 1000,
        study: state.study || {},
        relicFragments: Number(state.relicFragments || 0),
        ancientRelicFragments: Number(state.ancientRelicFragments || 0),
        ancientFragmentChance: academyAncientFragmentChance(state),
        modifierKnowledge: state.modifierKnowledge || {},
        unlockedModifiers,
        knownMods: unlockedModifiers.length,
        totalMods: totalModifiers,
        starterModifierChosen: !!state.starterModifierChosen,
        starterModifier: state.starterModifier || "",
        starterChoices: Array.from(STARTER_FORGING_MODIFIERS),
        activeResearch: state.activeResearch || [],
        researchQueueLimit: researchQueueLimit(state),
        researchCatalog: researchCatalogForState(state),
        expedition: state.expedition || null,
        sparWins: Number(state.sparWins || 0),
        sparLosses: Number(state.sparLosses || 0),
        currentWinStreak: Number(state.currentWinStreak || 0),
        bestWinStreak: Number(state.bestWinStreak || 0),
        sparringBonuses: state.sparringBonuses || {},
        combatRating: calculateCombatRating(state, 0).base,
        history: Array.isArray(state.history) ? state.history.slice(-8).reverse() : [],
        updatedAt: state.updatedAt || "",
        tiers: TRAINING_TIERS,
        prices: {
            study: PRICES.TRAINING_STUDY,
            expedition: PRICES.TRAINING_EXPEDITION,
            minigame: PRICES.TRAINING_MINIGAME,
            sparring: PRICES.TRAINING_SPARRING
        }
    };
}

function validateTrainingBody(req) {
    const scopedInput = scopeViewerFromRequest(req, req.body.viewer);
    const viewer = resolveViewerForState(scopedInput);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return { ok: false, status: 400, error: "Missing viewer or companion." };
    return { ok: true, viewer, companionName, requestedViewer: String(req.body.viewer || "").trim() };
}

function addTrainingHistory(state, text) {
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push({ at: new Date().toISOString(), text });
    state.history = state.history.slice(-30);
    state.updatedAt = new Date().toISOString();
}

function addMastery(state, amount) {
    state.masteryXp = Number(state.masteryXp || 0) + Math.max(1, amount);
    state.masteryLevel = Math.max(1, Math.floor(state.masteryXp / 100) + 1);
}

function isCaptainName(value) {
    return CAPTAIN_NAMES.has(String(value || "").trim().toLowerCase());
}

function displayFighterName(value, fallback = "Unknown") {
    const clean = String(value || "").trim();
    if (!clean) return fallback;
    if (isCaptainName(clean)) return "Captain Hilha";
    return clean;
}

function addSparringRatingBonus(state, bonusType) {
    if (!state) return 0;
    const key = String(bonusType || "").toLowerCase();
    const amount = Number(SPARRING_BONUS_RATING[key] || 0);
    if (amount <= 0) return 0;
    state.sparringBonuses = state.sparringBonuses && typeof state.sparringBonuses === "object" ? state.sparringBonuses : {};
    state.sparringBonuses[key] = Number(state.sparringBonuses[key] || 0) + amount;
    return amount;
}

function totalSparringRatingBonuses(state) {
    const bonuses = state?.sparringBonuses || {};
    return Object.values(bonuses).reduce((sum, value) => sum + Number(value || 0), 0);
}

function manualStudyMaxed(state, focus) {
    return Number(state?.study?.[focus] || 0) >= STUDY_MANUAL_CAP;
}

function addSparringStudyBonus(state) {
    if (!state) return null;
    state.study = state.study || { vault_xp: 0, watchtime_dirt: 0, quest_rewards: 0 };
    const focus = randomItem(STUDY_FOCUSES);
    const current = Number(state.study[focus] || 0);
    const cap = Number(state.academyLevel || 1) >= 10 && current >= STUDY_MANUAL_CAP ? STUDY_SPARRING_CAP : STUDY_MANUAL_CAP;
    if (current >= cap) {
        return { focus, added: 0, value: current, capped: true };
    }
    const next = Math.min(cap, Number((current + 0.25).toFixed(2)));
    state.study[focus] = next;
    return { focus, added: Number((next - current).toFixed(2)), value: next, capped: false };
}

function calculateCombatRating(state, companionLevel = 0) {
    const level = Math.max(1, Number(companionLevel || state?.companionLevel || 1));
    const base = Math.round(level * 10 + totalSparringRatingBonuses(state));
    const variance = Number((0.90 + Math.random() * 0.20).toFixed(4));
    return {
        base,
        roll: Math.max(1, Math.round(base * variance)),
        variance
    };
}

function recordSparResult(state, won) {
    if (!state) return;
    if (won) {
        state.sparWins = Number(state.sparWins || 0) + 1;
        state.currentWinStreak = Number(state.currentWinStreak || 0) + 1;
        state.bestWinStreak = Math.max(Number(state.bestWinStreak || 0), Number(state.currentWinStreak || 0));
    } else {
        state.sparLosses = Number(state.sparLosses || 0) + 1;
        state.currentWinStreak = 0;
    }
}

function buildSparringChatMessage(challengerName, opponentName, winnerName, captainFight = false, opponentSelected = false) {
    if (captainFight) return randomItem(CAPTAIN_WIN_MESSAGES);
    const challenger = displayFighterName(challengerName, "A viewer");
    const opponent = opponentSelected ? displayFighterName(opponentName, "Training Dummy") : "a training dummy";
    const winner = displayFighterName(winnerName, challenger);
    if (opponentSelected) {
        return `${challenger} sparred with ${opponent}. ${winner} won!`;
    }
    return `${challenger} went sparring and ${winner} won!`;
}

function buildSparringArenaChatBlock(details) {
    const challenger = displayFighterName(details.challengerName, "A viewer");
    const opponent = displayFighterName(details.opponentName, details.opponentSelected ? "Training Dummy" : "Training Dummy");
    const winner = displayFighterName(details.winnerName, challenger);
    const challengerRating = Number(details.challengerRating || 0);
    const opponentRating = Number(details.opponentRating || 0);
    const xpPercent = Math.round(Number(details.xpPercent || 0) * 100);
    const streak = Number(details.winStreak || 0);
    const bonusLabel = String(details.bonusLabel || "").trim();
    const bonusAmount = Number(details.bonusAmount || 0);
    const flavor = String(details.flavor || "").trim();

    // Minecraft chat does not support the graphic overlay from the mockup.
    // This is the clean chat version: one [Meowty Arena] prefix at the top,
    // no broken emoji boxes, and color-coded text using Minecraft formatting.
    const challengerColor = isCaptainName(challenger) ? "§6" : "§f";
    const opponentColor = isCaptainName(opponent) ? "§6" : "§c";
    const winnerColor = isCaptainName(winner) ? "§6" : "§e";

    const lines = [
        "§6==============================",
        "§e        MEOWTY TRAINING ARENA",
        "§6==============================",
        `${challengerColor}${challenger} §a(${challengerRating}) §7x VS x ${opponentColor}${opponent} §c(${opponentRating})`,
        "§8------------------------------",
        `§6Winner: ${winnerColor}${winner}`,
        `§bXP Reward: §a+${xpPercent}% §fTNL XP`,
        `§dWin Streak: §f${streak}`
    ];

    if (bonusLabel && bonusAmount > 0) {
        lines.push(`§9Training Bonus: §b${bonusLabel} §a(+${bonusAmount})`);
    }

    if (flavor) {
        lines.push("§8------------------------------", `§6${flavor}`);
    }

    lines.push("§6==============================");

    return lines.join("\n");
}

function randomItem(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function maybeApplyAcademyXpBonus(state, basePercent) {
    const academyBonus = Math.min(0.20, (Number(state.academyLevel || 1) - 1) * 0.015);
    return Number((basePercent + academyBonus).toFixed(4));
}

function setCooldown(state, key, ms) {
    state.cooldowns = state.cooldowns || {};
    state.cooldowns[key] = Date.now() + ms;
}

function isOnCooldown(state, key) {
    return Number(state.cooldowns?.[key] || 0) > Date.now();
}

function secondsLeft(state, key) {
    return Math.ceil(Math.max(0, Number(state.cooldowns?.[key] || 0) - Date.now()) / 1000);
}

app.get("/training/:viewer/:companionName", (req, res) => {
    const requestedViewer = String(req.params.viewer || "").trim();
    const viewer = resolveViewerForState(scopeViewerFromRequest(req, requestedViewer));
    const companionName = String(req.params.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const state = getTrainingState(viewer, companionName);
    finalizeTrainingState(state);
    res.json({
        ok: true,
        requestedViewer,
        resolvedViewer: viewer,
        training: publicTrainingState(state)
    });
});

app.post("/training/combat", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const tierName = String(req.body.tier || "basic").toLowerCase();
    const tier = TRAINING_TIERS[tierName];
    if (!tier) return res.status(400).json({ ok: false, error: "Invalid training tier." });
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    if (isOnCooldown(state, `combat_${tierName}`)) return res.status(400).json({ ok: false, error: `Training cooldown: ${secondsLeft(state, `combat_${tierName}`)}s left.` });
    const spend = spendDirt(valid.viewer, tier.cost, `training_combat_${tierName}`);
    if (!spend.ok) return res.status(400).json(spend);
    const xpPercent = maybeApplyAcademyXpBonus(state, tier.xpPercent);
    const request = queueShopAction({ action: "training_xp", viewer: valid.viewer, companionName: valid.companionName, xpPercent, trainingType: tierName, cost: tier.cost });
    addMastery(state, tierName === "elite" ? 35 : tierName === "advanced" ? 20 : 10);
    const sparBonus = addSparringRatingBonus(state, tierName);
    setCooldown(state, `combat_${tierName}`, tier.cooldownMs);
    addTrainingHistory(state, `${tier.label}: queued ${Math.round(xpPercent * 100)}% TNL XP.${sparBonus ? ` Sparring rating +${sparBonus}.` : ""}`);
    saveTraining();
    res.json({ ok: true, request, wallet: spend, training: publicTrainingState(state) });
});

app.post("/training/daily", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    if (Date.now() - Number(state.dailyLastAt || 0) < 24 * 60 * 60 * 1000) return res.status(400).json({ ok: false, error: "Daily training is not ready yet." });

    const reward = randomItem(["xp", "dirt"]);
    let request = null;
    let wallet = publicWallet(getWallet(valid.viewer));
    if (reward === "xp") {
        request = queueShopAction({ action: "training_xp", viewer: valid.viewer, companionName: valid.companionName, xpPercent: 0.05, trainingType: "daily", cost: 0 });
        addTrainingHistory(state, "Daily Training: +5% TNL XP queued.");
    } else {
        const amount = 25 + Math.floor(Math.random() * 51);
        const w = getWallet(valid.viewer); w.dirt += amount; w.updatedAt = new Date().toISOString(); saveWallets(); wallet = publicWallet(w);
        addTrainingHistory(state, `Daily Training: found ${amount} Dirt.`);
    }
    state.dailyLastAt = Date.now();
    addMastery(state, 15);
    saveTraining();
    res.json({ ok: true, request, wallet: { ok: true, ...wallet }, training: publicTrainingState(state) });
});

app.post("/training/study", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const focus = String(req.body.focus || "vault_xp").toLowerCase();
    if (!STUDY_FOCUSES.includes(focus)) return res.status(400).json({ ok: false, error: "Invalid study focus." });
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    state.study = state.study || {};
    if (manualStudyMaxed(state, focus)) {
        return res.status(400).json({ ok: false, error: "That study is already maxed. Sparring bonuses can still push it higher later." });
    }
    const spend = spendDirt(valid.viewer, PRICES.TRAINING_STUDY, "training_study");
    if (!spend.ok) return res.status(400).json(spend);
    state.study[focus] = Math.min(STUDY_MANUAL_CAP, Number((Number(state.study[focus] || 0) + 0.25).toFixed(2)));
    addMastery(state, 12);
    const sparBonus = addSparringRatingBonus(state, "study");
    addTrainingHistory(state, `Study: ${focus.replace(/_/g, ' ')} improved to ${state.study[focus]}%.${sparBonus ? ` Sparring rating +${sparBonus}.` : ""}`);
    saveTraining();
    res.json({ ok: true, wallet: spend, training: publicTrainingState(state) });
});

app.post("/training/choose-starter-modifier", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const modifier = String(req.body.modifier || "").trim();
    if (!STARTER_FORGING_MODIFIERS.has(modifier)) return res.status(400).json({ ok: false, error: "Invalid starter modifier." });
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    if (state.starterModifierChosen) return res.status(400).json({ ok: false, error: "Starter forging discipline already chosen." });
    state.starterModifierChosen = true;
    state.starterModifier = modifier;
    state.modifierKnowledge = state.modifierKnowledge || {};
    state.modifierKnowledge.companion_challenge = true;
    state.modifierKnowledge[modifier] = true;
    addMastery(state, 10);
    addTrainingHistory(state, `First forging discipline chosen: ${MODIFIER_LABELS[modifier] || modifier}.`);
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/training/modifier-research", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const modifier = String(req.body.modifier || "").trim();
    if (!FORGERY_MODIFIERS.has(modifier)) return res.status(400).json({ ok: false, error: "Invalid modifier." });

    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);

    if (getUnlockedModifiers(state).includes(modifier)) {
        return res.status(400).json({ ok: false, error: "Modifier already researched.", modifier });
    }
    if ((state.activeResearch || []).some(job => job.modifier === modifier)) {
        return res.status(400).json({ ok: false, error: "Modifier is already being researched.", modifier });
    }
    if ((state.activeResearch || []).length >= researchQueueLimit(state)) {
        return res.status(400).json({ ok: false, error: "No research queue available.", activeResearch: state.activeResearch, limit: researchQueueLimit(state) });
    }

    const config = modifierResearchConfig(modifier, state.academyLevel);
    if (Number(state.relicFragments || 0) < config.costFragments) {
        return res.status(400).json({ ok: false, error: "Not enough Relic Fragments", required: config.costFragments, current: Number(state.relicFragments || 0) });
    }

    const spend = spendDirt(valid.viewer, config.costDirt, "training_modifier_research");
    if (!spend.ok) return res.status(400).json(spend);

    const fragmentSpend = spendTrainingFragments(state, config.costFragments, 0, `Research ${config.label}`);
    if (!fragmentSpend.ok) return res.status(400).json(fragmentSpend);

    const now = Date.now();
    const job = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        modifier,
        label: config.label,
        tier: config.tier,
        startedAt: now,
        completeAt: now + config.durationMs,
        costDirt: config.costDirt,
        costFragments: config.costFragments
    };
    state.activeResearch = state.activeResearch || [];
    state.activeResearch.push(job);
    addMastery(state, 18);
    addTrainingHistory(state, `Research started: ${config.label}.`);
    saveTraining();
    res.json({ ok: true, job, wallet: spend, fragments: fragmentSpend, training: publicTrainingState(state) });
});

app.post("/training/claim-research", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/training/expedition", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);

    const now = Date.now();
    const expedition = state.expedition || null;

    if (expedition && Number(expedition.completeAt || 0) > now) {
        return res.status(400).json({ ok: false, error: "Expedition still in progress.", expedition, remainingMs: Number(expedition.completeAt || 0) - now, training: publicTrainingState(state) });
    }

    if (expedition && Number(expedition.completeAt || 0) <= now) {
        const chance = Number(expedition.ancientChance || academyAncientFragmentChance(state));
        const ancientFound = Math.random() < chance;
        state.relicFragments = Number(state.relicFragments || 0) + 1;
        if (ancientFound) state.ancientRelicFragments = Number(state.ancientRelicFragments || 0) + 1;
        state.expedition = null;
        addMastery(state, ancientFound ? 25 : 15);
        const sparBonus = addSparringRatingBonus(state, "expedition");
        addTrainingHistory(state, (ancientFound ? "Expedition complete: found 1 Relic Fragment and 1 Ancient Relic Fragment." : "Expedition complete: found 1 Relic Fragment.") + (sparBonus ? ` Sparring rating +${sparBonus}.` : ""));
        saveTraining();
        return res.json({ ok: true, completed: true, reward: { relicFragments: 1, ancientRelicFragments: ancientFound ? 1 : 0, ancientChance: chance }, training: publicTrainingState(state) });
    }

    const spend = spendDirt(valid.viewer, PRICES.TRAINING_EXPEDITION, "training_expedition");
    if (!spend.ok) return res.status(400).json(spend);

    state.expedition = {
        id: `${now}-${Math.random().toString(16).slice(2)}`,
        startedAt: now,
        completeAt: now + EXPEDITION_DURATION_MS,
        ancientChance: academyAncientFragmentChance(state),
        cost: PRICES.TRAINING_EXPEDITION
    };
    addMastery(state, 5);
    addTrainingHistory(state, "Expedition started. Your companion will return in 5 minutes.");
    saveTraining();
    res.json({ ok: true, started: true, wallet: spend, expedition: state.expedition, training: publicTrainingState(state) });
});

app.post("/training/expedition/claim", (req, res) => {
    req.url = "/training/expedition";
    return app._router.handle(req, res, () => {});
});

app.post("/training/agility", (req, res) => {
    return res.status(410).json({ ok: false, error: "Agility Training has been removed. Trails are bought from the Shop." });
});

app.post("/training/relic-research", (req, res) => {
    return res.status(410).json({ ok: false, error: "Relic Research has been removed. Fragments now come from Expeditions only." });
});

app.post("/training/rest", (req, res) => {
    return res.status(410).json({ ok: false, error: "Rest is currently disabled." });
});

app.post("/training/minigame", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const style = String(req.body.style || "power").toLowerCase();
    const spend = spendDirt(valid.viewer, PRICES.TRAINING_MINIGAME, "training_minigame");
    if (!spend.ok) return res.status(400).json(spend);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    const roll = Math.random();
    let xpPercent = 0.03;
    let event = "Success";
    if (roll > 0.95) { xpPercent = 0.15; event = "Critical Success"; }
    else if (roll > 0.75) { xpPercent = 0.08; event = "Great Success"; }
    else if (roll < 0.12) { xpPercent = 0.01; event = "Failure, but learned something"; }
    const request = queueShopAction({ action: "training_xp", viewer: valid.viewer, companionName: valid.companionName, xpPercent, trainingType: `minigame_${style}`, cost: PRICES.TRAINING_MINIGAME });
    addMastery(state, Math.round(xpPercent * 200));
    addTrainingHistory(state, `Mini-game ${style}: ${event}, ${Math.round(xpPercent * 100)}% TNL XP queued.`);
    saveTraining();
    res.json({ ok: true, event, request, wallet: spend, training: publicTrainingState(state) });
});

app.post("/training/spar", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const opponentRaw = String(req.body.opponent || "").trim();
    const opponentSelected = !!opponentRaw && opponentRaw.toLowerCase() !== "training dummy";
    const opponent = opponentSelected ? opponentRaw : "Training Dummy";
    const companionLevel = Number(req.body.level || req.body.companionLevel || 1);

    const spend = spendDirt(valid.viewer, PRICES.TRAINING_SPARRING, "training_sparring");
    if (!spend.ok) return res.status(400).json(spend);

    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);

    const challengerName = publicWallet(getWallet(valid.viewer))?.displayName || valid.companionName || valid.viewer;
    const challengerIsCaptain = isCaptainName(challengerName) || isCaptainName(valid.companionName);
    const opponentIsCaptain = isCaptainName(opponent);
    const captainFight = challengerIsCaptain || opponentIsCaptain;

    let opponentState = null;
    let opponentCompanionName = opponent;
    let opponentLevel = 1;

    if (opponentSelected && !opponentIsCaptain) {
        const scopedOpponent = scopeViewerFromRequest(req, opponentRaw);
        const opponentWallet = getWalletResolved(scopedOpponent, false) || getWalletResolved(opponentRaw, false);
        if (opponentWallet) {
            const publicOpponentWallet = publicWallet(opponentWallet);
            opponentCompanionName = publicOpponentWallet.companionName || opponentRaw;
            opponentState = getTrainingState(opponentWallet.viewer, opponentCompanionName);
            finalizeTrainingState(opponentState);
        }
    }

    const challengerRating = calculateCombatRating(state, companionLevel);
    const opponentRating = opponentIsCaptain
        ? { base: 999999, roll: 999999, variance: 1 }
        : opponentState
            ? calculateCombatRating(opponentState, opponentLevel)
            : { base: 75, roll: Math.max(1, Math.round(75 * (0.90 + Math.random() * 0.20))), variance: 1 };

    let won;
    if (captainFight) {
        won = challengerIsCaptain && !opponentIsCaptain;
    } else {
        won = challengerRating.roll >= opponentRating.roll;
    }

    recordSparResult(state, won);
    if (opponentState && opponentSelected) {
        recordSparResult(opponentState, !won);
        opponentState.updatedAt = new Date().toISOString();
    }

    const xpPercent = won ? 0.07 : 0.025;
    const request = queueShopAction({ action: "training_xp", viewer: valid.viewer, companionName: valid.companionName, xpPercent, trainingType: "sparring", cost: PRICES.TRAINING_SPARRING });

    const sparBonusType = randomItem(Object.keys(SPARRING_BONUS_RATING));
    const sparBonus = addSparringRatingBonus(state, sparBonusType);
    let studyBonus = null;
    if (sparBonusType === "study") {
        studyBonus = addSparringStudyBonus(state);
    }

    addMastery(state, won ? 18 : 7);

    const winnerName = captainFight
        ? "Captain Hilha"
        : won
            ? (challengerName || valid.companionName)
            : opponent;

    const bonusLabel = SPARRING_BONUS_LABELS[sparBonusType] || sparBonusType;
    const flavorMessage = buildSparringChatMessage(challengerName || valid.companionName, opponent, winnerName, captainFight, opponentSelected);
    const chatMessage = buildSparringArenaChatBlock({
        challengerName: challengerName || valid.companionName,
        opponentName: opponent,
        opponentSelected,
        winnerName,
        challengerRating: captainFight && challengerIsCaptain ? 200 : challengerRating.roll,
        opponentRating: captainFight && opponentIsCaptain ? 200 : opponentRating.roll,
        xpPercent,
        winStreak: Number(state.currentWinStreak || 0),
        bonusLabel,
        bonusAmount: sparBonus,
        flavor: flavorMessage
    });
    queueShopAction({ action: "chat_message", message: chatMessage, source: "sparring", viewer: valid.viewer, companionName: valid.companionName, cost: 0 });

    const studyText = studyBonus && studyBonus.added > 0 ? ` ${studyBonus.focus.replace(/_/g, " ")} +${studyBonus.added}%.` : "";
    addTrainingHistory(state, `Sparring vs ${opponent}: ${won ? "won" : "lost"}. Rating ${challengerRating.roll} vs ${opponentRating.roll}. ${Math.round(xpPercent * 100)}% TNL XP queued. ${bonusLabel} sparring rating +${sparBonus}.${studyText}`);

    saveTraining();
    res.json({
        ok: true,
        won,
        opponent,
        winner: winnerName,
        message: chatMessage,
        ratings: { challenger: challengerRating, opponent: opponentRating },
        bonus: { type: sparBonusType, rating: sparBonus, study: studyBonus },
        request,
        wallet: spend,
        training: publicTrainingState(state)
    });
});

app.post("/training/upgrade-academy", (req, res) => {
    const valid = validateTrainingBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    const level = Number(state.academyLevel || 1);
    if (level >= 10) return res.status(400).json({ ok: false, error: "Academy is already level 10." });

    const cost = Math.floor(500 * level * 1.35);
    const spend = spendDirt(valid.viewer, cost, "training_upgrade_academy");
    if (!spend.ok) return res.status(400).json(spend);
    state.academyLevel = level + 1;
    addMastery(state, 25);
    addTrainingHistory(state, `Academy upgraded to level ${state.academyLevel}. Ancient fragment chance is now ${Math.round(academyAncientFragmentChance(state) * 100)}%.`);
    saveTraining();
    res.json({ ok: true, wallet: spend, training: publicTrainingState(state) });
});


/* =========================
   Admin Testing Endpoints
   All require x-api-key
   ========================= */
function adminChannelInputFromRequest(req) {
    return String(
        req?.body?.channel ||
        req?.body?.channelId ||
        req?.query?.channel ||
        req?.query?.channelId ||
        req?.headers?.["x-channel-id"] ||
        ""
    ).trim();
}

function resolveAdminViewerIdentifier(identifier, channelInput = "", serverIdOverride = "") {
    const raw = String(identifier || "").trim();
    const normalized = normalizeViewer(raw);

    if (!normalized) {
        return { ok: false, viewer: "", requestedViewer: raw, resolved: false, channelId: "", serverId: normalizeServerId(serverIdOverride), error: "Missing viewer." };
    }

    const cleanChannelInput = String(channelInput || "").trim();

    // Channel-aware admin commands MUST resolve inside the requested stream.
    // This prevents DjHilha/HalosiaPaage wallets with the same viewer display name
    // from writing fragments/research to the wrong Training Center state.
    if (cleanChannelInput) {
        const resolvedForChannel = resolveWalletKeyForChannel(raw, cleanChannelInput, serverIdOverride);
        if (resolvedForChannel && resolvedForChannel.key) {
            return {
                ok: true,
                viewer: resolvedForChannel.key,
                requestedViewer: raw,
                resolved: resolvedForChannel.key !== normalized,
                channelId: resolvedForChannel.channelId || "",
                serverId: resolvedForChannel.serverId || normalizeServerId(serverIdOverride),
                matchedBy: resolvedForChannel.matchedBy || "channel"
            };
        }

        return {
            ok: false,
            viewer: "",
            requestedViewer: raw,
            resolved: false,
            channelId: resolvedForChannel?.channelId || resolveChannelIdInput(cleanChannelInput, serverIdOverride),
            serverId: resolvedForChannel?.serverId || normalizeServerId(serverIdOverride || resolveServerIdFromChannel(cleanChannelInput)),
            error: `No wallet found for ${raw} in channel ${cleanChannelInput}. Viewer must open/link the extension on that stream first.`
        };
    }

    /*
     * Backwards-compatible path for old admin commands without channel.
     * Prefer exact/global resolution only when no channel was supplied.
     */
    const resolvedKey = resolveWalletKey(raw) || resolveWalletKey(normalized);

    if (resolvedKey) {
        return {
            ok: true,
            viewer: resolvedKey,
            requestedViewer: raw,
            resolved: resolvedKey !== normalized,
            channelId: parseScopedViewerKey(resolvedKey).channelId || "",
            serverId: parseScopedViewerKey(resolvedKey).serverId || normalizeServerId(serverIdOverride)
        };
    }

    return {
        ok: true,
        viewer: normalized,
        requestedViewer: raw,
        resolved: false,
        channelId: "",
        serverId: normalizeServerId(serverIdOverride)
    };
}

function adminTrainingAndForgeryState(viewer, companionName, requestedViewer, channelInput = "") {
    const resolved = resolveAdminViewerIdentifier(viewer, channelInput);
    const finalViewer = resolved.ok ? resolved.viewer : normalizeViewer(viewer);
    const training = getTrainingState(finalViewer, companionName);
    const forgery = getForgeryState(finalViewer, companionName);
    finalizeTrainingState(training);
    return {
        requestedViewer: requestedViewer || resolved.requestedViewer || viewer,
        resolvedViewer: finalViewer,
        resolvedFromDisplayName: !!resolved.resolved,
        channelId: resolved.channelId || parseScopedViewerKey(finalViewer).channelId || "",
        serverId: resolved.serverId || parseScopedViewerKey(finalViewer).serverId || firstEnabledServerId(),
        training: publicTrainingState(training),
        forgery: publicForgeryState(forgery),
        wallet: publicWallet(getWallet(finalViewer))
    };
}

function validateAdminCompanionBody(req) {
    const requestedViewer = String(req.body.viewer || req.body.identifier || "").trim();
    const channelInput = adminChannelInputFromRequest(req);
    const resolved = resolveAdminViewerIdentifier(requestedViewer, channelInput);
    const companionName = String(req.body.companionName || req.body.companion || "").trim();
    if (!resolved.ok || !resolved.viewer || !companionName) {
        return { ok: false, status: 400, error: resolved.error || "Missing viewer or companionName.", requestedViewer, channel: channelInput };
    }
    return {
        ok: true,
        viewer: resolved.viewer,
        requestedViewer: resolved.requestedViewer,
        resolvedFromDisplayName: resolved.resolved,
        channelId: resolved.channelId || parseScopedViewerKey(resolved.viewer).channelId || "",
        serverId: resolved.serverId || parseScopedViewerKey(resolved.viewer).serverId || firstEnabledServerId(),
        companionName
    };
}

app.get("/admin/training/:viewer/:companionName", requireApiKey, (req, res) => {
    const channelInput = adminChannelInputFromRequest(req);
    const resolved = resolveAdminViewerIdentifier(req.params.viewer, channelInput);
    const companionName = String(req.params.companionName || "").trim();
    if (!resolved.ok || !resolved.viewer || !companionName) return res.status(400).json({ ok: false, error: resolved.error || "Missing viewer or companionName." });
    res.json({ ok: true, ...adminTrainingAndForgeryState(resolved.viewer, companionName, resolved.requestedViewer, channelInput) });
});

app.post("/admin/companion/reset", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const tKey = trainingKey(valid.viewer, valid.companionName);
    const fKey = forgeryKey(valid.viewer, valid.companionName);
    const resetTraining = req.body.resetTraining !== false;
    const resetForgery = req.body.resetForgery !== false;

    if (resetTraining) delete trainingData[tKey];
    if (resetForgery) delete forgeryData[fKey];

    saveTraining();
    saveForgery();

    res.json({
        ok: true,
        resetTraining,
        resetForgery,
        ...adminTrainingAndForgeryState(valid.viewer, valid.companionName)
    });
});

app.post("/admin/training/reset", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    delete trainingData[trainingKey(valid.viewer, valid.companionName)];
    saveTraining();
    res.json({ ok: true, ...adminTrainingAndForgeryState(valid.viewer, valid.companionName) });
});

app.post("/admin/forgery/reset", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    delete forgeryData[forgeryKey(valid.viewer, valid.companionName)];
    saveForgery();
    res.json({ ok: true, ...adminTrainingAndForgeryState(valid.viewer, valid.companionName) });
});

app.post("/admin/daily/reset", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    state.dailyLastAt = 0;
    addTrainingHistory(state, "Admin: daily training reset.");
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/cooldowns/clear", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    state.cooldowns = {};
    state.expedition = null;
    addTrainingHistory(state, "Admin: cooldowns and expedition cleared.");
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/fragments/grant", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const relicFragments = Math.floor(Number(req.body.relicFragments ?? req.body.fragments ?? 0));
    const ancientRelicFragments = Math.floor(Number(req.body.ancientRelicFragments ?? req.body.ancientFragments ?? 0));
    if (!Number.isFinite(relicFragments) || !Number.isFinite(ancientRelicFragments)) {
        return res.status(400).json({ ok: false, error: "Invalid fragment amount." });
    }
    const state = getTrainingState(valid.viewer, valid.companionName);
    state.relicFragments = Math.max(0, Number(state.relicFragments || 0) + relicFragments);
    state.ancientRelicFragments = Math.max(0, Number(state.ancientRelicFragments || 0) + ancientRelicFragments);
    addTrainingHistory(state, `Admin: granted ${relicFragments} Relic Fragment(s) and ${ancientRelicFragments} Ancient Relic Fragment(s).`);
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/fragments/set", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    if (req.body.relicFragments !== undefined || req.body.fragments !== undefined) {
        state.relicFragments = Math.max(0, Math.floor(Number(req.body.relicFragments ?? req.body.fragments ?? 0)));
    }
    if (req.body.ancientRelicFragments !== undefined || req.body.ancientFragments !== undefined) {
        state.ancientRelicFragments = Math.max(0, Math.floor(Number(req.body.ancientRelicFragments ?? req.body.ancientFragments ?? 0)));
    }
    addTrainingHistory(state, "Admin: fragment counts set.");
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/xp/grant", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    const xpPercent = Number(req.body.xpPercent ?? req.body.percent ?? 0);
    const xpAmount = Math.floor(Number(req.body.xpAmount ?? req.body.amount ?? 0));
    const masteryXp = Math.floor(Number(req.body.masteryXp ?? 0));

    if ((!Number.isFinite(xpPercent) || xpPercent < 0) && (!Number.isFinite(xpAmount) || xpAmount < 0) && masteryXp <= 0) {
        return res.status(400).json({ ok: false, error: "Provide xpPercent, xpAmount, or masteryXp." });
    }

    const state = getTrainingState(valid.viewer, valid.companionName);
    let request = null;

    if (xpPercent > 0 || xpAmount > 0) {
        request = queueShopAction({
            action: "training_xp",
            viewer: valid.viewer,
            companionName: valid.companionName,
            xpPercent: xpPercent > 0 ? xpPercent : 0,
            xpAmount: xpAmount > 0 ? xpAmount : 0,
            trainingType: "admin_grant",
            cost: 0
        });
        addTrainingHistory(state, `Admin: queued XP grant${xpPercent > 0 ? ` (${Math.round(xpPercent * 100)}% TNL)` : ""}${xpAmount > 0 ? ` (${xpAmount} raw XP)` : ""}.`);
    }

    if (masteryXp > 0) {
        addMastery(state, masteryXp);
        addTrainingHistory(state, `Admin: granted ${masteryXp} Training Mastery XP.`);
    }

    saveTraining();
    res.json({ ok: true, request, training: publicTrainingState(state) });
});

app.post("/admin/modifier/unlock", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);

    let modifiers = [];
    if (req.body.modifier === "all" || req.body.modifiers === "all") {
        modifiers = Array.from(FORGERY_MODIFIERS);
    } else if (Array.isArray(req.body.modifiers)) {
        modifiers = req.body.modifiers.map(m => String(m || "").trim()).filter(Boolean);
    } else {
        modifiers = [String(req.body.modifier || "").trim()].filter(Boolean);
    }

    if (modifiers.length === 0) return res.status(400).json({ ok: false, error: "Missing modifier or modifiers." });
    const invalid = modifiers.filter(mod => !FORGERY_MODIFIERS.has(mod));
    if (invalid.length > 0) return res.status(400).json({ ok: false, error: "Invalid modifier(s).", invalid });

    const state = getTrainingState(valid.viewer, valid.companionName);
    state.modifierKnowledge = state.modifierKnowledge || {};
    state.modifierKnowledge.companion_challenge = true;
    for (const modifier of modifiers) state.modifierKnowledge[modifier] = true;
    state.activeResearch = (state.activeResearch || []).filter(job => !modifiers.includes(job.modifier));
    addTrainingHistory(state, `Admin: unlocked modifier(s): ${modifiers.map(m => MODIFIER_LABELS[m] || m).join(", ")}.`);
    saveTraining();
    res.json({ ok: true, unlocked: modifiers, training: publicTrainingState(state) });
});

app.post("/admin/modifier/lock", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const modifier = String(req.body.modifier || "").trim();
    if (!FORGERY_MODIFIERS.has(modifier)) return res.status(400).json({ ok: false, error: "Invalid modifier." });
    if (modifier === "companion_challenge") return res.status(400).json({ ok: false, error: "Companion Challenge cannot be locked." });
    const state = getTrainingState(valid.viewer, valid.companionName);
    state.modifierKnowledge = state.modifierKnowledge || {};
    delete state.modifierKnowledge[modifier];
    state.activeResearch = (state.activeResearch || []).filter(job => job.modifier !== modifier);
    addTrainingHistory(state, `Admin: locked modifier: ${MODIFIER_LABELS[modifier] || modifier}.`);
    saveTraining();
    res.json({ ok: true, locked: modifier, training: publicTrainingState(state) });
});

app.post("/admin/research/complete", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);

    if (req.body.modifier === "all" || req.body.modifiers === "all") {
        for (const job of state.activeResearch || []) {
            state.modifierKnowledge = state.modifierKnowledge || {};
            state.modifierKnowledge[job.modifier] = true;
        }
        state.activeResearch = [];
        addTrainingHistory(state, "Admin: completed all active research.");
    } else {
        const modifier = String(req.body.modifier || "").trim();
        if (!FORGERY_MODIFIERS.has(modifier)) return res.status(400).json({ ok: false, error: "Invalid modifier." });
        state.modifierKnowledge = state.modifierKnowledge || {};
        state.modifierKnowledge[modifier] = true;
        state.activeResearch = (state.activeResearch || []).filter(job => job.modifier !== modifier);
        addTrainingHistory(state, `Admin: completed research: ${MODIFIER_LABELS[modifier] || modifier}.`);
    }

    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/research/cancel", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const state = getTrainingState(valid.viewer, valid.companionName);
    const modifier = String(req.body.modifier || "").trim();
    if (modifier === "all") {
        state.activeResearch = [];
        addTrainingHistory(state, "Admin: cancelled all active research.");
    } else {
        state.activeResearch = (state.activeResearch || []).filter(job => job.modifier !== modifier);
        addTrainingHistory(state, `Admin: cancelled research: ${MODIFIER_LABELS[modifier] || modifier}.`);
    }
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/admin/academy/set", requireApiKey, (req, res) => {
    const valid = validateAdminCompanionBody(req);
    if (!valid.ok) return res.status(valid.status).json(valid);
    const level = Math.max(1, Math.min(10, Math.floor(Number(req.body.level || req.body.academyLevel || 1))));
    const state = getTrainingState(valid.viewer, valid.companionName);
    state.academyLevel = level;
    addTrainingHistory(state, `Admin: Academy set to level ${level}.`);
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});


app.post("/viewer-link", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const twitchId = String(req.body.twitchId || "").trim();
    const displayName = String(req.body.displayName || viewer).trim();
    const companionName = String(req.body.companionName || "").trim();
    const minecraftName = String(req.body.minecraftName || req.body.ownerName || "").trim();
    const channelId = String(req.body.channelId || "").trim();
    const serverId = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(channelId));

    if (!viewer) {
        return res.status(400).json({ ok: false, error: "Missing viewer" });
    }

    if (companionName && !minecraftName) {
        return res.status(400).json({ ok: false, error: "Enter the Minecraft owner name too, so companions with the same name do not mix." });
    }

    const wallet = linkWalletCompanion(viewer, twitchId, displayName, companionName, minecraftName, channelId, serverId);

    res.json({ ok: true, serverId, wallet: publicWallet(wallet) });
});

app.post("/wallet/alias", requireApiKey, (req, res) => {
    const identifier = String(req.body.identifier || req.body.viewer || "").trim();
    const displayName = String(req.body.displayName || req.body.twitchName || "").trim();

    if (!identifier || !displayName) {
        return res.status(400).json({
            ok: false,
            error: "Missing identifier or displayName"
        });
    }

    const wallet = getWalletResolved(identifier, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found",
            identifier
        });
    }

    wallet.displayName = displayName;
    // This alias is now the authoritative readable name. Identity/heartbeat
    // updates and /mm dirt must not overwrite it automatically.
    wallet.manualAlias = true;
    wallet.updatedAt = new Date().toISOString();

    saveWallets();

    syncViewerLinkToSupabase(wallet).catch(error => {
        console.error("[SUPABASE] Failed syncing wallet alias.", error);
    });

    console.log(`[WALLET] Alias set: ${identifier} -> ${displayName} | Wallet: ${wallet.viewer}`);

    res.json({
        ok: true,
        wallet: publicWallet(wallet)
    });
});


app.get("/wallet/resolve/:identifier", requireApiKey, (req, res) => {
    const identifier = String(req.params.identifier || "").trim();
    const wallet = getWalletResolved(identifier, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found",
            identifier
        });
    }

    res.json({
        ok: true,
        identifier,
        wallet: publicWallet(wallet)
    });
});

app.get("/wallets", requireApiKey, (req, res) => {
    const list =
            Object.values(wallets)
                    .map(publicWallet)
                    .sort((a, b) => String(a.displayName || a.viewer).localeCompare(String(b.displayName || b.viewer)));

    res.json({
        ok: true,
        count: list.length,
        wallets: list
    });
});

let taskVotes = {};

app.post("/tasks/join", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const displayName = String(req.body.displayName || "").trim();
    const twitchId = String(req.body.twitchId || "").trim();
    const voteKey = String(req.body.voteKey || "current");

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (twitchId || displayName) {
        updateWalletIdentity(viewer, twitchId, displayName || viewer);
    }

    const request = queueShopAction({
        action: "task_join",
        viewer,
        companionName,
        displayName,
        twitchId,
        voteKey,
        cost: 0
    });

    res.json({
        ok: true,
        joined: true,
        request
    });
});

app.post("/tasks/vote", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const displayName = String(req.body.displayName || "").trim();
    const twitchId = String(req.body.twitchId || "").trim();
    const vote = String(req.body.vote || "").toLowerCase();
    const voteKey = String(req.body.voteKey || "current");

    if (!viewer || !["support", "doubt"].includes(vote)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid vote"
        });
    }

    if (twitchId || displayName) {
        updateWalletIdentity(viewer, twitchId, displayName || viewer);
    }

    if (!taskVotes[voteKey]) {
        taskVotes[voteKey] = {};
    }

    if (taskVotes[voteKey][viewer]) {
        return res.json({
            ok: true,
            alreadyVoted: true,
            vote: taskVotes[voteKey][viewer]
        });
    }

    taskVotes[voteKey][viewer] = vote;

    const request = queueShopAction({
        action: "task_vote",
        viewer,
        companionName,
        displayName,
        twitchId,
        vote,
        voteKey,
        cost: 0
    });

    res.json({
        ok: true,
        vote,
        request
    });
});


app.get("/shop/actions/queue", requireApiKey, (req, res) => res.json({ ok: true, queue: shopActionQueue }));
app.post("/shop/actions/queue/clear", requireApiKey, (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    shopActionQueue = shopActionQueue.filter(item => !ids.includes(item.id));
    saveQueue();
    res.json({ ok: true, remaining: shopActionQueue.length });
});
app.get("/shop/trail/queue", requireApiKey, (req, res) => res.json({ ok: true, queue: shopActionQueue.filter(item => item.action === "buy_trail") }));
app.post("/shop/trail/queue/clear", requireApiKey, (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    shopActionQueue = shopActionQueue.filter(item => !ids.includes(item.id));
    saveQueue();
    res.json({ ok: true, remaining: shopActionQueue.length });
});
process.on("uncaughtException", error => {
    console.error("[FATAL] Uncaught exception:", error);
});

process.on("unhandledRejection", error => {
    console.error("[FATAL] Unhandled rejection:", error);
});

app.listen(PORT, () => {
    console.log(`Meowtys backend running on port ${PORT}`);

    loadPersistentData()
        .then(() => {
            console.log("[DATA] Startup data loaded.");
        })
        .catch(error => {
            console.error("[DATA] Failed during startup. Server will keep running with fallback data.", error);
        });
});
