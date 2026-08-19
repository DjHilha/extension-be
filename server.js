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
const RESET_STATE_FILE = path.join(DATA_DIR, "reset_state.json");
const ENCOUNTERS_FILE = path.join(DATA_DIR, "encounters.json");
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
    BUY_DAILY_RELIC: 350,
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
let tasksData = { active: false, tasks: [] }; // legacy fallback
let tasksDataByChannel = {};
let shopActionQueue = [];
let wallets = {};
let watchers = {};
let forgeryData = {};
let trainingData = {};
let streamerChannels = {};
let backendResetState = { epoch: 0 };
let encountersData = {};

// streamer_channels.json is the single source of truth for servers, Twitch channels,
// Minecraft owners and owner UUIDs. There are no streamer/server fallbacks in code.

const PLACEHOLDER_CHANNEL_IDS = new Set(["123456789"]);

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
    const config = streamerChannels?.servers?.[sid] || {};
    for (const [id, name] of Object.entries(config.channels || {})) {
        if (normalizeViewer(name) === wanted) return normalizeViewer(id);
    }
    return "";
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
    // Deliberately empty: deployments must define streamer_channels.json.
    // This prevents a forgotten fallback from silently routing data to an old season/streamer.
    return { servers: {} };
}
function normalizeStreamerChannelsConfig(input) {
    const root = input && typeof input === "object" ? input : {};
    if (!root.servers || typeof root.servers !== "object") root.servers = {};

    for (const [serverId, rawConfig] of Object.entries(root.servers)) {
        const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
        config.enabled = config.enabled !== false;
        config.name = String(config.name || serverId);
        config.uuid = String(config.uuid || config.serverUuid || "");

        const channelMap = {};
        const rawChannels = config.channels;
        if (Array.isArray(rawChannels)) {
            for (const entry of rawChannels) {
                if (!entry || typeof entry !== "object") continue;
                const id = normalizeChannelId(entry.id || entry.channelId || entry.numericId || "");
                const name = String(entry.name || entry.channelName || entry.displayName || "").trim();
                if (id && name) channelMap[id] = name;
            }
        } else if (rawChannels && typeof rawChannels === "object") {
            for (const [key, value] of Object.entries(rawChannels)) {
                const id = normalizeChannelId((value && typeof value === "object") ? (value.id || value.channelId || key) : key);
                const name = String((value && typeof value === "object") ? (value.name || value.channelName || value.displayName || "") : value || "").trim();
                if (id && name) channelMap[id] = name;
            }
        }

        const ownerMap = {};
        const ownerProfiles = {};
        const rawOwners = config.ownerProfiles || config.owners;
        const addOwner = (key, value) => {
            if (value && typeof value === "object") {
                const id = normalizeChannelId(value.id || value.channelId || value.numericId || key || "");
                const ingameName = String(value.ingameName || value.minecraftName || value.ownerName || value.name || "").trim();
                const minecraftUuid = String(value.minecraftUuid || value.uuid || value.ownerUuid || "").trim().toLowerCase();
                if (!id || !ingameName) return;
                ownerMap[id] = ingameName;
                ownerProfiles[id] = { id, channelId: id, ingameName, minecraftUuid };
            } else {
                const id = normalizeChannelId(key || "");
                const ingameName = String(value || "").trim();
                if (!id || !ingameName) return;
                const legacyUuid = String(config.ownerUuids?.[id] || "").trim().toLowerCase();
                ownerMap[id] = ingameName;
                ownerProfiles[id] = { id, channelId: id, ingameName, minecraftUuid: legacyUuid };
            }
        };
        if (Array.isArray(rawOwners)) rawOwners.forEach((value, index) => addOwner(String(index), value));
        else if (rawOwners && typeof rawOwners === "object") Object.entries(rawOwners).forEach(([key, value]) => addOwner(key, value));

        // Fill owner profiles from legacy ownerUuids, and guarantee every configured owner has a profile.
        for (const [id, ingameName] of Object.entries(config.owners && !Array.isArray(config.owners) ? config.owners : {})) {
            if (typeof ingameName === "string" && !ownerMap[id]) addOwner(id, ingameName);
        }
        for (const [id, ingameName] of Object.entries(ownerMap)) {
            if (!ownerProfiles[id]) ownerProfiles[id] = { id, channelId: id, ingameName, minecraftUuid: "" };
            if (!ownerProfiles[id].minecraftUuid && config.ownerUuids?.[id]) ownerProfiles[id].minecraftUuid = String(config.ownerUuids[id]).trim().toLowerCase();
        }

        config.channels = channelMap;
        config.owners = ownerMap;
        config.ownerProfiles = ownerProfiles;
        config.ownerUuids = Object.fromEntries(Object.entries(ownerProfiles).map(([id, p]) => [id, p.minecraftUuid || ""]));
        root.servers[serverId] = config;
    }
    return root;
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

    streamerChannels = normalizeStreamerChannelsConfig(loaded);
    if (!streamerChannels || typeof streamerChannels !== "object") streamerChannels = normalizeStreamerChannelsConfig(defaultStreamerChannels());
    if (!streamerChannels.servers || typeof streamerChannels.servers !== "object") streamerChannels.servers = normalizeStreamerChannelsConfig(defaultStreamerChannels()).servers;


    // Keep a runtime cache copy in DATA_DIR too.
    writeJsonFile(STREAMER_CHANNELS_FILE, streamerChannels);

    const enabledServers = Object.entries(streamerChannels.servers || {}).filter(([, c]) => c && c.enabled !== false);
    const channelCount = enabledServers.reduce((sum, [, c]) => sum + Object.keys(c.channels || {}).length, 0);
    console.log(`[CHANNELS] Active servers: ${enabledServers.length}, allowed channels: ${channelCount}`);
}

function firstEnabledServerId() {
    // When several seasons remain configured (for example S3 + S4), use the
    // last enabled entry as the fallback/current season. Explicit serverId
    // values sent by the mod/extension still always win.
    const enabled = Object.entries(streamerChannels.servers || {})
        .filter(([, config]) => config && config.enabled !== false);
    return enabled.length > 0 ? enabled[enabled.length - 1][0] : "default";
}

function firstChannelId(serverIdOverride = "") {
    const serverId = normalizeServerId(serverIdOverride || firstEnabledServerId());
    const config = streamerChannels?.servers?.[serverId];
    const channels = config?.channels || {};
    const first = Object.keys(channels)[0];
    return normalizeChannelId(first || "");
}

function resolveServerIdFromChannel(channelId) {
    const wanted = String(channelId || "").trim();
    let matchedServer = "";

    // Old and new seasons can contain the same Twitch channels. Prefer the
    // last matching enabled server instead of silently falling back to S3.
    for (const [serverId, config] of Object.entries(streamerChannels.servers || {})) {
        if (!config || config.enabled === false) continue;
        const channels = config.channels || {};

        if (!wanted) {
            matchedServer = serverId;
            continue;
        }

        if (Object.prototype.hasOwnProperty.call(channels, wanted)) {
            matchedServer = serverId;
            continue;
        }

        for (const name of Object.values(channels)) {
            if (String(name || "").toLowerCase() === wanted.toLowerCase()) {
                matchedServer = serverId;
                break;
            }
        }
    }

    return matchedServer || firstEnabledServerId();
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
    return String(serverId || firstEnabledServerId() || "default").trim().toLowerCase();
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
    const requested = String(companionName || linked?.companionName || "").trim();
    const serverId = normalizeServerId(scoped.serverId || linked.serverId || firstEnabledServerId());
    const channelId = normalizeChannelId(scoped.channelId || "default");
    const viewerId = normalizeViewer(scoped.viewerId || viewer);
    const requestedLower = requested.toLowerCase();

    // Keep Academy/Forgery state bound to the exported companion UUID, not to
    // the temporary shape of the viewer's companion link. This prevents a
    // stale/plain wallet link from creating a second blank state.
    if (requestedLower && Array.isArray(companionsData.companions)) {
        const config = streamerChannels?.servers?.[serverId] || {};
        const ownerNames = new Set();
        const owners = config.owners || {};
        for (const [ownerChannelIdRaw, ownerNameRaw] of Object.entries(owners)) {
            const ownerChannelId = normalizeChannelId(ownerChannelIdRaw);
            if (channelId && ownerChannelId && ownerChannelId !== channelId) continue;
            const name = normalizeOwnerName(ownerNameRaw);
            if (name) ownerNames.add(name);
        }

        const matches = companionsData.companions.filter(c => {
            const cServer = normalizeServerId(c?.serverId || serverId);
            const cName = String(c?.name || "").trim().toLowerCase();
            const cOwner = companionOwnerName(c);
            if (cServer !== serverId || cName !== requestedLower) return false;
            return ownerNames.size === 0 || ownerNames.has(cOwner);
        });

        if (matches.length === 1 && String(matches[0]?.ownerUuid || "").trim()) {
            const ownerUuid = String(matches[0].ownerUuid).trim().toLowerCase();
            return `${serverId}::${channelId}::${viewerId}::${ownerUuid}::${requestedLower}`;
        }
    }

    if (linked.ownerUuid && (!requestedLower || String(linked.companionName || "").toLowerCase() === requestedLower)) {
        const ownerUuid = String(linked.ownerUuid).trim().toLowerCase();
        const linkedName = String(linked.companionName || requested).toLowerCase();
        return `${serverId}::${channelId}::${viewerId}::${ownerUuid}::${linkedName}`;
    }

    return `${serverId}::${channelId}::${viewerId}::viewer::${requestedLower}`;
}

function findExistingCompanionState(container, viewer, companionName, canonicalKey) {
    if (!container || typeof container !== "object") return null;
    if (canonicalKey && container[canonicalKey]) return { key: canonicalKey, state: container[canonicalKey] };

    const wallet = getWalletResolved(viewer, false) || wallets[normalizeViewer(viewer)] || null;
    const scoped = parseScopedViewerKey(wallet?.viewer || viewer);
    const wantedServer = normalizeServerId(scoped.serverId || firstEnabledServerId());
    const wantedChannel = normalizeChannelId(scoped.channelId || "default");
    const wantedViewer = normalizeViewer(scoped.viewerId || viewer);
    const wantedCompanion = String(companionName || "").trim().toLowerCase();

    const candidates = [];
    for (const [key, state] of Object.entries(container)) {
        if (!state || typeof state !== "object") continue;
        const stateScoped = parseScopedViewerKey(state.viewer || "");
        const stateServer = normalizeServerId(state.serverId || stateScoped.serverId || wantedServer);
        const stateChannel = normalizeChannelId(state.channelId || stateScoped.channelId || wantedChannel);
        const stateViewer = normalizeViewer(stateScoped.viewerId || state.viewer || "");
        const stateCompanion = String(state.companionName || "").trim().toLowerCase();

        if (stateServer !== wantedServer) continue;
        if (stateChannel && wantedChannel && stateChannel !== wantedChannel) continue;
        if (stateViewer !== wantedViewer && normalizeViewer(state.viewer || "") !== normalizeViewer(viewer)) continue;
        if (stateCompanion !== wantedCompanion) continue;
        candidates.push({ key, state });
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (Date.parse(b.state.updatedAt || "") || 0) - (Date.parse(a.state.updatedAt || "") || 0));
    return candidates[0];
}

function moveCompanionStateToCanonicalKey(container, existing, canonicalKey) {
    if (!existing || !canonicalKey || existing.key === canonicalKey) return existing?.state || null;
    if (!container[canonicalKey]) container[canonicalKey] = existing.state;
    else {
        const current = container[canonicalKey];
        const incoming = existing.state;
        const currentUpdated = Date.parse(current?.updatedAt || "") || 0;
        const incomingUpdated = Date.parse(incoming?.updatedAt || "") || 0;
        container[canonicalKey] = incomingUpdated > currentUpdated
            ? { ...current, ...incoming }
            : { ...incoming, ...current };
    }
    delete container[existing.key];
    return container[canonicalKey];
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
    backendResetState = readJsonFile(RESET_STATE_FILE, { epoch: 0 });
    encountersData = readJsonFile(ENCOUNTERS_FILE, {});
    if (!backendResetState || typeof backendResetState !== "object") backendResetState = { epoch: 0 };
    backendResetState.epoch = Number(backendResetState.epoch || 0);
    for (const state of Object.values(trainingData || {})) migrateLegacyModifierKnowledge(state);

    await loadWalletsFromSupabase();
    prunePlaceholderWalletsFromMemory();
    pruneInvalidChannelWalletsFromMemory();
    await purgePlaceholderWalletsFromSupabase();
    await purgeInvalidChannelWalletsFromSupabase();
    await loadTrainingFromSupabase();
    await loadForgeryFromSupabase();
    await loadProgressionFromSupabase();

    console.log(`[DATA] Loaded ${Object.keys(wallets).length} wallets, ${Object.keys(trainingData).length} training states, ${Object.keys(forgeryData).length} forgery states and ${shopActionQueue.length} queued shop actions and ${Object.keys(watchers).length} watchers.`);
}


function saveWallets() {
    writeJsonFile(WALLETS_FILE, wallets);
    syncWalletsToSupabaseSoon();
}

function saveQueue() { writeJsonFile(QUEUE_FILE, shopActionQueue); }
function saveWatchers() { writeJsonFile(WATCHERS_FILE, watchers); }
function saveEncounters() { writeJsonFile(ENCOUNTERS_FILE, encountersData); }
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
                const rawState = migrateLegacyModifierKnowledge(stateRowToObject(row));
                const serverId = normalizeServerId(rawState.serverId || row.server_id || firstEnabledServerId());
                const channelId = normalizeChannelId(rawState.channelId || row.channel_id || firstChannelId(serverId));
                const rawViewer = normalizeViewer(rawState.viewer || row.viewer || "");
                const scopedViewer = scopedViewerKey(rawViewer, channelId, serverId);
                const companionName = String(rawState.companionName || row.companion_name || "").trim();

                if (!scopedViewer || !companionName) continue;

                const canonicalKey = companionStateKeyFor(scopedViewer, companionName);
                const existing = loaded[canonicalKey];

                if (!existing) {
                    loaded[canonicalKey] = {
                        ...rawState,
                        viewer: scopedViewer,
                        serverId,
                        channelId,
                        companionName,
                        academyLevel: Math.max(1, Number(rawState.academyLevel || 1))
                    };
                    continue;
                }

                // Consolidate duplicate/legacy rows without ever losing progress.
                const existingUpdated = Date.parse(existing.updatedAt || "") || 0;
                const incomingUpdated = Date.parse(rawState.updatedAt || "") || 0;
                const newer = incomingUpdated >= existingUpdated ? rawState : existing;
                const older = newer === rawState ? existing : rawState;

                loaded[canonicalKey] = {
                    ...older,
                    ...newer,
                    viewer: scopedViewer,
                    serverId,
                    channelId,
                    companionName,
                    academyLevel: Math.max(
                        Number(existing.academyLevel || 1),
                        Number(rawState.academyLevel || 1)
                    ),
                    masteryXp: Math.max(
                        Number(existing.masteryXp || 0),
                        Number(rawState.masteryXp || 0)
                    ),
                    masteryLevel: Math.max(
                        Number(existing.masteryLevel || 1),
                        Number(rawState.masteryLevel || 1)
                    ),
                    relicFragments: Math.max(
                        Number(existing.relicFragments || 0),
                        Number(rawState.relicFragments || 0)
                    ),
                    ancientRelicFragments: Math.max(
                        Number(existing.ancientRelicFragments || 0),
                        Number(rawState.ancientRelicFragments || 0)
                    ),
                    modifierKnowledge: {
                        ...(existing.modifierKnowledge || {}),
                        ...(rawState.modifierKnowledge || {}),
                        companion_challenge: true
                    },
                    sparWins: Math.max(Number(existing.sparWins || 0), Number(rawState.sparWins || 0)),
                    sparLosses: Math.max(Number(existing.sparLosses || 0), Number(rawState.sparLosses || 0)),
                    bestWinStreak: Math.max(Number(existing.bestWinStreak || 0), Number(rawState.bestWinStreak || 0)),
                    updatedAt: new Date(Math.max(existingUpdated, incomingUpdated, Date.now())).toISOString()
                };
            }

            trainingData = loaded;
            writeJsonFile(TRAINING_FILE, trainingData);

            // Rewrite the consolidated canonical states back to Supabase.
            await syncAllTrainingToSupabase();

            console.log(`[SUPABASE] Loaded ${rows.length} training row(s) into ${Object.keys(trainingData).length} canonical state(s).`);
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
    const wanted = normalizeViewer(raw);

    if (!wanted) {
        return { key: "", channelId: "", serverId: normalizeServerId(serverIdOverride), matchedBy: "missing" };
    }

    // A plain value such as "DjHilha" is NOT a scoped viewer key. Do not let
    // parseScopedViewerKey() inject an old fallback server into admin commands.
    const rawParts = wanted.split("::");
    const hasExplicitScope = rawParts.length >= 3 && streamerChannels?.servers?.[rawParts[0]];
    const explicitlyScopedServer = hasExplicitScope ? normalizeServerId(rawParts[0]) : "";
    const explicitlyScopedChannel = hasExplicitScope ? normalizeChannelId(rawParts[1]) : "";

    const serverId = normalizeServerId(
        serverIdOverride ||
        explicitlyScopedServer ||
        resolveServerIdFromChannel(channelInput)
    );

    const channelId = resolveChannelIdInput(channelInput || explicitlyScopedChannel, serverId);

    if (!channelId) {
        return { key: "", channelId: "", serverId, matchedBy: "invalid_channel" };
    }

    const channelWallets = Object.entries(wallets || {}).filter(([key, wallet]) => {
        if (!wallet) return false;
        const parsed = parseScopedViewerKey(wallet.viewer || key);
        return normalizeServerId(parsed.serverId || serverId) === serverId
            && normalizeChannelId(parsed.channelId || "") === channelId;
    });

    // Configured Twitch names are converted to the canonical numeric Twitch ID
    // before display-name matching. Example: DjHilha -> 145555184.
    const canonicalViewerId = normalizeViewer(resolveViewerIdInput(wanted, serverId) || "");

    // Twitch identity is authoritative.
    const exactIdentityMatches = channelWallets.filter(([key, wallet]) => {
        const parsed = parseScopedViewerKey(wallet.viewer || key);
        const viewerId = normalizeViewer(parsed.viewerId || "");
        const twitchId = normalizeViewer(wallet.twitchId || "");
        return (
            viewerId === wanted ||
            twitchId === wanted ||
            (canonicalViewerId && (viewerId === canonicalViewerId || twitchId === canonicalViewerId))
        );
    });

    if (exactIdentityMatches.length === 1) {
        return {
            key: exactIdentityMatches[0][0],
            channelId,
            serverId,
            matchedBy: canonicalViewerId ? "canonical_twitch_identity" : "exact_identity"
        };
    }

    if (exactIdentityMatches.length > 1) {
        if (canonicalViewerId) {
            const canonicalKey = scopedViewerKey(canonicalViewerId, channelId, serverId);
            const canonical = exactIdentityMatches.find(([key]) =>
                normalizeViewer(key) === normalizeViewer(canonicalKey)
            );
            if (canonical) {
                return {
                    key: canonical[0],
                    channelId,
                    serverId,
                    matchedBy: "canonical_scoped_identity"
                };
            }
        }
        return { key: "", channelId, serverId, matchedBy: "ambiguous_identity" };
    }

    if (canonicalViewerId) {
        const canonicalKey = scopedViewerKey(canonicalViewerId, channelId, serverId);
        if (wallets[canonicalKey]) {
            return { key: canonicalKey, channelId, serverId, matchedBy: "canonical_scoped_viewer" };
        }
    }

    if (!wanted.includes("::")) {
        const exactScoped = scopedViewerKey(raw, channelId, serverId);
        if (wallets[exactScoped]) {
            return { key: exactScoped, channelId, serverId, matchedBy: "exact_scoped_viewer" };
        }
    }

    // Display-name aliases are only a fallback after canonical Twitch identity.
    const exactDisplayMatches = channelWallets.filter(([, wallet]) =>
        normalizeViewer(wallet.displayName || "") === wanted
    );

    if (exactDisplayMatches.length === 1) {
        return { key: exactDisplayMatches[0][0], channelId, serverId, matchedBy: "exact_display_name" };
    }

    if (exactDisplayMatches.length > 1) {
        return { key: "", channelId, serverId, matchedBy: "ambiguous_display_name" };
    }

    // Admin Dirt commands must never invent a second wallet.
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
    const scoped = parseScopedViewerKey(wallet.viewer || "");

    return {
        viewer: wallet.viewer,
        channelId: scoped.channelId || "",
        rawViewer: scoped.viewerId || wallet.viewer,
        dirt: Number(wallet.dirt || 0),
        twitchId: String(wallet.twitchId || ""),
        displayName: String(wallet.displayName || wallet.viewer || ""),
        serverId: scoped.serverId || linked.serverId || firstEnabledServerId(),
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

function slotIndexFromKey(key) {
    const raw = String(key || "").trim().toLowerCase();
    if (/^\d+$/.test(raw)) return Number(raw);
    const match = raw.match(/(?:slot|relic|relicslot|ancientrelicslot)[_\- ]*(\d+)$/i);
    return match ? Number(match[1]) : null;
}

function slotArrayFromObject(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;

    // Common exporter wrappers.
    for (const field of ["slots", "relics", "relicSlots", "relic_slots", "companionRelics", "companion_relics", "items", "values"]) {
        if (Array.isArray(source[field])) return source[field];
    }

    const entries = [];
    for (const [key, value] of Object.entries(source)) {
        const index = slotIndexFromKey(key);
        if (index !== null && Number.isFinite(index)) entries.push([index, value]);
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => a[0] - b[0]);

    // Build a sparse-ish ordered array so index 4 stays the Ancient Relic slot
    // even if the exporter sends an object like {"0":..., "1":..., "4":...}.
    const arr = [];
    for (const [index, value] of entries) arr[index] = value;
    return arr;
}

function countFilledRelicSlotsFromSource(source, ancientOnly = false) {
    const objectSlots = slotArrayFromObject(source);
    if (objectSlots) return countFilledRelicSlotsFromSource(objectSlots, ancientOnly);

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

function companionCandidatesForViewerAndName(req, viewer, companionName) {
    if (!Array.isArray(companionsData.companions)) return [];

    const wallet = getWalletResolved(viewer, false) || wallets[normalizeViewer(viewer)] || null;
    const linked = wallet ? parseCompanionLink(wallet.companionName || "") : null;
    const requestedName = String(companionName || linked?.companionName || "").trim().toLowerCase();
    if (!requestedName) return [];

    const scoped = parseScopedViewerKey(wallet?.viewer || viewer);
    const requestChannelId = req?.body?.channelId || req?.query?.channelId || req?.headers?.["x-channel-id"] || scoped.channelId || "";
    const requestServerId = normalizeServerId(req?.body?.serverId || req?.query?.serverId || scoped.serverId || linked?.serverId || resolveServerIdFromChannel(requestChannelId));
    const bodyOwner = String(req?.body?.ownerName || req?.body?.minecraftName || "").trim().toLowerCase();
    const linkedOwner = String(linked?.ownerName || "").trim().toLowerCase();
    const linkedOwnerUuid = String(linked?.ownerUuid || "").trim().toLowerCase();

    const ownerCandidates = new Set(ownerCandidatesForRequest(req || { body: {}, query: {}, headers: {} }, requestServerId, requestChannelId));
    if (bodyOwner) ownerCandidates.add(bodyOwner);
    if (linkedOwner) ownerCandidates.add(linkedOwner);

    const exact = [];
    const loose = [];

    for (const c of companionsData.companions) {
        const cServer = normalizeServerId(c.serverId || requestServerId);
        const cName = String(c.name || "").trim().toLowerCase();
        if (cServer !== requestServerId || cName !== requestedName) continue;

        const cOwner = String(c.owner || c.ownerName || c.minecraftName || "").trim().toLowerCase();
        const cOwnerUuid = String(c.ownerUuid || "").trim().toLowerCase();
        const ownerMatches = (linkedOwnerUuid && cOwnerUuid === linkedOwnerUuid) || (ownerCandidates.size > 0 && ownerCandidates.has(cOwner));

        if (ownerMatches) exact.push(c);
        loose.push(c);
    }

    // Prefer channel/owner matched companions. If that fails, fall back to same
    // server + same companion name so a stale/missing wallet link does not make
    // Ancient Relic detection randomly fail.
    return exact.length > 0 ? exact : loose;
}

function findCompanionForViewerAndName(viewer, companionName) {
    const candidates = companionCandidatesForViewerAndName({ body: {}, query: {}, headers: {} }, viewer, companionName);
    return candidates.length === 1 ? candidates[0] : (candidates[0] || null);
}

function relicSlotStatusForRequest(req, viewer, companionName) {
    const candidates = companionCandidatesForViewerAndName(req, viewer, companionName);
    let exportedRelicsFilled = 0;
    let exportedAncientRelicsFilled = 0;

    for (const companion of candidates) {
        exportedRelicsFilled = Math.max(exportedRelicsFilled, countFilledRelicSlotsFromCompanion(companion));
        exportedAncientRelicsFilled = Math.max(exportedAncientRelicsFilled, countFilledAncientRelicSlotsFromCompanion(companion));
    }

    const bodyRelicsFilled = countFilledRelicSlotsFromBody(req, false);
    const bodyAncientFilled = countFilledRelicSlotsFromBody(req, true);

    const relicsFilled = Math.max(bodyRelicsFilled, exportedRelicsFilled);
    const ancientRelicsFilled = Math.max(bodyAncientFilled, exportedAncientRelicsFilled);

    return {
        companionFound: candidates.length > 0,
        companionMatchesChecked: candidates.length,
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
    "gilded_mob_drops",
    "living_mob_drops",
    "ornate_mob_drops",
    "wooden_mob_drops",
    "phoenix",
    "plentiful",
    "xp_gain",
    "pandoras_box",
    "buffed",
    "more_mobs_cata"
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
            "wooden_mob_drops",
            "gilded_mob_drops",
            "living_mob_drops",
            "ornate_mob_drops",
            "buffed",
            "more_mobs_cata"
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
    coin_cascade: "Wealthy",
    wooden_cascade: "Wooden",
    gilded_mob_drops: "Gilded Mob Drops",
    living_mob_drops: "Living Mob Drops",
    ornate_mob_drops: "Ornate Mob Drops",
    wooden_mob_drops: "Wooden Mob Drops",
    phoenix: "Phoenix",
    plentiful: "Plentiful",
    xp_gain: "XP Gain",
    pandoras_box: "Pandora's Box",
    buffed: "Buffed",
    more_mobs_cata: "Onslaught"
};

// Migrate the old extension-only "Bonus chest" research IDs to the real Vault
// modifier IDs. This preserves viewers' completed research after the rename.
const LEGACY_RESEARCH_MODIFIER_IDS = {
    wooden_bonus: "wooden_mob_drops",
    living: "living_mob_drops",
    gilded: "gilded_mob_drops",
    ornate: "ornate_mob_drops"
};

function migrateLegacyModifierKnowledge(state) {
    if (!state || typeof state !== "object") return state;
    const knowledge = state.modifierKnowledge && typeof state.modifierKnowledge === "object"
        ? state.modifierKnowledge
        : {};

    for (const [oldId, newId] of Object.entries(LEGACY_RESEARCH_MODIFIER_IDS)) {
        if (knowledge[oldId] && !knowledge[newId]) knowledge[newId] = true;
    }
    // coin_pile / Bonus Coins is intentionally not migrated into Academy/Forgery.
    state.modifierKnowledge = knowledge;

    if (state.activeResearch && LEGACY_RESEARCH_MODIFIER_IDS[state.activeResearch.modifier]) {
        state.activeResearch.modifier = LEGACY_RESEARCH_MODIFIER_IDS[state.activeResearch.modifier];
    }
    if (state.research && LEGACY_RESEARCH_MODIFIER_IDS[state.research.modifier]) {
        state.research.modifier = LEGACY_RESEARCH_MODIFIER_IDS[state.research.modifier];
    }
    return state;
}

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
        const existing = findExistingCompanionState(forgeryData, viewer, companionName, key);
        if (existing) {
            moveCompanionStateToCanonicalKey(forgeryData, existing, key);
            forgeryData[key].viewer = normalizeViewer(viewer);
            forgeryData[key].companionName = String(companionName || "").trim();
            saveForgery();
            console.log(`[FORGERY] Re-linked existing state ${existing.key} -> ${key}`);
        }
    }

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


function spendDirt(viewer, amount, reason, channelInput = "", serverIdOverride = "") {
    const requested = normalizeViewer(viewer);
    const cleanChannel = String(channelInput || "").trim();
    let resolvedKey = "";
    let resolvedChannelId = "";
    let resolvedServerId = normalizeServerId(serverIdOverride || resolveServerIdFromChannel(cleanChannel));

    if (cleanChannel) {
        const resolved = resolveWalletKeyForChannel(viewer, cleanChannel, resolvedServerId);
        resolvedKey = resolved && resolved.key ? resolved.key : "";
        resolvedChannelId = resolved && resolved.channelId ? resolved.channelId : "";
        resolvedServerId = resolved && resolved.serverId ? resolved.serverId : resolvedServerId;
    } else {
        resolvedKey = resolveWalletKey(viewer) || (wallets[requested] ? requested : "");
    }

    const wallet = resolvedKey ? getWallet(resolvedKey) : null;
    const cost = Math.floor(Number(amount || 0));
    if (!wallet) return { ok: false, error: "Wallet not found for this channel. Viewer must open/link the extension on this stream first.", viewer: requested };
    if (!Number.isFinite(cost) || cost <= 0) return { ok: false, error: "Invalid amount" };
    if (wallet.dirt < cost) {
        return { ok: false, error: "Not enough Dirt", viewer: wallet.viewer, dirt: wallet.dirt, required: cost };
    }
    wallet.dirt -= cost;
    saveWallets();
    const walletScope = parseScopedViewerKey(wallet.viewer || viewer);
    recordProgressionMetric({
        serverId: normalizeServerId(walletScope.serverId || serverIdOverride || firstEnabledServerId()),
        channelId: normalizeChannelId(walletScope.channelId || resolveChannelIdInput(channelInput, serverIdOverride)),
        viewer: normalizeViewer(walletScope.viewerId || viewer)
    }, "dirt_spent", cost, { displayName: wallet.displayName });
    console.log(`[WALLET] -${cost} Dirt from ${wallet.viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`);
    return {
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt,
        spent: cost,
        reason,
        channelId: resolvedChannelId || parseScopedViewerKey(wallet.viewer).channelId || "",
        serverId: resolvedServerId || parseScopedViewerKey(wallet.viewer).serverId || firstEnabledServerId()
    };
}


const DAILY_RELIC_MS = 24 * 60 * 60 * 1000;
const DAILY_RELIC_COMMON = [
    "the_vault:ornate_cascade", "the_vault:living_cascade", "the_vault:gilded_cascade",
    "the_vault:wooden_cascade", "the_vault:coin_cascade", "the_vault:plentiful",
    "the_vault:companion_challenge"
];
const DAILY_RELIC_RARE = [
    "the_vault:ornate_mob_drops", "the_vault:living_mob_drops", "the_vault:gilded_mob_drops",
    "the_vault:wooden_mob_drops", "the_vault:pandoras_box", "the_vault:coin_pile",
    "the_vault:buffed", "the_vault:more_mobs_cata"
];
const DAILY_RELIC_LEGENDARY = ["the_vault:phoenix", "the_vault:extended", "the_vault:xp_gain"];

function seededDailyRandom(seed) {
    let x = (seed >>> 0) || 0x9e3779b9;
    return function() {
        x += 0x6D2B79F5;
        let t = x;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function currentDailyRelicOffer(now = Date.now(), serverIdInput = "", channelIdInput = "") {
    const dayKey = Math.floor(now / DAILY_RELIC_MS);
    const serverId = normalizeServerId(serverIdInput || firstEnabledServerId());
    const channelId = resolveChannelIdInput(channelIdInput, serverId) || normalizeChannelId(channelIdInput || "");
    const scopeSeed = hashDailyRelicScope(`${serverId}::${channelId}`);
    const key = `${serverId}::${channelId}::${dayKey}`;
    const random = seededDailyRandom((dayKey ^ scopeSeed ^ 0x51f15e) >>> 0);
    const roll = random() * 100;
    const slots = roll < 45 ? 4 : (roll < 85 ? 5 : 6); // pretty good, but still below intentional Forgery builds
    const modifiers = [];

    function count(id) { return modifiers.filter(value => value === id).length; }
    for (let i = 0; i < slots; i++) {
        for (let attempt = 0; attempt < 40; attempt++) {
            const rarityRoll = random() * 100;
            const pool = rarityRoll < 55 ? DAILY_RELIC_COMMON : (rarityRoll < 90 ? DAILY_RELIC_RARE : DAILY_RELIC_LEGENDARY);
            const candidate = pool[Math.floor(random() * pool.length)];
            const legendary = DAILY_RELIC_LEGENDARY.includes(candidate);
            if ((legendary && count(candidate) === 0) || (!legendary && count(candidate) < 2)) {
                modifiers.push(candidate);
                break;
            }
        }
    }

    return {
        key: String(key),
        price: PRICES.BUY_DAILY_RELIC,
        slots,
        modifiers,
        serverId,
        channelId,
        startsAt: dayKey * DAILY_RELIC_MS,
        expiresAt: (dayKey + 1) * DAILY_RELIC_MS
    };
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


function configuredStreamerOwner(serverIdInput, channelInput) {
    const serverId = normalizeServerId(serverIdInput || resolveServerIdFromChannel(channelInput));
    const channelId = resolveChannelIdInput(channelInput, serverId);
    const config = streamerChannels?.servers?.[serverId] || {};

    const ownerName = String(config.owners?.[channelId] || "").trim();
    const profile = config.ownerProfiles?.[channelId] || {};

    return {
        serverId,
        channelId: normalizeChannelId(channelId),
        ownerUuid: String(profile.minecraftUuid || profile.uuid || profile.ownerUuid || config.ownerUuids?.[channelId] || "").trim(),
        ownerName: String(profile.ingameName || profile.name || profile.ownerName || ownerName || "").trim()
    };
}

function exportedCompanionForStreamer(serverIdInput, channelInput, companionNameInput, companionUuidInput = "") {
    const configured = configuredStreamerOwner(serverIdInput, channelInput);
    const wantedName = String(companionNameInput || "").trim().toLowerCase();
    const wantedUuid = String(companionUuidInput || "").trim().toLowerCase();

    if (!wantedName || !Array.isArray(companionsData.companions)) return null;

    const matches = companionsData.companions.filter(companion => {
        const cServer = normalizeServerId(companion?.serverId || configured.serverId);
        const cName = String(companion?.name || "").trim().toLowerCase();
        const cUuid = String(companion?.uuid || companion?.companionUuid || "").trim().toLowerCase();
        const cOwnerUuid = String(companion?.ownerUuid || "").trim().toLowerCase();
        const cOwnerName = companionOwnerName(companion);

        if (cServer !== configured.serverId || cName !== wantedName) return false;
        if (wantedUuid && cUuid && cUuid !== wantedUuid) return false;

        if (configured.ownerUuid && cOwnerUuid) {
            return cOwnerUuid === configured.ownerUuid.toLowerCase();
        }
        if (configured.ownerName) {
            return cOwnerName === normalizeOwnerName(configured.ownerName);
        }
        return false;
    });

    return matches.length === 1 ? matches[0] : null;
}

function hashDailyRelicScope(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function shopCompanionFields(req, serverId = "") {
    const requestedChannel = req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || "";
    const configured = configuredStreamerOwner(
        serverId || req.body.serverId || resolveServerIdFromChannel(requestedChannel),
        requestedChannel
    );

    const companionName = String(req.body.companionName || "").trim();
    const exported = exportedCompanionForStreamer(
        configured.serverId,
        configured.channelId,
        companionName,
        req.body.companionUuid || req.body.uuid || ""
    );

    return {
        // Never trust a stale owner identity from the browser.
        // Twitch channel -> configured Minecraft streamer is the source of truth.
        companionUuid: String(exported?.uuid || exported?.companionUuid || req.body.companionUuid || req.body.uuid || "").trim(),
        ownerUuid: configured.ownerUuid,
        ownerName: configured.ownerName,
        minecraftName: configured.ownerName,
        channelId: configured.channelId,
        serverId: configured.serverId
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
            uuid: String(config.uuid || ""),
            channels: config.channels || {},
            owners: config.owners || {},
            ownerProfiles: config.ownerProfiles || {}
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

    // IMPORTANT:
    // /companions is the streamer's SEARCHABLE companion catalogue.
    // Do not reduce this list to the viewer's currently linked companion.
    //
    // The extension needs the full owner-scoped list so "Find your Meowty"
    // can switch from one companion to another. Exact linked-companion
    // resolution and stale-link cleanup belong in /viewer-init and wallet
    // endpoints, not in this catalogue route.
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

    // STRICT multi-streamer isolation:
    // when a channel is supplied, never fall back to the same viewer's wallet
    // from another streamer/channel. A viewer can own one separate companion
    // on Hilha, Paage, Rhaw, etc.
    let wallet = scopedViewer ? getWalletResolved(scopedViewer, false) : null;
    if (!wallet && requestedViewer && !channelId) {
        wallet = getWalletResolved(requestedViewer, false);
    }

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
    const serverConfig = streamerChannels?.servers?.[serverId] || {};
    const configuredOwnerNames = new Set(Object.values(serverConfig.owners || {}).map(normalizeOwnerName).filter(Boolean));
    const configuredOwnerUuids = new Set(Object.values(serverConfig.ownerProfiles || {})
        .map(profile => String(profile?.minecraftUuid || profile?.uuid || "").trim().toLowerCase())
        .filter(Boolean));

    if (configuredOwnerNames.size === 0 && configuredOwnerUuids.size === 0) {
        return res.status(409).json({ ok: false, error: `No streamer owners configured for ${serverId}; refusing companion replacement` });
    }

    const incoming = req.body.companions
        .map(c => ({ ...c, serverId }))
        .filter(c => {
            const ownerName = companionOwnerName(c);
            const ownerUuid = String(c.ownerUuid || "").trim().toLowerCase();
            return (ownerUuid && configuredOwnerUuids.has(ownerUuid)) || (ownerName && configuredOwnerNames.has(ownerName));
        });

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
function taskChannelScope(serverInput, channelInput) {
    const serverId = normalizeServerId(serverInput || resolveServerIdFromChannel(channelInput));
    const channelId = resolveChannelIdInput(channelInput, serverId);
    return { serverId, channelId, key: `${serverId}::${channelId || "unknown"}` };
}

function emptyTasksForScope(scope) {
    return { active: false, allComplete: false, tasks: [], serverId: scope.serverId, channelId: scope.channelId };
}

app.get("/tasks", (req, res) => {
    const scope = taskChannelScope(
        req.query.serverId || "",
        req.query.channelId || req.headers["x-channel-id"] || ""
    );
    res.json(tasksDataByChannel[scope.key] || emptyTasksForScope(scope));
});

app.post("/tasks", requireApiKey, (req, res) => {
    if (!req.body || typeof req.body.active !== "boolean" || !Array.isArray(req.body.tasks)) {
        return res.status(400).json({ ok: false, error: "Expected body with active boolean and tasks array" });
    }

    const scope = taskChannelScope(req.body.serverId || "", req.body.channelId || req.body.channel || "");
    if (!scope.channelId) {
        return res.status(400).json({ ok: false, error: "Missing or invalid channelId for task upload" });
    }

    const previous = tasksDataByChannel[scope.key] || emptyTasksForScope(scope);

    // Some exporter updates briefly send active=true with an empty tasks array when
    // the objective completes or while progress is being rebuilt. Keep the last
    // known quest in that case so the Quest tab and Join button do not disappear.
    // A real vault exit is still represented by active=false.
    const incomingTasks = Array.isArray(req.body.tasks) ? req.body.tasks : [];
    const effectiveTasks = req.body.active && incomingTasks.length === 0 && previous.active && Array.isArray(previous.tasks) && previous.tasks.length > 0
        ? previous.tasks
        : incomingTasks;

    const previousSignature = Array.isArray(previous.tasks) ? previous.tasks.map(task => task.description || "").join("|") : "";
    const nextSignature = effectiveTasks.map(task => task.description || "").join("|");
    const incomingStartedAt = Number(req.body.startedAt || req.body.voteStartedAt || 0);
    const startedAt = req.body.active
        ? (incomingStartedAt > 0
            ? incomingStartedAt
            : previous.active && previousSignature === nextSignature && Number(previous.startedAt || 0) > 0
                ? Number(previous.startedAt)
                : Date.now())
        : 0;

    const scopedTasks = { ...req.body, tasks: effectiveTasks, serverId: scope.serverId, channelId: scope.channelId, startedAt };
    tasksDataByChannel[scope.key] = scopedTasks;
    tasksData = scopedTasks;

    if (previous.active && !scopedTasks.active) {
        progressionVaultParticipants.delete(`${scope.serverId}::${scope.channelId}`);
    }

    res.json({ ok: true, serverId: scope.serverId, channelId: scope.channelId, active: scopedTasks.active, count: scopedTasks.tasks.length });
});
app.get("/wallet/:viewer", (req, res) => {
    const channelId = req.query.channelId || req.headers["x-channel-id"] || "";
    const scopedViewer = scopeViewerFromRequest(req, req.params.viewer);

    // Never let a wallet from another Twitch channel satisfy a channel-scoped
    // request. This is critical for one-viewer / multiple-streamer companions.
    let wallet = scopedViewer ? getWalletResolved(scopedViewer, false) : null;
    if (!wallet && !channelId) wallet = getWalletResolved(req.params.viewer, false);

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

    const dirtReasonLabels = {
        vault_join: "Joined the quest",
        correct_guess: "Correct quest prediction",
        watchtime: "Watchtime reward",
        captain_award: "Captain awarded you",
        manual: "Captain awarded you"
    };
    const reasonLabel = dirtReasonLabels[reason] || String(reason || "Reward").replace(/_/g, " ");
    addViewerActivity(wallet.viewer, "", `${reasonLabel}: +${added} Dirt.`, requestedChannel, requestedServer);

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
    const result = spendDirt(
        req.body.viewer,
        req.body.amount,
        String(req.body.reason || "spend"),
        req.body.channelId || req.body.channel || "",
        req.body.serverId || ""
    );
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

app.post("/admin/migrate-server-wallets", requireApiKey, async (req, res) => {
    const fromServer = normalizeServerId(req.body?.fromServer || req.body?.sourceServer || "");
    const toServer = normalizeServerId(req.body?.toServer || req.body?.targetServer || "");

    if (!fromServer || !toServer || fromServer === toServer) {
        return res.status(400).json({ ok: false, error: "fromServer and toServer must be different valid server ids" });
    }
    if (!streamerChannels?.servers?.[fromServer]) {
        return res.status(404).json({ ok: false, error: `Unknown source server: ${fromServer}` });
    }
    if (!streamerChannels?.servers?.[toServer]) {
        return res.status(404).json({ ok: false, error: `Unknown target server: ${toServer}` });
    }

    const sourceWallets = Object.values(wallets || {}).filter(wallet => {
        const parsed = parseScopedViewerKey(wallet?.viewer || "");
        return normalizeServerId(parsed.serverId || "") === fromServer;
    });

    let migrated = 0;
    let created = 0;
    let updated = 0;
    for (const source of sourceWallets) {
        const parsed = parseScopedViewerKey(source.viewer || "");
        const channelId = normalizeChannelId(parsed.channelId || "");
        const viewerId = normalizeViewer(parsed.viewerId || "");
        const targetChannels = configuredChannelIds(toServer);
        if (!channelId || !viewerId || !targetChannels.has(channelId)) continue;

        const targetKey = scopedViewerKey(viewerId, channelId, toServer);
        const existing = wallets[targetKey] || null;
        const sourceDirt = Number(source.dirt || 0);

        if (!existing) {
            wallets[targetKey] = {
                viewer: targetKey,
                dirt: sourceDirt,
                twitchId: String(source.twitchId || viewerId),
                displayName: String(source.displayName || viewerId),
                // Companion links are deliberately NOT migrated between Minecraft servers.
                companionName: "",
                manualAlias: !!source.manualAlias,
                updatedAt: new Date().toISOString()
            };
            created++;
        } else {
            existing.dirt = Math.max(Number(existing.dirt || 0), sourceDirt);
            if (!existing.twitchId && source.twitchId) existing.twitchId = String(source.twitchId);
            if (!safeDisplayName(existing.displayName, "") && safeDisplayName(source.displayName, "")) existing.displayName = String(source.displayName);
            existing.updatedAt = new Date().toISOString();
            updated++;
        }
        migrated++;
    }

    saveWallets();
    if (USE_SUPABASE) {
        try { await syncAllWalletsToSupabase(); } catch (error) { console.error("[MIGRATE] Supabase wallet sync failed", error); }
    }

    console.log(`[MIGRATE] Wallets ${fromServer} -> ${toServer}: migrated=${migrated}, created=${created}, updated=${updated}`);
    res.json({ ok: true, fromServer, toServer, migrated, created, updated, sourcePreserved: true, companionLinksMigrated: false });
});

app.get("/reset-state", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        ok: true,
        epoch: Number(backendResetState?.epoch || 0)
    });
});

app.post("/admin/reset-backend", requireApiKey, async (req, res) => {
    const confirm = String(req.body.confirm || "").trim().toLowerCase();
    if (confirm !== "confirm") {
        return res.status(400).json({ ok: false, error: "Confirmation required" });
    }

    const before = {
        wallets: Object.keys(wallets || {}).length,
        training: Object.keys(trainingData || {}).length,
        forgery: Object.keys(forgeryData || {}).length,
        watchers: Object.keys(watchers || {}).length,
        queuedActions: Array.isArray(shopActionQueue) ? shopActionQueue.length : 0,
        companions: Array.isArray(companionsData?.companions) ? companionsData.companions.length : 0,
        profiles: progressionProfiles.size,
        bountyStates: progressionBounties.size,
        achievements: progressionAchievements.size,
        titles: progressionTitles.size
    };

    // Cancel pending delayed writes first so old state cannot be written back after the wipe.
    if (walletSyncTimer) { clearTimeout(walletSyncTimer); walletSyncTimer = null; }
    if (trainingSyncTimer) { clearTimeout(trainingSyncTimer); trainingSyncTimer = null; }
    if (forgerySyncTimer) { clearTimeout(forgerySyncTimer); forgerySyncTimer = null; }

    if (USE_SUPABASE) {
        try {
            // PostgREST requires a filter for DELETE. These filters match all non-null keys.
            await supabaseRequest('/wallets?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/training_center?key=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/forgery?key=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/notifications?id=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {});
            await supabaseRequest('/bounty_history?id=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/bounty_state?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/achievements?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/titles?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/profile_statistics?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
            await supabaseRequest('/profiles?viewer=not.is.null', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });

            // Legacy viewer_links is no longer used, but wipe it too if the table
            // still exists so a nuclear reset truly removes all old Twitch links.
            try {
                await supabaseRequest('/viewer_links?viewer=not.is.null', {
                    method: 'DELETE',
                    headers: { Prefer: 'return=minimal' }
                });
            } catch (viewerLinksError) {
                // Deployments without the legacy table are fine.
                if (!String(viewerLinksError?.message || viewerLinksError).includes('404')) {
                    console.warn('[ADMIN] Could not clear legacy viewer_links table:', String(viewerLinksError?.message || viewerLinksError));
                }
            }
        } catch (error) {
            console.error('[ADMIN] Full backend reset failed while clearing Supabase.', error);
            return res.status(500).json({ ok: false, error: 'Failed clearing Supabase; local state was not reset.', detail: String(error.message || error) });
        }
    }

    // Clear every runtime/cache data store, but keep configuration such as streamer_channels.json.
    wallets = {};
    trainingData = {};
    forgeryData = {};
    watchers = {};
    shopActionQueue = [];
    companionsData = { companions: [] };
    tasksData = { active: false, tasks: [] };
    tasksDataByChannel = {};
    encountersData = {};
    progressionProfiles.clear();
    progressionStats.clear();
    progressionBounties.clear();
    progressionAchievements.clear();
    progressionTitles.clear();
    progressionNotifications.clear();
    notificationDedupe.clear();

    writeJsonFile(WALLETS_FILE, wallets);
    writeJsonFile(TRAINING_FILE, trainingData);
    writeJsonFile(FORGERY_FILE, forgeryData);
    writeJsonFile(WATCHERS_FILE, watchers);
    writeJsonFile(QUEUE_FILE, shopActionQueue);
    writeJsonFile(ENCOUNTERS_FILE, encountersData);

    // Persist a reset generation. Extension clients compare this value with the
    // last generation they have seen; a change forces local companion/Twitch
    // identity caches to be cleared exactly once.
    backendResetState = { epoch: Date.now() };
    writeJsonFile(RESET_STATE_FILE, backendResetState);

    console.log(`[ADMIN] FULL BACKEND RESET completed. Previous state: ${JSON.stringify(before)} resetEpoch=${backendResetState.epoch}`);
    res.json({
        ok: true,
        reset: 'everything',
        before,
        resetEpoch: backendResetState.epoch,
        configurationPreserved: true
    });
});

app.post("/admin/reset-player", requireApiKey, async (req, res) => {
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
    const removedTrainingKeys = [];
    for (const key of Object.keys(trainingData || {})) {
        const state = trainingData[key] || {};
        if (
            normalizeViewer(state.viewer || "") === normalizeViewer(walletKey || requestedViewer) ||
            String(state.companionName || "").trim().toLowerCase() === wantedMinecraft
        ) {
            delete trainingData[key];
            removedTrainingKeys.push(key);
            removedTraining++;
        }
    }

    let removedForgery = 0;
    const removedForgeryKeys = [];
    for (const key of Object.keys(forgeryData || {})) {
        const state = forgeryData[key] || {};
        if (
            normalizeViewer(state.viewer || "") === normalizeViewer(walletKey || requestedViewer) ||
            String(state.companionName || "").trim().toLowerCase() === wantedMinecraft
        ) {
            delete forgeryData[key];
            removedForgeryKeys.push(key);
            removedForgery++;
        }
    }

    saveWallets();
    saveTraining();
    saveForgery();

    const resetScope = progressionScope(req, requestedViewer);
    if (resetScope.viewer && resetScope.channelId) {
        if (USE_SUPABASE) {
            const base = `server_id=eq.${encodeURIComponent(resetScope.serverId)}&channel_id=eq.${encodeURIComponent(resetScope.channelId)}`;
            await supabaseRequest(`/wallets?${base}&viewer=eq.${encodeURIComponent(resetScope.viewer)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
            for (const key of removedTrainingKeys) await supabaseRequest(`/training_center?${base}&key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
            for (const key of removedForgeryKeys) await supabaseRequest(`/forgery?${base}&key=eq.${encodeURIComponent(key)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        }
        await deleteProgressionForScope(resetScope);
    }

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

        const watchScope = progressionScope(req, req.body.viewer);
        recordProgressionMetric(watchScope, "watch_minutes", 5, { displayName: watcher.displayName });
        recordProgressionMetric(watchScope, "watch_dirt", 1, { displayName: watcher.displayName });
        recordProgressionMetric(watchScope, "dirt_earned", 1, { displayName: watcher.displayName });

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




const SHIP_VIEWER_REWARD = {
    dirt: 250,
    relicFragmentChance: 0.35,
    ancientFragmentChance: 0.08
};

function rewardStreamerViewersForShipEncounter(encounter) {
    if (!encounter || !encounter.id) return { ok: false, error: "Missing encounter" };

    // Idempotency: completion/update retries must never award twice.
    if (encounter.viewerRewardsApplied) {
        return encounter.viewerRewardSummary || { ok: true, alreadyApplied: true };
    }

    const serverId = normalizeServerId(encounter.serverId || firstEnabledServerId());
    const channelId = resolveChannelIdInput(encounter.channelId || "", serverId);
    if (!channelId) {
        return { ok: false, error: "No configured channel for encounter" };
    }

    const resolved = walletKeysForChannel(channelId, serverId);
    const summary = {
        ok: true,
        dirtPerViewer: SHIP_VIEWER_REWARD.dirt,
        walletsRewarded: 0,
        relicFragmentsAwarded: 0,
        ancientFragmentsAwarded: 0,
        relicFragmentChance: SHIP_VIEWER_REWARD.relicFragmentChance,
        ancientFragmentChance: SHIP_VIEWER_REWARD.ancientFragmentChance
    };

    for (const key of resolved.keys) {
        const wallet = getWallet(key);
        if (!wallet) continue;

        wallet.dirt = Number(wallet.dirt || 0) + SHIP_VIEWER_REWARD.dirt;
        wallet.updatedAt = new Date().toISOString();
        summary.walletsRewarded++;

        // Fragments belong to the viewer's channel-specific companion/Academy.
        // A viewer without a linked companion still receives Dirt, but has no
        // Training Center state to receive fragments yet.
        const linked = parseCompanionLink(wallet.companionName || "");
        const companionName = String(linked.companionName || "").trim();
        if (!companionName) continue;

        const training = getTrainingState(wallet.viewer, companionName);

        if (Math.random() < SHIP_VIEWER_REWARD.relicFragmentChance) {
            training.relicFragments = Math.max(0, Number(training.relicFragments || 0) + 1);
            summary.relicFragmentsAwarded++;
            addTrainingHistory(training, `${encounter.type === "mutiny" ? "Mutiny" : "Treasure Fleet"} reward: +1 Relic Fragment.`);
        }

        if (Math.random() < SHIP_VIEWER_REWARD.ancientFragmentChance) {
            training.ancientRelicFragments = Math.max(0, Number(training.ancientRelicFragments || 0) + 1);
            summary.ancientFragmentsAwarded++;
            addTrainingHistory(training, `${encounter.type === "mutiny" ? "Mutiny" : "Treasure Fleet"} reward: +1 Ancient Relic Fragment.`);
        }
    }

    saveWallets();
    saveTraining();

    encounter.viewerRewardsApplied = true;
    encounter.viewerRewardsAppliedAt = new Date().toISOString();
    encounter.viewerRewardSummary = summary;

    console.log(
        `[ENCOUNTER] ${encounter.type} ${encounter.id}: rewarded ${summary.walletsRewarded} wallet(s) ` +
        `+${SHIP_VIEWER_REWARD.dirt} Dirt each; relic fragments=${summary.relicFragmentsAwarded}; ` +
        `ancient fragments=${summary.ancientFragmentsAwarded}.`
    );

    return summary;
}

function publicEncounter(e) {
    if (!e) return null;
    return {
        id: String(e.id || ""),
        type: String(e.type || ""),
        state: String(e.state || "pending"),
        serverId: String(e.serverId || ""),
        channelId: String(e.channelId || ""),
        viewer: String(e.viewer || ""),
        viewerDisplayName: String(e.viewerDisplayName || ""),
        companionName: String(e.companionName || ""),
        x: Number(e.x || 0), y: Number(e.y || 0), z: Number(e.z || 0),
        viewerRewardsApplied: !!e.viewerRewardsApplied,
        viewerRewardSummary: e.viewerRewardSummary || null,
        createdAt: e.createdAt || "", updatedAt: e.updatedAt || ""
    };
}

app.get("/encounters", (req, res) => {
    const serverId = normalizeServerId(req.query.serverId || firstEnabledServerId());
    const channelId = resolveChannelIdInput(req.query.channelId || "", serverId);
    const rawViewer = normalizeViewer(req.query.viewer || "");
    const viewerId = rawViewer ? normalizeViewer(parseScopedViewerKey(rawViewer).viewerId || rawViewer) : "";
    const list = Object.values(encountersData || {}).filter(e => {
        if (!e || normalizeServerId(e.serverId || serverId) !== serverId) return false;
        if (channelId && normalizeChannelId(e.channelId || "") !== channelId) return false;
        // Viewer-specific encounters (Rescue Meowty) stay private to that viewer.
        // Global ship events such as Treasure Fleet / Mutiny intentionally have
        // no viewer and must still be visible to everyone watching the channel.
        if (viewerId && String(e.viewer || "").trim()) {
            const ev = normalizeViewer(parseScopedViewerKey(e.viewer || "").viewerId || e.viewer || "");
            if (ev !== viewerId && normalizeViewer(e.viewerDisplayName || "") !== rawViewer) return false;
        }
        const encounterState = String(e.state || "");
        return encounterState !== "completed" && encounterState !== "removed";
    }).map(publicEncounter);
    res.json({ ok: true, encounters: list });
});

app.post("/encounters/update", requireApiKey, (req, res) => {
    const id = String(req.body.id || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"Missing encounter id" });
    const previous = encountersData[id] || {};
    const serverId = normalizeServerId(req.body.serverId || previous.serverId || firstEnabledServerId());
    const channelId = resolveChannelIdInput(req.body.channelId || previous.channelId || "", serverId);
    const state = String(req.body.state || previous.state || "pending");
    const e = {
        ...previous,
        id,
        type: String(req.body.type || previous.type || "rescue_meowty"),
        state,
        serverId,
        channelId,
        viewer: String(req.body.viewer || previous.viewer || ""),
        viewerDisplayName: String(req.body.viewerDisplayName || previous.viewerDisplayName || ""),
        companionName: String(req.body.companionName || previous.companionName || ""),
        streamerUuid: String(req.body.streamerUuid || previous.streamerUuid || ""),
        x: Number(req.body.x ?? previous.x ?? 0), y: Number(req.body.y ?? previous.y ?? 0), z: Number(req.body.z ?? previous.z ?? 0),
        createdAt: previous.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    encountersData[id] = e;

    // Treasure Fleet / Mutiny pay the entire selected stream channel exactly
    // once when the physical combat encounter transitions to completed.
    const previousState = String(previous.state || "");
    if (
        state === "completed" &&
        previousState !== "completed" &&
        (e.type === "treasure_fleet" || e.type === "mutiny")
    ) {
        e.viewerRewardSummary = rewardStreamerViewersForShipEncounter(e);
        encountersData[id] = e;
    }

    // Only after the physical rescue succeeds does the companion become linked
    // to the viewer's wallet/extension. Until then the viewer owns no Codex companion.
    if (state === "completed" && e.type === "rescue_meowty" && e.viewer && e.companionName && channelId) {
        const configured = configuredStreamerOwner(serverId, channelId);
        const scoped = scopedViewerKey(parseScopedViewerKey(e.viewer).viewerId || e.viewer, channelId, serverId);
        const existing = getWalletResolved(scoped, false);
        const displayName = e.viewerDisplayName || existing?.displayName || parseScopedViewerKey(e.viewer).viewerId || e.viewer;
        linkWalletCompanion(scoped, existing?.twitchId || "", displayName, e.companionName, configured.ownerName, channelId, serverId);
    }
    saveEncounters();
    res.json({ ok:true, encounter: publicEncounter(e) });
});


app.post("/encounters/cancel-rescue", (req, res) => {
    const serverId = normalizeServerId(req.body.serverId || firstEnabledServerId());
    const channelId = resolveChannelIdInput(req.body.channelId || "", serverId);
    const rawViewer = normalizeViewer(req.body.viewer || "");
    const viewerId = normalizeViewer(parseScopedViewerKey(rawViewer).viewerId || rawViewer || "");
    const encounterId = String(req.body.encounterId || "").trim();

    if (!channelId || !viewerId) {
        return res.status(400).json({ ok:false, error:"Missing channel/viewer" });
    }

    let encounter = null;

    if (encounterId && encountersData[encounterId]) {
        encounter = encountersData[encounterId];
    } else {
        encounter = Object.values(encountersData || {}).find(e => {
            if (!e || e.type !== "rescue_meowty") return false;
            if (String(e.state || "") !== "pending") return false;
            if (normalizeServerId(e.serverId || serverId) !== serverId) return false;
            if (normalizeChannelId(e.channelId || "") !== channelId) return false;

            const encounterViewerId = normalizeViewer(
                parseScopedViewerKey(e.viewer || "").viewerId || e.viewer || ""
            );
            return encounterViewerId === viewerId;
        }) || null;
    }

    if (!encounter) {
        return res.status(404).json({ ok:false, error:"No pending Rescue Meowty found." });
    }

    if (encounter.type !== "rescue_meowty") {
        return res.status(400).json({ ok:false, error:"Encounter is not Rescue Meowty." });
    }

    // A physically spawned Rescue must be resolved in Minecraft, not cancelled
    // from the viewer extension.
    if (String(encounter.state || "") !== "pending") {
        return res.status(409).json({
            ok:false,
            error:"This Rescue Meowty mission has already spawned and cannot be cancelled here.",
            encounter: publicEncounter(encounter)
        });
    }

    const encounterViewerId = normalizeViewer(
        parseScopedViewerKey(encounter.viewer || "").viewerId || encounter.viewer || ""
    );

    if (
        normalizeServerId(encounter.serverId || serverId) !== serverId ||
        normalizeChannelId(encounter.channelId || "") !== channelId ||
        encounterViewerId !== viewerId
    ) {
        return res.status(403).json({ ok:false, error:"This Rescue belongs to another viewer/stream." });
    }

    // Remove any unprocessed create_companion request tied to this rescue.
    const beforeQueue = shopActionQueue.length;
    shopActionQueue = shopActionQueue.filter(item =>
        !(
            item &&
            item.action === "create_companion" &&
            String(item.encounterId || "") === String(encounter.id || "")
        )
    );
    if (shopActionQueue.length !== beforeQueue) saveQueue();

    // Refund the create-companion price to the same scoped wallet exactly once.
    const scoped = scopedViewerKey(viewerId, channelId, serverId);
    const wallet = getWalletResolved(scoped, false) || getWallet(scoped);
    const refund = Number(PRICES.CREATE_COMPANION || 0);

    wallet.dirt = Number(wallet.dirt || 0) + refund;
    saveWallets();
    syncWalletToSupabase(wallet).catch(error =>
        console.error("[SUPABASE] Failed syncing Rescue cancellation refund", error)
    );

    encounter.state = "removed";
    encounter.cancelledAt = new Date().toISOString();
    encounter.updatedAt = encounter.cancelledAt;
    encounter.cancelRefund = refund;
    saveEncounters();

    console.log(
        `[ENCOUNTER] Cancelled pending Rescue ${encounter.id} for ${scoped}; refunded ${refund} Dirt.`
    );

    return res.json({
        ok:true,
        refunded:refund,
        dirt:Number(wallet.dirt || 0),
        encounter:publicEncounter(encounter)
    });
});

app.post("/shop/create-companion", (req, res) => {
    const rawChannel = req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || "";
    const requestedServer = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(rawChannel));
    const configured = configuredStreamerOwner(requestedServer, rawChannel);

    if (!configured.channelId) {
        return res.status(400).json({
            ok: false,
            error: "Unknown streamer channel. Check streamer_channels.json."
        });
    }

    if (!configured.ownerName) {
        return res.status(400).json({
            ok: false,
            error: "No Minecraft owner configured for this streamer channel."
        });
    }

    // Scope the viewer to THIS streamer before any wallet/companion checks.
    const viewer = scopedViewerKey(req.body.viewer, configured.channelId, configured.serverId);
    const companionName = String(req.body.companionName || "").trim();

    if (!viewer || !companionName) {
        return res.status(400).json({ ok: false, error: "Missing viewer or companion name" });
    }

    // The selected Twitch channel is the only authority for Minecraft ownership.
    // Never trust minecraftName/ownerName sent by a stale extension client.
    const minecraftOwner = configured.ownerName;

    const currentWallet = getWalletResolved(viewer, false);
    if (currentWallet && parseCompanionLink(currentWallet.companionName || "").companionName) {
        return res.status(400).json({
            ok: false,
            error: "You already have a companion on this stream."
        });
    }

    const requestedViewerId = normalizeViewer(parseScopedViewerKey(viewer).viewerId || viewer);
    const activeRescue = Object.values(encountersData || {}).find(e => {
        const rescueState = String(e && e.state || "");
        if (!e || (rescueState !== "pending" && rescueState !== "spawned")) return false;
        if (normalizeServerId(e.serverId || configured.serverId) !== configured.serverId) return false;
        if (normalizeChannelId(e.channelId || "") !== configured.channelId) return false;
        const encounterViewerId = normalizeViewer(parseScopedViewerKey(e.viewer || "").viewerId || e.viewer || "");
        return encounterViewerId === requestedViewerId;
    });
    if (activeRescue) {
        return res.status(400).json({
            ok: false,
            error: "Rescue Meowty! is already active for this viewer on this stream.",
            encounter: publicEncounter(activeRescue)
        });
    }

    if (companionNameExistsForOwner(configured.serverId, minecraftOwner, companionName)) {
        return res.status(400).json({
            ok: false,
            error: "A companion with that name already exists for this streamer",
            companionName,
            minecraftName: minecraftOwner,
            channelId: configured.channelId,
            serverId: configured.serverId
        });
    }

    // Spend Dirt only from the wallet on THIS streamer/channel.
    const spend = spendDirt(
        viewer,
        PRICES.CREATE_COMPANION,
        "create_companion",
        configured.channelId,
        configured.serverId
    );
    if (!spend.ok) return res.status(400).json(spend);

    const existingWallet = getWalletResolved(viewer, false) || getWallet(viewer);
    updateWalletIdentity(viewer, req.body.twitchId || "", req.body.displayName || req.body.viewer || viewer);

    const encounterId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    encountersData[encounterId] = {
        id: encounterId, type: "rescue_meowty", state: "pending",
        serverId: configured.serverId, channelId: configured.channelId, viewer,
        viewerDisplayName: String(req.body.displayName || req.body.viewer || ""),
        companionName, streamerUuid: configured.ownerUuid || "",
        x:0,y:0,z:0, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    };
    saveEncounters();

    const request = queueShopAction({
        action: "create_companion",
        viewer,
        companionName,
        minecraftName: minecraftOwner,
        ownerName: minecraftOwner,
        ownerUuid: configured.ownerUuid,
        channelId: configured.channelId,
        serverId: configured.serverId,
        cost: PRICES.CREATE_COMPANION,
        encounterId,
        displayName: String(req.body.displayName || req.body.viewer || "")
    });

    res.json({
        ok: true,
        request,
        encounter: publicEncounter(encountersData[encounterId]),
        wallet: {
            ok: true,
            ...publicWallet(getWalletResolved(viewer, false) || getWallet(viewer)),
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

function viewerBoughtDailyRelicForOffer(viewer, offerKey) {
    const wanted = parseScopedViewerKey(viewer);
    const wantedServer = normalizeServerId(wanted.serverId || firstEnabledServerId());
    const wantedChannel = normalizeChannelId(wanted.channelId || "");
    const wantedViewer = normalizeViewer(wanted.viewerId || viewer);

    return Object.values(trainingData || {}).some(state => {
        if (!state || String(state.dailyFeaturedRelicPurchaseKey || "") !== String(offerKey || "")) return false;
        const stateScoped = parseScopedViewerKey(state.viewer || "");
        const stateServer = normalizeServerId(state.serverId || stateScoped.serverId || wantedServer);
        const stateChannel = normalizeChannelId(state.channelId || stateScoped.channelId || "");
        const stateViewer = normalizeViewer(stateScoped.viewerId || state.viewer || "");
        return stateServer === wantedServer &&
            stateChannel === wantedChannel &&
            stateViewer === wantedViewer;
    });
}

app.get("/shop/daily-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.query.viewer || "");
    const scoped = parseScopedViewerKey(viewer);
    const offer = currentDailyRelicOffer(Date.now(), scoped.serverId, scoped.channelId);
    const companionName = String(req.query.companionName || "").trim();
    let purchased = false;
    if (viewer) {
        purchased = viewerBoughtDailyRelicForOffer(viewer, offer.key);
    }
    res.json({ ok: true, offer: { ...offer, purchased } });
});

app.post("/shop/trade-fragments", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const direction = String(req.body.direction || "").trim().toLowerCase();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const state = getTrainingState(viewer, companionName);
    if (!state) return res.status(400).json({ ok: false, error: "Training state unavailable" });
    state.relicFragments = Number(state.relicFragments || 0);
    state.ancientRelicFragments = Number(state.ancientRelicFragments || 0);

    if (direction === "relic_to_ancient") {
        if (state.relicFragments < 5) return res.status(400).json({ ok: false, error: "You need 5 Relic Fragments." });
        state.relicFragments -= 5;
        state.ancientRelicFragments += 1;
        addTrainingHistory(state, "Shop trade: 5 Relic Fragments → 1 Ancient Relic Fragment.");
    } else if (direction === "ancient_to_relic") {
        if (state.ancientRelicFragments < 1) return res.status(400).json({ ok: false, error: "You need 1 Ancient Relic Fragment." });
        state.ancientRelicFragments -= 1;
        state.relicFragments += 5;
        addTrainingHistory(state, "Shop trade: 1 Ancient Relic Fragment → 5 Relic Fragments.");
    } else {
        return res.status(400).json({ ok: false, error: "Invalid fragment trade." });
    }

    state.updatedAt = new Date().toISOString();
    saveTraining();
    res.json({ ok: true, training: publicTrainingState(state) });
});

app.post("/shop/buy-daily-relic", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const slot = Number(req.body.slot);
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return res.status(400).json({ ok: false, error: "Choose a valid normal relic slot." });

    const scoped = parseScopedViewerKey(viewer);
    const offer = currentDailyRelicOffer(Date.now(), scoped.serverId, scoped.channelId);

    const selectedCompanion = exportedCompanionForStreamer(
        scoped.serverId,
        scoped.channelId,
        companionName,
        req.body.companionUuid || req.body.uuid || ""
    );
    if (!selectedCompanion) {
        return res.status(400).json({
            ok: false,
            error: "That companion does not belong to the selected streamer's crew."
        });
    }

    const state = getTrainingState(viewer, companionName);
    if (viewerBoughtDailyRelicForOffer(viewer, offer.key)) {
        return res.status(400).json({ ok: false, error: "You already bought today's featured relic on this stream." });
    }

    const spend = spendDirt(viewer, offer.price, "buy_daily_relic");
    if (!spend.ok) return res.status(400).json(spend);

    state.dailyFeaturedRelicPurchaseKey = offer.key;
    state.updatedAt = new Date().toISOString();
    addTrainingHistory(state, `Bought Daily Relic (${offer.modifiers.length} modifiers) for ${offer.price} Dirt.`);
    saveTraining();

    const request = queueShopAction({
        action: "buy_daily_relic",
        viewer,
        companionName,
        ...shopCompanionFields(req),
        slot,
        modifiers: offer.modifiers,
        dailyRelicKey: offer.key,
        cost: offer.price
    });
    res.json({ ok: true, request, wallet: spend, training: publicTrainingState(state), offer });
});

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

function academyUpgradeCostForLevel(levelInput) {
    const level = Math.max(1, Math.min(9, Math.floor(Number(levelInput || 1))));
    return Math.floor(500 * level * 1.35);
}

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
        const existing = findExistingCompanionState(trainingData, viewer, companionName, key);
        if (existing) {
            moveCompanionStateToCanonicalKey(trainingData, existing, key);
            trainingData[key].viewer = normalizeViewer(viewer);
            trainingData[key].companionName = String(companionName || "").trim();
            saveTraining();
            console.log(`[TRAINING] Re-linked existing state ${existing.key} -> ${key}`);
        }
    }

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
        academyUpgradeCost: Number(state.academyLevel || 1) >= 10
            ? 0
            : academyUpgradeCostForLevel(state.academyLevel),
        prices: {
            study: PRICES.TRAINING_STUDY,
            expedition: PRICES.TRAINING_EXPEDITION,
            minigame: PRICES.TRAINING_MINIGAME,
            sparring: PRICES.TRAINING_SPARRING,
            academyUpgrade: Number(state.academyLevel || 1) >= 10
                ? 0
                : academyUpgradeCostForLevel(state.academyLevel)
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

function addViewerActivity(viewerInput, companionNameInput, text, channelInput = "", serverInput = "", details = {}) {
    const textClean = String(text || "").trim();
    if (!textClean) return false;
    const resolved = channelInput
        ? resolveWalletKeyForChannel(viewerInput, channelInput, serverInput)
        : { key: resolveWalletKey(viewerInput), channelId: "", serverId: normalizeServerId(serverInput || firstEnabledServerId()) };
    const wallet = resolved.key ? getWallet(resolved.key) : getWalletResolved(viewerInput, false);
    if (!wallet) return false;
    const linked = parseCompanionLink(wallet.companionName || "");
    const companionName = String(companionNameInput || linked.companionName || "").trim();
    if (!companionName) return false;
    const state = getTrainingState(wallet.viewer, companionName);
    if (!state) return false;
    addTrainingHistory(state, textClean, details);
    saveTraining();
    return true;
}

function addTrainingHistory(state, text, details = {}) {
    state.history = Array.isArray(state.history) ? state.history : [];
    state.history.push({
        at: new Date().toISOString(),
        text,
        ...(details && typeof details === "object" ? details : {})
    });
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
        const expeditionScope = parseScopedViewerKey(valid.viewer);
        recordProgressionMetric({ serverId: expeditionScope.serverId, channelId: expeditionScope.channelId, viewer: expeditionScope.viewerId }, "relic_fragments_earned", 1, { companionName: valid.companionName });
        if (ancientFound) recordProgressionMetric({ serverId: expeditionScope.serverId, channelId: expeditionScope.channelId, viewer: expeditionScope.viewerId }, "ancient_fragments_earned", 1, { companionName: valid.companionName });
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
    const sparScope = parseScopedViewerKey(valid.viewer);
    const request = queueShopAction({
        action: "training_xp",
        viewer: valid.viewer,
        companionName: valid.companionName,
        xpPercent,
        trainingType: "sparring",
        serverId: sparScope.serverId,
        channelId: sparScope.channelId,
        cost: PRICES.TRAINING_SPARRING
    });

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
    queueShopAction({
        action: "chat_message",
        message: chatMessage,
        source: "sparring",
        viewer: valid.viewer,
        companionName: valid.companionName,
        serverId: sparScope.serverId,
        channelId: sparScope.channelId,
        cost: 0
    });

    const studyText = studyBonus && studyBonus.added > 0 ? ` ${studyBonus.focus.replace(/_/g, " ")} +${studyBonus.added}%.` : "";
    addTrainingHistory(state, `Sparring vs ${opponent}: ${won ? "won" : "lost"}. Rating ${challengerRating.roll} vs ${opponentRating.roll}. ${Math.round(xpPercent * 100)}% TNL XP queued. ${bonusLabel} sparring rating +${sparBonus}.${studyText}`);

    saveTraining();
    recordProgressionMetric({ serverId: sparScope.serverId, channelId: sparScope.channelId, viewer: parseScopedViewerKey(valid.viewer).viewerId }, "academy_spars", 1, { companionName: valid.companionName });
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

    const cost = academyUpgradeCostForLevel(level);
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

function completeAllResearchForViewer(req, res) {
    const requestedViewer = String(req.body.viewer || req.body.identifier || "").trim();
    const channelInput = adminChannelInputFromRequest(req);
    const resolved = resolveAdminViewerIdentifier(requestedViewer, channelInput, req.body.serverId || "");
    if (!resolved.ok || !resolved.viewer) {
        return res.status(400).json({ ok: false, error: resolved.error || "Missing viewer.", requestedViewer, channel: channelInput });
    }

    const wantedViewer = normalizeViewer(resolved.viewer);
    const wantedChannel = normalizeChannelId(resolved.channelId || parseScopedViewerKey(resolved.viewer).channelId || "");
    let statesMatched = 0;
    let jobsCompleted = 0;
    const companions = [];

    for (const state of Object.values(trainingData || {})) {
        if (!state) continue;
        const stateViewer = normalizeViewer(state.viewer || "");
        const parsed = parseScopedViewerKey(state.viewer || "");
        const stateChannel = normalizeChannelId(state.channelId || parsed.channelId || "");
        if (stateViewer !== wantedViewer) continue;
        if (wantedChannel && stateChannel && stateChannel !== wantedChannel) continue;

        statesMatched++;
        const active = Array.isArray(state.activeResearch) ? state.activeResearch : [];
        state.modifierKnowledge = state.modifierKnowledge || {};
        state.modifierKnowledge.companion_challenge = true;
        for (const job of active) {
            if (!job || !job.modifier) continue;
            state.modifierKnowledge[job.modifier] = true;
            jobsCompleted++;
        }
        state.activeResearch = [];
        addTrainingHistory(state, "Admin: completed all active research for viewer.");
        if (state.companionName) companions.push(state.companionName);
    }

    saveTraining();
    res.json({
        ok: true,
        requestedViewer,
        resolvedViewer: resolved.viewer,
        channelId: wantedChannel,
        serverId: resolved.serverId || firstEnabledServerId(),
        statesMatched,
        jobsCompleted,
        companions
    });
}

app.post("/admin/research/complete-all", requireApiKey, completeAllResearchForViewer);

app.post("/admin/research/complete", requireApiKey, (req, res) => {
    if ((req.body.modifier === "all" || req.body.modifiers === "all") && !String(req.body.companionName || req.body.companion || "").trim()) {
        return completeAllResearchForViewer(req, res);
    }
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
    const rawChannel = String(req.body.channelId || req.query.channelId || req.headers["x-channel-id"] || "").trim();
    const requestedServer = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(rawChannel));
    const configured = configuredStreamerOwner(requestedServer, rawChannel);

    if (!configured.channelId) {
        return res.status(400).json({ ok: false, error: "Unknown streamer channel" });
    }

    const viewer = scopedViewerKey(req.body.viewer, configured.channelId, configured.serverId);
    const twitchId = String(req.body.twitchId || "").trim();
    const displayName = String(req.body.displayName || req.body.viewer || viewer).trim();
    const companionName = String(req.body.companionName || "").trim();

    if (!viewer) {
        return res.status(400).json({ ok: false, error: "Missing viewer" });
    }

    // A viewer's linked companion is channel-specific. Its Minecraft owner is
    // always the streamer configured for that channel.
    const minecraftOwner = configured.ownerName;

    if (companionName && !minecraftOwner) {
        return res.status(400).json({
            ok: false,
            error: "No Minecraft owner configured for this streamer channel."
        });
    }

    const wallet = linkWalletCompanion(
        viewer,
        twitchId,
        displayName,
        companionName,
        minecraftOwner,
        configured.channelId,
        configured.serverId
    );

    res.json({
        ok: true,
        serverId: configured.serverId,
        channelId: configured.channelId,
        ownerName: minecraftOwner,
        ownerUuid: configured.ownerUuid,
        wallet: publicWallet(wallet)
    });
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

    const channelInput = String(req.body.channelId || req.body.channel || "").trim();
    const serverId = normalizeServerId(req.body.serverId || resolveServerIdFromChannel(channelInput));
    let wallet = null;

    if (channelInput) {
        const resolved = resolveWalletKeyForChannel(identifier, channelInput, serverId);
        wallet = resolved && resolved.key ? getWallet(resolved.key) : null;
    } else {
        wallet = getWalletResolved(identifier, false);
    }

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
const progressionVaultParticipants = new Map();

app.post("/activity/add", requireApiKey, (req, res) => {
    const viewer = String(req.body.viewer || "").trim();
    const companionName = String(req.body.companionName || "").trim();
    const text = String(req.body.text || "").trim();
    const channel = String(req.body.channelId || req.body.channel || "").trim();
    const serverId = String(req.body.serverId || "").trim();
    if (!viewer || !text) return res.status(400).json({ ok: false, error: "Missing viewer or text" });
    const added = addViewerActivity(viewer, companionName, text, channel, serverId);
    if (!added) return res.status(404).json({ ok: false, error: "Linked companion/training state not found" });
    res.json({ ok: true });
});

const TASK_VOTE_WINDOW_MS = 5 * 60 * 1000;

function activeTasksForRequest(req) {
    const scope = taskChannelScope(
        req.body?.serverId || req.query?.serverId || "",
        req.body?.channelId || req.body?.channel || req.query?.channelId || req.query?.channel || req.headers["x-channel-id"] || ""
    );
    return { scope, state: tasksDataByChannel[scope.key] || emptyTasksForScope(scope) };
}

app.post("/tasks/join", (req, res) => {
    const viewer = scopeViewerFromRequest(req, req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const displayName = String(req.body.displayName || "").trim();
    const twitchId = String(req.body.twitchId || "").trim();
    const voteKey = String(req.body.voteKey || "current");
    const { state: activeTaskState } = activeTasksForRequest(req);

    if (!activeTaskState.active || !Array.isArray(activeTaskState.tasks) || activeTaskState.tasks.length === 0) {
        return res.status(409).json({ ok: false, error: "There is no active vault quest to join." });
    }

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

    recordProgressionMetric(progressionScope(req, req.body.viewer), "vaults_joined", 1, { displayName, companionName });
    const participantScope = progressionScope(req, req.body.viewer);
    const participantKey = `${participantScope.serverId}::${participantScope.channelId}`;
    if (!progressionVaultParticipants.has(participantKey)) progressionVaultParticipants.set(participantKey, new Map());
    progressionVaultParticipants.get(participantKey).set(participantScope.viewer, { ...participantScope, displayName, companionName });

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
    const { state: activeTaskState } = activeTasksForRequest(req);

    if (!activeTaskState.active || !Array.isArray(activeTaskState.tasks) || activeTaskState.tasks.length === 0) {
        return res.status(409).json({ ok: false, error: "There is no active vault quest to vote on." });
    }

    const voteStartedAt = Number(activeTaskState.startedAt || activeTaskState.voteStartedAt || 0);
    if (voteStartedAt > 0 && Date.now() - voteStartedAt >= TASK_VOTE_WINDOW_MS) {
        return res.status(409).json({ ok: false, error: "Voting is closed for this quest." });
    }

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
    const voteScope = progressionScope(req, req.body.viewer);
    recordProgressionMetric(voteScope, "votes_total", 1, { displayName, companionName });
    recordProgressionMetric(voteScope, vote === "support" ? "back_votes" : "challenge_votes", 1, { displayName, companionName });

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

app.post("/tasks/reward-result", requireApiKey, (req, res) => {
    const viewer = String(req.body.viewer || "").trim();
    const companionName = String(req.body.companionName || "").trim();
    const channelId = String(req.body.channelId || req.body.channel || "").trim();
    const serverId = String(req.body.serverId || "").trim();
    const text = String(req.body.text || "").trim();
    const xp = Math.max(0, Math.floor(Number(req.body.xp || req.body.companionXp || 0)));
    const dirt = Math.max(0, Math.floor(Number(req.body.dirt || 0)));
    const outcome = String(req.body.outcome || "").trim().toLowerCase();

    if (!viewer || !text) {
        return res.status(400).json({ ok: false, error: "Missing viewer or reward-result text." });
    }

    const recorded = addViewerActivity(
        viewer,
        companionName,
        text,
        channelId,
        serverId,
        { type: "quest_reward", outcome, xp, dirt }
    );

    if (!recorded) {
        return res.status(404).json({ ok: false, error: "Viewer wallet or companion link was not found." });
    }

    const resultScope = progressionScope(req, viewer);
    if (outcome === "joined_success") recordProgressionMetric(resultScope, "vaults_completed", 1, { companionName });
    if (outcome === "joined_failed") recordProgressionMetric(resultScope, "vaults_failed", 1, { companionName });
    if (outcome === "correct" || outcome === "success" || outcome === "won") recordProgressionMetric(resultScope, "predictions_correct", 1, { companionName });
    if (outcome === "incorrect" || outcome === "wrong" || outcome === "failed" || outcome === "lost") recordProgressionMetric(resultScope, "predictions_incorrect", 1, { companionName });
    if (xp > 0) recordProgressionMetric(resultScope, "companion_xp", xp, { companionName });
    if (dirt > 0) recordProgressionMetric(resultScope, "dirt_earned", dirt, { companionName });

    res.json({ ok: true, viewer, companionName, outcome, xp, dirt });
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

// ============================================================
// CREW PROGRESSION — profiles, bounties, achievements and titles
// ============================================================

const progressionProfiles = new Map();
const progressionStats = new Map();
const progressionBounties = new Map();
const progressionAchievements = new Map();
const progressionTitles = new Map();
const progressionNotifications = new Map();
const notificationDedupe = new Map();

function notificationList(scope) {
    const key = progressionKey(scope.serverId, scope.channelId, scope.viewer);
    if (!progressionNotifications.has(key)) progressionNotifications.set(key, []);
    return progressionNotifications.get(key);
}
function notificationId() {
    return `notice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
function emitProgressionNotification(scope, input = {}) {
    if (!scope?.viewer || !scope?.channelId) return null;
    const now = Date.now();
    const dedupeKey = String(input.dedupeKey || "");
    const scopeKey = progressionKey(scope.serverId, scope.channelId, scope.viewer);
    if (dedupeKey) {
        const fullKey = `${scopeKey}::${dedupeKey}`;
        const previous = Number(notificationDedupe.get(fullKey) || 0);
        if (now - previous < Number(input.dedupeWindowMs || 30000)) return null;
        notificationDedupe.set(fullKey, now);
    }
    const notice = { id:notificationId(), ...scope, kind:String(input.kind||"info"), tier:String(input.tier||"common").toLowerCase(), title:String(input.title||"Crew Update"), message:String(input.message||""), metadata:input.metadata&&typeof input.metadata==="object"?input.metadata:{}, createdAt:new Date(now).toISOString(), readAt:null };
    const list = notificationList(scope); list.unshift(notice); if (list.length > 100) list.length = 100;
    syncNotification(notice).catch(error => console.warn("[NOTIFICATIONS] Could not persist notice:", error?.message || error));
    return notice;
}

const DAILY_BOUNTY_POOL = [
    { id:"treasure_seeker", name:"Treasure Seeker", objectives:[o("chests_opened",50,"Open 50 Vault Chests"),o("ores_mined",5,"Mine 5 Vault Ores"),o("vaults_joined",1,"Join 1 Vault")], reward:{dirt:75,relicFragments:1} },
    { id:"monster_hunter", name:"Monster Hunter", objectives:[o("mobs_killed",75,"Kill 75 Vault Mobs"),o("chests_opened",25,"Open 25 Vault Chests"),o("vaults_joined",1,"Join 1 Vault")], reward:{dirt:80,relicFragments:1} },
    { id:"loyal_deckhand", name:"Loyal Deckhand", objectives:[o("watch_minutes",60,"Watch for 60 Minutes"),o("vaults_joined",1,"Join 1 Vault"),o("votes_total",1,"Vote Once")], reward:{dirt:70} },
    { id:"vault_prophet", name:"Vault Prophet", objectives:[o("votes_total",1,"Vote Once"),o("predictions_correct",1,"Predict Correctly Once"),o("vaults_joined",1,"Join 1 Vault")], reward:{dirt:80} },
    { id:"safe_passage", name:"Safe Passage", objectives:[o("vaults_joined",2,"Join 2 Vaults"),o("vaults_completed",1,"Complete 1 Vault"),o("watch_minutes",30,"Watch for 30 Minutes")], reward:{dirt:85} },
    { id:"academy_student", name:"Academy Student", requiresCompanion:true, objectives:[o("academy_spars",1,"Spar Once"),o("companion_xp",10000,"Gain 10,000 Companion XP"),o("watch_minutes",30,"Watch for 30 Minutes")], reward:{dirt:65,relicFragments:1} },
    { id:"growing_meowty", name:"Growing Meowty", requiresCompanion:true, objectives:[o("companion_xp",15000,"Gain 15,000 Companion XP"),o("vaults_joined",1,"Join 1 Vault"),o("vaults_completed",1,"Complete 1 Vault")], reward:{dirt:80} },
    { id:"ornate_obsession", name:"Ornate Obsession", objectives:[o("ornate_chests",20,"Open 20 Ornate Chests"),o("chests_opened",50,"Open 50 Vault Chests"),o("vaults_completed",1,"Complete 1 Vault")], reward:{dirt:85} },
    { id:"gilded_voyage", name:"Gilded Voyage", objectives:[o("gilded_chests",25,"Open 25 Gilded Chests"),o("ores_mined",3,"Mine 3 Vault Ores"),o("vaults_joined",1,"Join 1 Vault")], reward:{dirt:80} },
    { id:"living_harvest", name:"Living Harvest", requiresCompanion:true, objectives:[o("living_chests",20,"Open 20 Living Chests"),o("mobs_killed",40,"Kill 40 Vault Mobs"),o("companion_xp",5000,"Gain 5,000 Companion XP")], reward:{dirt:80} },
    { id:"wooden_work", name:"Wooden Work", objectives:[o("wooden_chests",35,"Open 35 Wooden Chests"),o("chests_opened",60,"Open 60 Vault Chests"),o("votes_total",1,"Vote Once")], reward:{dirt:70} },
    { id:"coin_collector", name:"Coin Collector", objectives:[o("coin_piles",15,"Open 15 Coin Piles"),o("watch_dirt",25,"Earn 25 Watch-time Dirt"),o("vaults_joined",1,"Join 1 Vault")], reward:{dirt:75} },
    { id:"big_spender", name:"Big Spender", objectives:[o("dirt_spent",100,"Spend 100 Dirt"),o("watch_minutes",45,"Watch for 45 Minutes"),o("votes_total",1,"Vote Once")], reward:{dirt:65} },
    { id:"relic_apprentice", name:"Relic Apprentice", requiresCompanion:true, objectives:[o("relic_fragments_earned",1,"Earn 1 Relic Fragment"),o("academy_spars",1,"Spar Once"),o("companion_xp",5000,"Gain 5,000 Companion XP")], reward:{dirt:70} },
    { id:"captains_supporter", name:"Captain's Supporter", objectives:[o("back_votes",1,"Back a Quest"),o("vaults_joined",1,"Join its Vault"),o("watch_minutes",30,"Watch for 30 Minutes")], reward:{dirt:65} },
    { id:"agent_of_chaos", name:"Agent of Chaos", objectives:[o("challenge_votes",1,"Challenge a Quest"),o("vaults_joined",1,"Join its Vault"),o("mobs_killed",30,"Kill 30 Vault Mobs")], reward:{dirt:70} },
    { id:"ore_prospector", name:"Ore Prospector", objectives:[o("ores_mined",8,"Mine 8 Vault Ores"),o("chests_opened",25,"Open 25 Vault Chests"),o("mobs_killed",25,"Kill 25 Vault Mobs")], reward:{dirt:90} },
    { id:"full_hold", name:"Full Hold", objectives:[o("wooden_chests",20,"Open 20 Wooden Chests"),o("gilded_chests",15,"Open 15 Gilded Chests"),o("living_chests",10,"Open 10 Living Chests")], reward:{dirt:85} },
    { id:"dedicated_sailor", name:"Dedicated Sailor", objectives:[o("watch_minutes",90,"Watch for 90 Minutes"),o("watch_dirt",18,"Earn 18 Watch-time Dirt"),o("votes_total",1,"Vote Once")], reward:{dirt:80} },
    { id:"risky_voyage", name:"Risky Voyage", objectives:[o("challenge_votes",1,"Challenge a Quest"),o("predictions_correct",1,"Predict Correctly"),o("vaults_completed",1,"Complete the Vault")], reward:{dirt:100,relicFragments:1} }
];

const WEEKLY_BOUNTY_POOL = [
    { id:"veteran_sailor", name:"Veteran Sailor", objectives:[o("vaults_joined",8,"Join 8 Vaults"),o("vaults_completed",5,"Complete 5 Vaults"),o("active_days",3,"Watch on 3 Different Days")], reward:{dirt:300} },
    { id:"master_looter", name:"Master Looter", objectives:[o("chests_opened",600,"Open 600 Vault Chests"),o("chest_types",4,"Open All 4 Chest Types"),o("vaults_joined",5,"Join 5 Vaults")], reward:{dirt:350,relicFragments:3} },
    { id:"slayer_deep", name:"Slayer of the Deep", objectives:[o("mobs_killed",600,"Kill 600 Vault Mobs"),o("ores_mined",25,"Mine 25 Vault Ores"),o("vaults_completed",4,"Complete 4 Vaults")], reward:{dirt:375,relicFragments:3} },
    { id:"vault_prophet_weekly", name:"Vault Prophet", objectives:[o("predictions_correct",5,"Make 5 Correct Predictions"),o("votes_total",8,"Vote 8 Times"),o("vaults_joined",8,"Join 8 Vaults")], reward:{dirt:350,relicFragments:3} },
    { id:"gem_hoarder", name:"Gem Hoarder", objectives:[o("ores_mined",50,"Mine 50 Vault Ores"),o("chests_opened",300,"Open 300 Vault Chests"),o("vaults_completed",4,"Complete 4 Vaults")], reward:{dirt:400,relicFragments:3} },
    { id:"academy_regular", name:"Academy Regular", requiresCompanion:true, objectives:[o("academy_spars",5,"Spar 5 Times"),o("companion_xp",100000,"Gain 100,000 Companion XP"),o("vaults_joined",5,"Join 5 Vaults")], reward:{dirt:325,relicFragments:4} },
    { id:"bounty_streak", name:"Bounty Streak", objectives:[o("daily_bounties_completed",3,"Complete 3 Daily Bounties"),o("vaults_joined",5,"Join 5 Vaults"),o("active_days",3,"Watch on 3 Different Days")], reward:{dirt:400,ancientFragments:1} },
    { id:"ornate_raider", name:"Ornate Raider", objectives:[o("ornate_chests",150,"Open 150 Ornate Chests"),o("mobs_killed",300,"Kill 300 Vault Mobs"),o("vaults_completed",4,"Complete 4 Vaults")], reward:{dirt:375,relicFragments:3} },
    { id:"gilded_fortune", name:"Gilded Fortune", objectives:[o("gilded_chests",175,"Open 175 Gilded Chests"),o("ores_mined",30,"Mine 30 Vault Ores"),o("vaults_joined",5,"Join 5 Vaults")], reward:{dirt:375,relicFragments:3} },
    { id:"living_expedition", name:"Living Expedition", requiresCompanion:true, objectives:[o("living_chests",125,"Open 125 Living Chests"),o("companion_xp",75000,"Gain 75,000 Companion XP"),o("mobs_killed",250,"Kill 250 Vault Mobs")], reward:{dirt:350,relicFragments:3} },
    { id:"wooden_armada", name:"Wooden Armada", objectives:[o("wooden_chests",250,"Open 250 Wooden Chests"),o("chests_opened",600,"Open 600 Vault Chests"),o("vaults_joined",6,"Join 6 Vaults")], reward:{dirt:325,relicFragments:3} },
    { id:"coin_conqueror", name:"Coin Conqueror", objectives:[o("coin_piles",100,"Open 100 Coin Piles"),o("dirt_spent",500,"Spend 500 Dirt"),o("active_days",3,"Watch on 3 Different Days")], reward:{dirt:350} },
    { id:"trusted_first_mate", name:"Trusted First Mate", objectives:[o("back_votes",8,"Back 8 Quests"),o("predictions_correct",5,"Be Correct 5 Times"),o("vaults_completed",5,"Complete 5 Vaults")], reward:{dirt:375,ancientFragments:1} },
    { id:"master_mutineer", name:"Master Mutineer", objectives:[o("challenge_votes",8,"Challenge 8 Quests"),o("predictions_correct",4,"Be Correct 4 Times"),o("mobs_killed",400,"Kill 400 Vault Mobs")], reward:{dirt:400,ancientFragments:1} },
    { id:"relic_scholar", name:"Relic Scholar", requiresCompanion:true, objectives:[o("relic_fragments_earned",8,"Earn 8 Relic Fragments"),o("academy_spars",4,"Spar 4 Times"),o("companion_xp",75000,"Gain 75,000 Companion XP")], reward:{dirt:350,ancientFragments:1} },
    { id:"dedicated_crew", name:"Dedicated Crew", objectives:[o("active_days",4,"Watch on 4 Different Days"),o("watch_minutes",480,"Watch for 8 Hours"),o("vaults_joined",6,"Join 6 Vaults")], reward:{dirt:325} },
    { id:"successful_voyage", name:"Successful Voyage", objectives:[o("vaults_completed",6,"Complete 6 Vaults"),o("predictions_correct",4,"Make 4 Correct Predictions"),o("ores_mined",25,"Mine 25 Vault Ores")], reward:{dirt:375,relicFragments:3} },
    { id:"balanced_adventurer", name:"Balanced Adventurer", objectives:[o("chest_types_100",4,"Open 100 of Every Chest Type"),o("mobs_killed",400,"Kill 400 Vault Mobs"),o("ores_mined",30,"Mine 30 Vault Ores")], reward:{dirt:425,ancientFragments:1} },
    { id:"companions_journey", name:"Companion's Journey", requiresCompanion:true, objectives:[o("companion_xp",150000,"Gain 150,000 Companion XP"),o("vaults_completed",5,"Complete 5 Vaults"),o("daily_bounties_completed",3,"Complete 3 Daily Bounties")], reward:{dirt:400,ancientFragments:1} },
    { id:"captains_challenge", name:"Captain's Challenge", objectives:[o("vaults_completed",8,"Complete 8 Vaults"),o("predictions_correct",6,"Make 6 Correct Predictions"),o("mobs_killed",750,"Kill 750 Vault Mobs")], reward:{dirt:500,ancientFragments:2} }
];

const ACHIEVEMENT_DEFINITIONS = [
    achievement("set_sail","Set Sail","vaults_joined",[1,10,50,200],"Veteran Sailor"),
    achievement("safe_return","Safe Return","vaults_completed",[1,10,50,150],"Survivor"),
    achievement("treasure_hunter","Treasure Hunter","chests_opened",[100,1000,5000,20000],"Master Looter"),
    achievement("monster_hunter","Monster Hunter","mobs_killed",[100,1000,5000,20000],"Slayer of the Deep"),
    achievement("gem_collector","Gem Collector","ores_mined",[25,250,1000,5000],"Gem Hoarder"),
    achievement("wooden_worker","Wooden Worker","wooden_chests",[100,1000,5000,15000],"Master Carpenter"),
    achievement("gilded_fortune","Gilded Fortune","gilded_chests",[100,1000,5000,15000],"Gilded Baron"),
    achievement("living_harvest","Living Harvest","living_chests",[100,1000,5000,15000],"Keeper of Life"),
    achievement("ornate_obsession","Ornate Obsession","ornate_chests",[100,1000,5000,15000],"Ornate Raider"),
    achievement("coin_collector","Coin Collector","coin_piles",[50,500,2500,10000],"Treasure Hoarder"),
    achievement("fortune_teller","Fortune Teller","predictions_correct",[1,10,50,200],"Vault Prophet"),
    achievement("loyal_captain","Loyal to the Captain","back_votes",[10,50,250,1000],"Captain's Supporter"),
    achievement("agent_chaos","Agent of Chaos","challenge_votes",[10,50,250,1000],"Master Mutineer"),
    achievement("bounty_hunter","Bounty Hunter","bounties_completed",[1,10,50,200],"Bounty Hunter"),
    achievement("daily_duty","Daily Duty","daily_bounties_completed",[5,25,100,365],"Never Off Duty"),
    achievement("weekly_contract","Weekly Contract","weekly_bounties_completed",[1,10,25,100],"Contract Master"),
    achievement("growing_meowty","Growing Meowty","companion_xp",[10000,1000000,10000000,50000000],"Seasoned Companion"),
    achievement("dirt_collector","Dirt Collector","dirt_earned",[1000,10000,50000,250000],"Dirt Baron"),
    achievement("big_spender","Big Spender","dirt_spent",[1000,10000,50000,250000],"Merchant's Favourite"),
    achievement("on_deck","On Deck","watch_minutes",[60,1500,6000,30000],"Always on Deck"),
    achievement("returning_crew","Returning Crew","active_days",[3,30,100,365],"Loyal Crew"),
    achievement("academy_student","Academy Student","academy_spars",[1,10,50,250],"Sparring Partner"),
    achievement("fragment_finder","Fragment Finder","relic_fragments_earned",[1,10,50,100],"Fragment Finder"),
    achievement("ancient_power","Ancient Power","ancient_relics",[1,5,20,100],"Ancient One")
];

function o(metric, target, label) { return { metric, target, label }; }
function achievement(id,name,metric,targets,title) { return {id,name,metric,targets,title}; }
function progressionKey(serverId, channelId, viewer) { return `${normalizeServerId(serverId)}::${normalizeChannelId(channelId)}::${normalizeViewer(viewer)}`; }
function progressionScope(req, viewerInput) {
    const scoped = parseScopedViewerKey(scopeViewerFromRequest(req, viewerInput));
    return { serverId:normalizeServerId(req.body?.serverId||req.query?.serverId||scoped.serverId||firstEnabledServerId()), channelId:normalizeChannelId(req.body?.channelId||req.body?.channel||req.query?.channelId||scoped.channelId||""), viewer:normalizeViewer(scoped.viewerId||viewerInput) };
}
function parisDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"}).formatToParts(date);
    return Object.fromEntries(parts.map(p=>[p.type,p.value]));
}
function dailyPeriodKey() { const p=parisDateParts(); return `${p.year}-${p.month}-${p.day}`; }
function weeklyPeriodKey() {
    const p=parisDateParts(); const d=new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`); const day=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-day);
    return `week-${d.toISOString().slice(0,10)}`;
}
function deterministicOffers(pool, seed, hasCompanion) {
    const eligible=pool.filter(b=>hasCompanion||!b.requiresCompanion).map(b=>JSON.parse(JSON.stringify(b)));
    let h=2166136261; for(const c of seed){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}
    for(let i=eligible.length-1;i>0;i--){h^=h<<13;h^=h>>>17;h^=h<<5;const j=Math.abs(h)%(i+1);[eligible[i],eligible[j]]=[eligible[j],eligible[i]]}
    return eligible.slice(0,3);
}
function ensureProgression(scope, displayName="", companionName="") {
    const key=progressionKey(scope.serverId,scope.channelId,scope.viewer); const now=new Date().toISOString();
    if(!progressionProfiles.has(key)) progressionProfiles.set(key,{...scope,displayName,companionName,selectedTitleId:"",achievementPoints:0,profileCreatedAt:now,updatedAt:now});
    const profile=progressionProfiles.get(key); if(displayName)profile.displayName=displayName;if(companionName)profile.companionName=companionName;
    if(!progressionStats.has(key)) progressionStats.set(key,{...scope,statistics:{},companionStatistics:{},updatedAt:now});
    if(!progressionAchievements.has(key)) progressionAchievements.set(key,{});
    if(!progressionTitles.has(key)) progressionTitles.set(key,{});
    return {key,profile,stats:progressionStats.get(key),achievements:progressionAchievements.get(key),titles:progressionTitles.get(key)};
}
function ensureBountyState(scope, type, hasCompanion) {
    const key=`${progressionKey(scope.serverId,scope.channelId,scope.viewer)}::${type}`; const periodKey=type==="daily"?dailyPeriodKey():weeklyPeriodKey(); let state=progressionBounties.get(key);
    if(!state||state.periodKey!==periodKey){
        if(state?.selectedBounty){const p=ensureProgression(scope);if(state.status==="completed"&&!state.rewardClaimed){grantProgressionReward(p.profile,state.selectedBounty.reward||{},`${type}_bounty_auto_claim`);state.rewardClaimed=true;state.claimedAt=new Date().toISOString();}archiveBountyState(state).catch(()=>{});}
        const pool=type==="daily"?DAILY_BOUNTY_POOL:WEEKLY_BOUNTY_POOL;state={...scope,periodType:type,periodKey,choices:deterministicOffers(pool,`${key}:${periodKey}`,hasCompanion),selectedBountyId:"",selectedBounty:null,progress:{},status:"choosing",rewardClaimed:false,updatedAt:new Date().toISOString()};progressionBounties.set(key,state);syncBountyState(state).catch(()=>{});
        emitProgressionNotification(scope,{kind:"reset",tier:type==="weekly"?"rare":"common",title:`New ${type === "daily" ? "Daily" : "Weekly"} Bounties`,message:"Three new contracts are waiting for your choice.",dedupeKey:`${type}_reset:${periodKey}`,dedupeWindowMs:86400000});
    }
    return state;
}
function publicBountyState(state){return {...state,progress:{...(state.progress||{})}};}
function recordProgressionMetric(scope, metric, amount=1, meta={}) {
    amount=Number(amount||0);if(!scope.viewer||!metric||!Number.isFinite(amount)||amount===0)return;
    const wallet=getWalletResolved(scopedViewerKey(scope.viewer,scope.channelId,scope.serverId),false);const linked=parseCompanionLink(wallet?.companionName||"");
    const p=ensureProgression(scope,wallet?.displayName||meta.displayName||scope.viewer,linked.companionName||meta.companionName||"");
    const stats=p.stats.statistics;stats[metric]=Math.max(0,Number(stats[metric]||0)+amount);p.stats.updatedAt=new Date().toISOString();
    const changes={[metric]:amount};
    if(metric==="watch_minutes"){
        const day=dailyPeriodKey();const previousDays=new Set(stats.activeDayKeys||[]);const wasNew=!previousDays.has(day);previousDays.add(day);stats.activeDayKeys=Array.from(previousDays).slice(-400);stats.active_days=stats.activeDayKeys.length;if(wasNew)changes.active_days=1;
    }
    if(["wooden_chests","gilded_chests","living_chests","ornate_chests"].includes(metric)){
        const chestMetrics=["wooden_chests","gilded_chests","living_chests","ornate_chests"];
        stats.chest_types=chestMetrics.filter(name=>Number(stats[name]||0)>0).length;
        stats.chest_types_100=chestMetrics.filter(name=>Number(stats[name]||0)>=100).length;
        changes.chest_types=stats.chest_types;changes.chest_types_100=stats.chest_types_100;
    }
    for(const type of ["daily","weekly"]){const state=ensureBountyState(scope,type,!!p.profile.companionName);if(state.status!=="active"||!state.selectedBounty)continue;for(const objective of state.selectedBounty.objectives||[]){if(!(objective.metric in changes))continue;const before=Number(state.progress[objective.metric]||0);const delta=["chest_types","chest_types_100"].includes(objective.metric)?Number(changes[objective.metric]):Number(changes[objective.metric]||0);const after=["chest_types","chest_types_100"].includes(objective.metric)?Math.min(objective.target,delta):Math.min(objective.target,Math.max(0,before+delta));state.progress[objective.metric]=after;const target=Math.max(1,Number(objective.target||1));const beforeStep=Math.floor((before/target)*4);const afterStep=Math.min(4,Math.floor((after/target)*4));if(afterStep>beforeStep){const finished=after>=target;emitProgressionNotification(scope,{kind:finished?"objective_complete":"bounty_progress",tier:finished?"rare":"common",title:finished?"Objective Complete":`${type === "daily" ? "Daily" : "Weekly"} Bounty Progress`,message:finished?objective.label:`${objective.label}: ${after.toLocaleString()} / ${target.toLocaleString()}`,dedupeKey:`${type}:${state.periodKey}:${state.selectedBountyId}:${objective.metric}:${afterStep}`,dedupeWindowMs:86400000,metadata:{periodType:type,bountyId:state.selectedBountyId,metric:objective.metric,current:after,target}});}}const complete=(state.selectedBounty.objectives||[]).every(x=>Number(state.progress[x.metric]||0)>=Number(x.target||0));if(complete){state.status="completed";state.completedAt=new Date().toISOString();emitProgressionNotification(scope,{kind:"bounty_complete",tier:type==="weekly"?"epic":"rare",title:`${type === "daily" ? "Daily" : "Weekly"} Bounty Complete!`,message:`${state.selectedBounty.name} is ready to claim.`,dedupeKey:`${type}:${state.periodKey}:complete`,dedupeWindowMs:86400000});}state.updatedAt=new Date().toISOString();syncBountyState(state).catch(()=>{});}
    evaluateAchievements(p);syncProgressionProfile(p).catch(()=>{});
}
function evaluateAchievements(p){
    const stats=p.stats.statistics;
    for(const def of ACHIEVEMENT_DEFINITIONS){const value=Number(stats[def.metric]||0);def.targets.forEach((target,index)=>{const tier=["common","rare","epic","omega"][index];const id=`${def.id}:${tier}`;if(value<target||p.achievements[id]?.unlocked)return;p.achievements[id]={achievementId:def.id,name:def.name,tier,progress:value,target,unlocked:true,rewardClaimed:true,unlockedAt:new Date().toISOString()};p.profile.achievementPoints+=([10,25,75,200][index]);grantAchievementReward(p.profile,tier);emitProgressionNotification(p.profile,{kind:"achievement",tier,title:`${tier[0].toUpperCase()+tier.slice(1)} Achievement Unlocked!`,message:def.name,dedupeKey:`achievement:${id}`,dedupeWindowMs:31536000000,metadata:{achievementId:def.id,tier}});if(tier==="omega"&&def.title){p.titles[def.id]={titleId:def.id,titleName:def.title,sourceAchievementId:def.id,unlockedAt:new Date().toISOString()};syncTitle(p.profile,p.titles[def.id]).catch(()=>{});emitProgressionNotification(p.profile,{kind:"title",tier:"omega",title:"New Title Unlocked!",message:def.title,dedupeKey:`title:${def.id}`,dedupeWindowMs:31536000000,metadata:{titleId:def.id}});}syncAchievement(p.profile,p.achievements[id]).catch(()=>{});});}
}
async function loadProgressionFromSupabase(){
    if(!USE_SUPABASE)return;
    try{
        const [profiles,stats,bounties,achievements,titles,notifications]=await Promise.all([
            supabaseRequest("/profiles?select=*",{method:"GET"}),
            supabaseRequest("/profile_statistics?select=*",{method:"GET"}),
            supabaseRequest("/bounty_state?select=*",{method:"GET"}),
            supabaseRequest("/achievements?select=*",{method:"GET"}),
            supabaseRequest("/titles?select=*",{method:"GET"}),
            supabaseRequest("/notifications?select=*&order=created_at.desc&limit=5000",{method:"GET"}).catch(()=>[])
        ]);
        for(const row of profiles||[]){const scope={serverId:row.server_id,channelId:row.channel_id,viewer:row.viewer};progressionProfiles.set(progressionKey(scope.serverId,scope.channelId,scope.viewer),{...scope,displayName:row.display_name||row.viewer,companionName:row.companion_name||"",selectedTitleId:row.selected_title_id||"",achievementPoints:Number(row.achievement_points||0),profileCreatedAt:row.profile_created_at||new Date().toISOString(),updatedAt:row.updated_at});}
        for(const row of stats||[]){const scope={serverId:row.server_id,channelId:row.channel_id,viewer:row.viewer};progressionStats.set(progressionKey(scope.serverId,scope.channelId,scope.viewer),{...scope,statistics:row.statistics||{},companionStatistics:row.companion_statistics||{},updatedAt:row.updated_at});}
        for(const row of bounties||[]){const scope={serverId:row.server_id,channelId:row.channel_id,viewer:row.viewer};progressionBounties.set(`${progressionKey(scope.serverId,scope.channelId,scope.viewer)}::${row.period_type}`,{...scope,periodType:row.period_type,periodKey:row.period_key,choices:row.choices||[],selectedBountyId:row.selected_bounty_id||"",selectedBounty:row.selected_bounty||null,progress:row.progress||{},status:row.status||"choosing",rewardClaimed:!!row.reward_claimed,selectedAt:row.selected_at,completedAt:row.completed_at,claimedAt:row.claimed_at,updatedAt:row.updated_at});}
        for(const row of achievements||[]){const key=progressionKey(row.server_id,row.channel_id,row.viewer);if(!progressionAchievements.has(key))progressionAchievements.set(key,{});progressionAchievements.get(key)[`${row.achievement_id}:${row.tier}`]={achievementId:row.achievement_id,tier:row.tier,progress:Number(row.progress||0),target:Number(row.target||1),unlocked:!!row.unlocked,rewardClaimed:!!row.reward_claimed,unlockedAt:row.unlocked_at};}
        for(const row of titles||[]){const key=progressionKey(row.server_id,row.channel_id,row.viewer);if(!progressionTitles.has(key))progressionTitles.set(key,{});progressionTitles.get(key)[row.title_id]={titleId:row.title_id,titleName:row.title_name,sourceAchievementId:row.source_achievement_id||"",unlockedAt:row.unlocked_at};}
        for(const row of notifications||[]){const scope={serverId:row.server_id,channelId:row.channel_id,viewer:row.viewer};const list=notificationList(scope);if(list.length>=100)continue;list.push({id:row.id,...scope,kind:row.kind||"info",tier:row.tier||"common",title:row.title||"Crew Update",message:row.message||"",metadata:row.metadata||{},createdAt:row.created_at,readAt:row.read_at||null});}
        console.log(`[PROGRESSION] Loaded ${profiles?.length||0} profiles, ${bounties?.length||0} bounty states, ${achievements?.length||0} achievements and ${titles?.length||0} titles.`);
    }catch(error){console.error("[PROGRESSION] Failed loading Supabase progression data.",error);}
}
function grantAchievementReward(profile,tier){const reward={common:{dirt:50},rare:{dirt:100,relicFragments:1},epic:{dirt:250,relicFragments:3},omega:{dirt:500,ancientFragments:1}}[tier];grantProgressionReward(profile,reward,`achievement_${tier}`);}
function grantProgressionReward(profile,reward,reason){const scoped=scopedViewerKey(profile.viewer,profile.channelId,profile.serverId);const wallet=getWalletResolved(scoped,false)||getWallet(scoped);wallet.dirt=Number(wallet.dirt||0)+Number(reward?.dirt||0);wallet.updatedAt=new Date().toISOString();saveWallets();if(reward?.relicFragments||reward?.ancientFragments){const state=getTrainingState(scoped,profile.companionName||"");state.relicFragments=Number(state.relicFragments||0)+Number(reward.relicFragments||0);state.ancientRelicFragments=Number(state.ancientRelicFragments||0)+Number(reward.ancientFragments||0);addTrainingHistory(state,`Progression reward: ${reason}.`);saveTraining();}}
async function syncProgressionProfile(p){if(!USE_SUPABASE)return;const base={server_id:p.profile.serverId,channel_id:p.profile.channelId,viewer:p.profile.viewer};await Promise.all([supabaseRequest("/profiles?on_conflict=server_id,channel_id,viewer",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{...base,twitch_id:p.profile.viewer,display_name:p.profile.displayName||p.profile.viewer,companion_name:p.profile.companionName||"",selected_title_id:p.profile.selectedTitleId||null,achievement_points:p.profile.achievementPoints||0,profile_created_at:p.profile.profileCreatedAt,updated_at:new Date().toISOString()}])}),supabaseRequest("/profile_statistics?on_conflict=server_id,channel_id,viewer",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{...base,statistics:p.stats.statistics||{},companion_statistics:p.stats.companionStatistics||{},current_daily_streak:Number(p.stats.statistics?.current_daily_streak||0),best_daily_streak:Number(p.stats.statistics?.best_daily_streak||0),current_watch_streak:Number(p.stats.statistics?.current_watch_streak||0),best_watch_streak:Number(p.stats.statistics?.best_watch_streak||0),first_activity_at:p.stats.statistics?.first_activity_at||null,last_activity_at:new Date().toISOString(),updated_at:new Date().toISOString()}])})]);}
async function syncBountyState(s){if(!USE_SUPABASE)return;await supabaseRequest("/bounty_state?on_conflict=server_id,channel_id,viewer,period_type",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{server_id:s.serverId,channel_id:s.channelId,viewer:s.viewer,period_type:s.periodType,period_key:s.periodKey,choices:s.choices||[],selected_bounty_id:s.selectedBountyId||null,selected_bounty:s.selectedBounty||null,progress:s.progress||{},status:s.status,reward_claimed:!!s.rewardClaimed,selected_at:s.selectedAt||null,completed_at:s.completedAt||null,claimed_at:s.claimedAt||null,updated_at:new Date().toISOString()}])});}
async function archiveBountyState(s){if(!USE_SUPABASE||!s?.selectedBounty)return;await supabaseRequest("/bounty_history",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify([{server_id:s.serverId,channel_id:s.channelId,viewer:s.viewer,period_type:s.periodType,period_key:s.periodKey,bounty_id:s.selectedBountyId,bounty_data:s.selectedBounty,final_progress:s.progress||{},completed:["completed","claimed"].includes(s.status),reward_claimed:!!s.rewardClaimed,reward_data:s.selectedBounty.reward||{},selected_at:s.selectedAt||null,completed_at:s.completedAt||null,claimed_at:s.claimedAt||null}])});}
async function syncAchievement(profile,a){if(!USE_SUPABASE)return;await supabaseRequest("/achievements?on_conflict=server_id,channel_id,viewer,achievement_id,tier",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{server_id:profile.serverId,channel_id:profile.channelId,viewer:profile.viewer,achievement_id:a.achievementId,tier:a.tier,progress:a.progress,target:a.target,unlocked:a.unlocked,reward_claimed:a.rewardClaimed,reward_data:{},unlocked_at:a.unlockedAt,updated_at:new Date().toISOString()}])});}
async function syncTitle(profile,t){if(!USE_SUPABASE)return;await supabaseRequest("/titles?on_conflict=server_id,channel_id,viewer,title_id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{server_id:profile.serverId,channel_id:profile.channelId,viewer:profile.viewer,title_id:t.titleId,title_name:t.titleName,source_achievement_id:t.sourceAchievementId||null,unlocked_at:t.unlockedAt,updated_at:new Date().toISOString()}])});}
async function syncNotification(n){if(!USE_SUPABASE)return;await supabaseRequest("/notifications?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{id:n.id,server_id:n.serverId,channel_id:n.channelId,viewer:n.viewer,kind:n.kind,tier:n.tier,title:n.title,message:n.message,metadata:n.metadata||{},created_at:n.createdAt,read_at:n.readAt||null}])});}

app.get("/profile/:viewer",async(req,res)=>{const scope=progressionScope(req,req.params.viewer);if(!scope.viewer||!scope.channelId)return res.status(400).json({ok:false,error:"Missing viewer or channel"});const wallet=getWalletResolved(scopedViewerKey(scope.viewer,scope.channelId,scope.serverId),false);const linked=parseCompanionLink(wallet?.companionName||"");const p=ensureProgression(scope,wallet?.displayName||scope.viewer,linked.companionName||"");const daily=ensureBountyState(scope,"daily",!!p.profile.companionName);const weekly=ensureBountyState(scope,"weekly",!!p.profile.companionName);res.set("Cache-Control","no-store");res.json({ok:true,profile:p.profile,statistics:p.stats.statistics,achievements:p.achievements,titles:p.titles,achievementDefinitions:ACHIEVEMENT_DEFINITIONS,daily:publicBountyState(daily),weekly:publicBountyState(weekly)});});
app.post("/bounties/select",async(req,res)=>{const scope=progressionScope(req,req.body.viewer);const type=String(req.body.periodType||"").toLowerCase();const bountyId=String(req.body.bountyId||"");if(!["daily","weekly"].includes(type))return res.status(400).json({ok:false,error:"Invalid bounty period"});const p=ensureProgression(scope,req.body.displayName||"",req.body.companionName||"");const state=ensureBountyState(scope,type,!!p.profile.companionName);if(state.status!=="choosing"||state.selectedBountyId)return res.status(409).json({ok:false,error:"A bounty is already selected"});const selected=(state.choices||[]).find(b=>b.id===bountyId);if(!selected)return res.status(400).json({ok:false,error:"Bounty is not one of the offered choices"});state.selectedBountyId=selected.id;state.selectedBounty=selected;state.progress={};state.status="active";state.selectedAt=new Date().toISOString();state.updatedAt=state.selectedAt;emitProgressionNotification(scope,{kind:"bounty_selected",tier:type==="weekly"?"rare":"common",title:`${type === "daily" ? "Daily" : "Weekly"} Bounty Active`,message:selected.name,dedupeKey:`${type}:${state.periodKey}:selected`,dedupeWindowMs:86400000});await syncBountyState(state);res.json({ok:true,bounty:publicBountyState(state)});});
app.post("/bounties/claim",async(req,res)=>{const scope=progressionScope(req,req.body.viewer);const type=String(req.body.periodType||"").toLowerCase();const p=ensureProgression(scope,req.body.displayName||"",req.body.companionName||"");const state=ensureBountyState(scope,type,!!p.profile.companionName);if(state.status!=="completed"||state.rewardClaimed)return res.status(409).json({ok:false,error:"Bounty is not ready to claim"});grantProgressionReward(p.profile,state.selectedBounty.reward||{},`${type}_bounty`);state.rewardClaimed=true;state.status="claimed";state.claimedAt=new Date().toISOString();emitProgressionNotification(scope,{kind:"bounty_claimed",tier:type==="weekly"?"epic":"rare",title:"Bounty Reward Claimed!",message:`Rewards from ${state.selectedBounty.name} were added to your crew.`,dedupeKey:`${type}:${state.periodKey}:claimed`,dedupeWindowMs:86400000});const metric=type==="daily"?"daily_bounties_completed":"weekly_bounties_completed";recordProgressionMetric(scope,metric,1);recordProgressionMetric(scope,"bounties_completed",1);await syncBountyState(state);res.json({ok:true,bounty:publicBountyState(state),reward:state.selectedBounty.reward});});

app.get("/notifications/:viewer",(req,res)=>{const scope=progressionScope(req,req.params.viewer);if(!scope.viewer||!scope.channelId)return res.status(400).json({ok:false,error:"Missing viewer or channel"});const after=String(req.query.after||"");const limit=Math.max(1,Math.min(100,Number(req.query.limit||50)));let notices=notificationList(scope).slice();if(after){const afterTime=Date.parse(after);if(Number.isFinite(afterTime))notices=notices.filter(n=>Date.parse(n.createdAt)>afterTime);}res.set("Cache-Control","no-store");res.json({ok:true,notifications:notices.slice(0,limit),unread:notificationList(scope).filter(n=>!n.readAt).length});});
app.post("/notifications/read",async(req,res)=>{const scope=progressionScope(req,req.body.viewer);const ids=Array.isArray(req.body.ids)?new Set(req.body.ids.map(String)):null;const readAt=new Date().toISOString();const changed=notificationList(scope).filter(n=>!n.readAt&&(!ids||ids.has(n.id)));for(const n of changed)n.readAt=readAt;if(USE_SUPABASE&&changed.length){const filter=`server_id=eq.${encodeURIComponent(scope.serverId)}&channel_id=eq.${encodeURIComponent(scope.channelId)}&viewer=eq.${encodeURIComponent(scope.viewer)}`;await supabaseRequest(`/notifications?${filter}`,{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({read_at:readAt})});}res.json({ok:true,read:changed.length});});
app.post("/profile/title",async(req,res)=>{const scope=progressionScope(req,req.body.viewer);const p=ensureProgression(scope,req.body.displayName||"",req.body.companionName||"");const titleId=String(req.body.titleId||"");if(titleId&&!p.titles[titleId])return res.status(403).json({ok:false,error:"Title is not unlocked"});p.profile.selectedTitleId=titleId;p.profile.updatedAt=new Date().toISOString();await syncProgressionProfile(p);res.json({ok:true,selectedTitleId:titleId});});
app.post("/progression/activity",requireApiKey,(req,res)=>{const scope=progressionScope(req,req.body.viewer);const metric=String(req.body.metric||"").trim();const amount=Number(req.body.amount||1);if(!scope.viewer||!scope.channelId||!metric||!Number.isFinite(amount))return res.status(400).json({ok:false,error:"Invalid progression activity"});recordProgressionMetric(scope,metric,amount,req.body);res.json({ok:true,metric,amount});});
app.post("/progression/vault-activity",requireApiKey,(req,res)=>{const serverId=normalizeServerId(req.body.serverId||firstEnabledServerId());const channelId=normalizeChannelId(req.body.channelId||req.body.channel||"");const metric=String(req.body.metric||"").trim();const amount=Number(req.body.amount||1);if(!channelId||!metric||!Number.isFinite(amount))return res.status(400).json({ok:false,error:"Invalid vault activity"});const participants=progressionVaultParticipants.get(`${serverId}::${channelId}`)||new Map();for(const scope of participants.values())recordProgressionMetric(scope,metric,amount,scope);res.json({ok:true,metric,amount,participants:participants.size});});

async function deleteProgressionForScope(scope){if(USE_SUPABASE){const filter=`server_id=eq.${encodeURIComponent(scope.serverId)}&channel_id=eq.${encodeURIComponent(scope.channelId)}&viewer=eq.${encodeURIComponent(scope.viewer)}`;for(const table of ["notifications","bounty_history","bounty_state","achievements","titles","profile_statistics","profiles"])await supabaseRequest(`/${table}?${filter}`,{method:"DELETE",headers:{Prefer:"return=minimal"}});}const prefix=progressionKey(scope.serverId,scope.channelId,scope.viewer);for(const map of [progressionProfiles,progressionStats,progressionAchievements,progressionTitles,progressionNotifications])map.delete(prefix);for(const key of Array.from(progressionBounties.keys()))if(key.startsWith(prefix+"::"))progressionBounties.delete(key);}
app.post("/admin/progression/reset-player",requireApiKey,async(req,res)=>{const scope=progressionScope(req,req.body.viewer);if(String(req.body.confirm||"").toLowerCase()!=="confirm")return res.status(400).json({ok:false,error:"Confirmation required"});await deleteProgressionForScope(scope);res.json({ok:true,reset:"progression",...scope});});
app.post("/admin/bounties/reset",requireApiKey,async(req,res)=>{const scope=progressionScope(req,req.body.viewer);if(String(req.body.confirm||"").toLowerCase()!=="confirm")return res.status(400).json({ok:false,error:"Confirmation required"});const type=String(req.body.periodType||"all");const filterBase=`server_id=eq.${encodeURIComponent(scope.serverId)}&channel_id=eq.${encodeURIComponent(scope.channelId)}&viewer=eq.${encodeURIComponent(scope.viewer)}`;if(USE_SUPABASE)await supabaseRequest(`/bounty_state?${filterBase}${type!=="all"?`&period_type=eq.${type}`:""}`,{method:"DELETE",headers:{Prefer:"return=minimal"}});const prefix=progressionKey(scope.serverId,scope.channelId,scope.viewer);for(const key of Array.from(progressionBounties.keys()))if(key.startsWith(prefix+"::")&&(type==="all"||key.endsWith(`::${type}`)))progressionBounties.delete(key);res.json({ok:true,reset:"bounties",periodType:type,...scope});});
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
