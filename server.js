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


function defaultStreamerChannels() {
    return {
        servers: {
            meowtys_s3: {
                enabled: true,
                name: "Meowtys S3",
                channels: {
                    "145555184": "DjHilha"
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

    addOwnerCandidate(candidates, req?.query?.ownerName);
    addOwnerCandidate(candidates, req?.query?.minecraftName);
    addOwnerCandidate(candidates, req?.query?.streamOwner);

    const sid = normalizeServerId(serverId);
    const config = streamerChannels?.servers?.[sid];
    const channels = config?.channels || {};
    const cleanChannel = normalizeChannelId(channelId || firstChannelId(sid));

    if (cleanChannel && Object.prototype.hasOwnProperty.call(channels, cleanChannel)) {
        addOwnerCandidate(candidates, channels[cleanChannel]);
    } else if (!channelId) {
        // If no channel id is provided, use the first configured channel for this server.
        const firstName = Object.values(channels)[0];
        addOwnerCandidate(candidates, firstName);
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
    const wallet = getWalletResolved(viewer, false) || getWallet(viewer);
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
        display_name: String(wallet.displayName || viewerId || ""),
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
        displayName: String(row.display_name || rawViewer || viewer),
        companionName: String(row.companion_name || ""),
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
        .map(walletToSupabaseRow);

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
            const wallet = supabaseRowToWallet(row);

            if (wallet.viewer) {
                wallets[wallet.viewer] = wallet;
            }
        }

        writeJsonFile(WALLETS_FILE, wallets);

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
            updatedAt: new Date().toISOString()
        };
        saveWallets();
    } else {
        wallets[key].viewer = wallets[key].viewer || key;
        wallets[key].dirt = Number(wallets[key].dirt || 0);
        wallets[key].twitchId = String(wallets[key].twitchId || "");
        wallets[key].displayName = String(wallets[key].displayName || key);
        wallets[key].companionName = String(wallets[key].companionName || "");
        wallets[key].updatedAt = wallets[key].updatedAt || new Date().toISOString();
    }

    return wallets[key];
}

function looksLikeNumericId(value) {
    return /^\d+$/.test(String(value || "").trim());
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
     * Twitch mobile often sends the numeric Twitch ID as displayName.
     * Do NOT let that overwrite a real readable Twitch name set by walletalias
     * or by the extension manual Twitch-name box.
     */
    if (cleanDisplayName && !looksLikeNumericId(cleanDisplayName)) {
        wallet.displayName = cleanDisplayName;
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

    // Important: public extension calls and admin commands may send either
    // Twitch display names (DjHilha) or Twitch numeric IDs (145555184).
    // Always resolve through wallets first so training/forgery use the same
    // profile as Dirt wallets.
    return resolveWalletKey(raw) || resolveWalletKey(normalized) || normalized;
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
    const wallet = getWallet(viewer);
    const cost = Math.floor(Number(amount || 0));
    if (!wallet) return { ok: false, error: "Missing viewer" };
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
    const request = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), ...action };
    shopActionQueue.push(request);
    saveQueue();
    console.log(`[SHOP] Queued ${request.action} for ${request.viewer}`);
    return request;
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

    if (!requestedViewer) return res.status(400).json({ ok: false, error: "Missing viewer" });
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const wallet = getWalletResolved(requestedViewer, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found. Viewer must log in with Twitch first, or the companion must be linked.",
            requestedViewer
        });
    }

    const added = Math.floor(amount);

    wallet.dirt += added;
    wallet.updatedAt = new Date().toISOString();

    saveWallets();

    console.log(`[WALLET] +${added} Dirt to ${wallet.viewer} via "${requestedViewer}" | Reason: ${reason} | Balance: ${wallet.dirt}`);

    res.json({
        ok: true,
        ...publicWallet(wallet),
        requestedViewer,
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
    const request = queueShopAction({ action: "buy_trail", viewer, companionName, trailType, trailTypeName, color, colorName, slot: Number.isInteger(Number(req.body.slot)) ? Number(req.body.slot) : -1, cost: PRICES.BUY_TRAIL });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/trail", (req, res) => { req.body.companionName = req.body.companionName || req.body.viewer; return app._router.handle({ ...req, url: "/shop/buy-trail", method: "POST" }, res, () => {}); });
app.post("/shop/buy-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_RELIC, "buy_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_relic", viewer, companionName, cost: PRICES.BUY_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/buy-ancient-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_ANCIENT_RELIC, "buy_ancient_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_ancient_relic", viewer, companionName, cost: PRICES.BUY_ANCIENT_RELIC });
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
    const request = queueShopAction({ action: "reroll_relic", viewer, companionName, slot, cost: PRICES.REROLL_RELIC });
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
    const request = queueShopAction({ action: "reroll_ancient_relic", viewer, companionName, slot, cost: PRICES.REROLL_ANCIENT_RELIC });
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
        const request = queueShopAction({ action: actionName, viewer, companionName, cost: price, ...extra });
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
    const request = queueShopAction({ action: "switch_skin", viewer, companionName, skinName, cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/crew-quarters", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "crew_quarters", viewer, companionName, cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/back-to-work", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "back_to_work", viewer, companionName, cost: 0 });
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
    const hasAncientRelic = !!(req.body.hasAncientRelic || req.body.ancientRelicOwned || Number(req.body.ancientRelicsFilled || 0) >= 1);

    if (relicType === "ancient" && !hasAncientRelic) {
        return res.status(400).json({ ok: false, error: "You need an Ancient Relic equipped before you can craft an Ancient Custom Relic." });
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
    const hasAncientRelic = !!(req.body.hasAncientRelic || req.body.ancientRelicOwned || Number(req.body.ancientRelicsFilled || 0) >= 1);

    let replaceSlot = Number(req.body.replaceSlot);

    if (relicType === "ancient") {
        replaceSlot = 0;
        if (!hasAncientRelic) return res.status(400).json({ ok: false, error: "You need an Ancient Relic equipped before forging an Ancient Custom Relic." });
    } else {
        const relicsFilled = Number(req.body.relicsFilled || 0);
        if (!Number.isInteger(replaceSlot) || replaceSlot < 0 || replaceSlot > 3) return res.status(400).json({ ok: false, error: "Invalid relic slot to replace." });
        if (relicsFilled < 4) return res.status(400).json({ ok: false, error: "All 4 relic slots must be filled before forging." });
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
function resolveAdminViewerIdentifier(identifier) {
    const raw = String(identifier || "").trim();
    const normalized = normalizeViewer(raw);

    if (!normalized) {
        return { ok: false, viewer: "", requestedViewer: raw, resolved: false, error: "Missing viewer." };
    }

    /*
     * Admin commands are meant to be used with readable Twitch display names,
     * for example:
     *   /meowtyadmin setfragments DjHilha Hilha 10 10
     *
     * The extension usually stores the real viewer key as Twitch numeric ID
     * such as 145555184.  Resolve the admin input through the wallet table so
     * commands update the same profile that the extension reads.
     */
    const resolvedKey = resolveWalletKey(raw) || resolveWalletKey(normalized);

    if (resolvedKey) {
        return {
            ok: true,
            viewer: resolvedKey,
            requestedViewer: raw,
            resolved: resolvedKey !== normalized
        };
    }

    return {
        ok: true,
        viewer: normalized,
        requestedViewer: raw,
        resolved: false
    };
}

function adminTrainingAndForgeryState(viewer, companionName, requestedViewer) {
    const resolved = resolveAdminViewerIdentifier(viewer);
    const finalViewer = resolved.ok ? resolved.viewer : normalizeViewer(viewer);
    const training = getTrainingState(finalViewer, companionName);
    const forgery = getForgeryState(finalViewer, companionName);
    finalizeTrainingState(training);
    return {
        requestedViewer: requestedViewer || resolved.requestedViewer || viewer,
        resolvedViewer: finalViewer,
        resolvedFromDisplayName: !!resolved.resolved,
        training: publicTrainingState(training),
        forgery: publicForgeryState(forgery),
        wallet: publicWallet(getWallet(finalViewer))
    };
}

function validateAdminCompanionBody(req) {
    const requestedViewer = String(req.body.viewer || req.body.identifier || "").trim();
    const resolved = resolveAdminViewerIdentifier(requestedViewer);
    const companionName = String(req.body.companionName || req.body.companion || "").trim();
    if (!resolved.ok || !resolved.viewer || !companionName) {
        return { ok: false, status: 400, error: "Missing viewer or companionName." };
    }
    return {
        ok: true,
        viewer: resolved.viewer,
        requestedViewer: resolved.requestedViewer,
        resolvedFromDisplayName: resolved.resolved,
        companionName
    };
}

app.get("/admin/training/:viewer/:companionName", requireApiKey, (req, res) => {
    const resolved = resolveAdminViewerIdentifier(req.params.viewer);
    const companionName = String(req.params.companionName || "").trim();
    if (!resolved.ok || !resolved.viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companionName." });
    res.json({ ok: true, ...adminTrainingAndForgeryState(resolved.viewer, companionName, resolved.requestedViewer) });
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
loadPersistentData()
    .then(() => {
        app.listen(PORT, () => console.log(`Meowtys backend running on port ${PORT}`));
    })
    .catch(error => {
        console.error("[DATA] Failed during startup.", error);
        app.listen(PORT, () => console.log(`Meowtys backend running on port ${PORT} with fallback data`));
    });
