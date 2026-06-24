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
    if (USE_SUPABASE) {
        wallets = {};
    } else {
        wallets = readJsonFile(WALLETS_FILE, {});
    }

    shopActionQueue = readJsonFile(QUEUE_FILE, []);
    watchers = readJsonFile(WATCHERS_FILE, {});
    forgeryData = readJsonFile(FORGERY_FILE, {});
    trainingData = readJsonFile(TRAINING_FILE, {});

    await loadWalletsFromSupabase();

    console.log(`[DATA] Loaded ${Object.keys(wallets).length} wallets and ${shopActionQueue.length} queued shop actions and ${Object.keys(watchers).length} watchers.`);
}


function saveWallets() {
    writeJsonFile(WALLETS_FILE, wallets);
    syncWalletsToSupabaseSoon();
}

function saveQueue() { writeJsonFile(QUEUE_FILE, shopActionQueue); }
function saveWatchers() { writeJsonFile(WATCHERS_FILE, watchers); }
function saveForgery() { writeJsonFile(FORGERY_FILE, forgeryData); }
function saveTraining() { writeJsonFile(TRAINING_FILE, trainingData); }

function walletToSupabaseRow(wallet) {
    return {
        viewer: String(wallet.viewer || "").toLowerCase(),
        dirt: Number(wallet.dirt || 0),
        twitch_id: String(wallet.twitchId || ""),
        display_name: String(wallet.displayName || wallet.viewer || ""),
        companion_name: String(wallet.companionName || ""),
        updated_at: wallet.updatedAt || new Date().toISOString()
    };
}

function supabaseRowToWallet(row) {
    const viewer = String(row.viewer || "").toLowerCase();

    return {
        viewer,
        dirt: Number(row.dirt || 0),
        twitchId: String(row.twitch_id || ""),
        displayName: String(row.display_name || viewer),
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

    await supabaseRequest("/wallets?on_conflict=viewer", {
        method: "POST",
        headers: {
            Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify(rows)
    });

    console.log(`[SUPABASE] Synced ${rows.length} wallet(s).`);
}

async function syncViewerLinkToSupabase(wallet) {
    if (!USE_SUPABASE || !wallet) {
        return;
    }

    const row = walletToSupabaseRow(wallet);

    await supabaseRequest("/viewer_links?on_conflict=viewer", {
        method: "POST",
        headers: {
            Prefer: "resolution=merge-duplicates"
        },
        body: JSON.stringify([row])
    });

    console.log(`[SUPABASE] Synced viewer link for ${row.viewer}.`);
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

function linkWalletCompanion(viewer, twitchId, displayName, companionName) {
    const wallet = updateWalletIdentity(viewer, twitchId, displayName);
    if (!wallet) return null;

    const cleanCompanionName = String(companionName || "").trim();

    if (cleanCompanionName) {
        wallet.companionName = cleanCompanionName;
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

    /*
     * IMPORTANT:
     * Resolve companion/display aliases BEFORE direct wallet keys.
     *
     * This prevents old/fake rows like:
     *   viewer = "hilha"
     * from stealing rewards that should go to:
     *   viewer = "145555184", companionName = "Hilha"
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

    if (wallets[wanted]) {
        return wanted;
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

    return {
        viewer: wallet.viewer,
        dirt: Number(wallet.dirt || 0),
        twitchId: String(wallet.twitchId || ""),
        displayName: String(wallet.displayName || wallet.viewer || ""),
        companionName: String(wallet.companionName || ""),
        updatedAt: String(wallet.updatedAt || "")
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
    return `${normalizeViewer(viewer)}::${String(companionName || "").trim().toLowerCase()}`;
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

function validateForgeryBody(req) {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) {
        return { ok: false, status: 400, error: "Missing viewer or companion" };
    }
    return { ok: true, viewer, companionName };
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

app.get("/", (req, res) => res.json({ ok: true, service: "Meowtys backend", prices: PRICES, persistence: { dataDir: DATA_DIR, wallets: Object.keys(wallets).length, queuedActions: shopActionQueue.length } }));
app.get("/prices", (req, res) => res.json({ ok: true, prices: PRICES }));
app.get("/companions", (req, res) => res.json(companionsData));
app.post("/companions", requireApiKey, (req, res) => {
    if (!req.body || !Array.isArray(req.body.companions)) return res.status(400).json({ ok: false, error: "Expected body with companions array" });
    companionsData = req.body;
    res.json({ ok: true, count: companionsData.companions.length });
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
    const wallet = getWalletResolved(req.params.viewer, false);

    if (!wallet) {
        return res.status(404).json({
            ok: false,
            error: "Wallet not found",
            viewer: req.params.viewer
        });
    }

    res.json({ ok: true, ...publicWallet(wallet) });
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
    const viewer = normalizeViewer(req.body.viewer);
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


app.post("/watch/identity", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
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
    const watcher = getWatcher(req.params.viewer);

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
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion name" });
    const alreadyExists = Array.isArray(companionsData.companions) && companionsData.companions.some(c => String(c.name || "").toLowerCase() === companionName.toLowerCase());
    if (alreadyExists) return res.status(400).json({ ok: false, error: "A companion with that name already exists" });
    const spend = spendDirt(viewer, PRICES.CREATE_COMPANION, "create_companion");
    if (!spend.ok) return res.status(400).json(spend);

    const linkedWallet =
            linkWalletCompanion(
                    viewer,
                    req.body.twitchId || "",
                    req.body.displayName || viewer,
                    companionName
            );

    const request = queueShopAction({
        action: "create_companion",
        viewer,
        companionName,
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
    const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_RELIC, "buy_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_relic", viewer, companionName, cost: PRICES.BUY_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/buy-ancient-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const spend = spendDirt(viewer, PRICES.BUY_ANCIENT_RELIC, "buy_ancient_relic");
    if (!spend.ok) return res.status(400).json(spend);
    const request = queueShopAction({ action: "buy_ancient_relic", viewer, companionName, cost: PRICES.BUY_ANCIENT_RELIC });
    res.json({ ok: true, request, wallet: spend });
});
app.post("/shop/reroll-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
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
        const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    const skinName = String(req.body.skinName || "").trim();
    if (!viewer || !companionName || !skinName) return res.status(400).json({ ok: false, error: "Missing viewer, companion, or skin" });
    const request = queueShopAction({ action: "switch_skin", viewer, companionName, skinName, cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/crew-quarters", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "crew_quarters", viewer, companionName, cost: 0 });
    res.json({ ok: true, request });
});

app.post("/shop/back-to-work", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const request = queueShopAction({ action: "back_to_work", viewer, companionName, cost: 0 });
    res.json({ ok: true, request });
});


app.get("/forgery/:viewer/:companionName", (req, res) => {
    const viewer = normalizeViewer(req.params.viewer);
    const companionName = String(req.params.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    const state = getForgeryState(viewer, companionName);
    res.json({ ok: true, forgery: publicForgeryState(state) });
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

function trainingKey(viewer, companionName) {
    return `${normalizeViewer(viewer)}::${String(companionName || "").trim().toLowerCase()}`;
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
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || "").trim();
    if (!viewer || !companionName) return { ok: false, status: 400, error: "Missing viewer or companion." };
    return { ok: true, viewer, companionName };
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
    const viewer = normalizeViewer(req.params.viewer);
    const companionName = String(req.params.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companion" });
    res.json({ ok: true, training: publicTrainingState(getTrainingState(viewer, companionName)) });
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
    setCooldown(state, `combat_${tierName}`, tier.cooldownMs);
    addTrainingHistory(state, `${tier.label}: queued ${Math.round(xpPercent * 100)}% TNL XP.`);
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
    const spend = spendDirt(valid.viewer, PRICES.TRAINING_STUDY, "training_study");
    if (!spend.ok) return res.status(400).json(spend);
    state.study = state.study || {};
    state.study[focus] = Math.min(10, Number(state.study[focus] || 0) + 0.25);
    addMastery(state, 12);
    addTrainingHistory(state, `Study: ${focus.replace(/_/g, ' ')} improved to ${state.study[focus]}%.`);
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
        addTrainingHistory(state, ancientFound ? "Expedition complete: found 1 Relic Fragment and 1 Ancient Relic Fragment." : "Expedition complete: found 1 Relic Fragment.");
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
    const opponent = String(req.body.opponent || "Training Dummy").trim() || "Training Dummy";
    const spend = spendDirt(valid.viewer, PRICES.TRAINING_SPARRING, "training_sparring");
    if (!spend.ok) return res.status(400).json(spend);
    const state = getTrainingState(valid.viewer, valid.companionName);
    finalizeTrainingState(state);
    const power = Math.random() + Number(state.masteryLevel || 1) * 0.02;
    const enemy = Math.random() + 0.25;
    const won = power >= enemy;
    if (won) state.sparWins = Number(state.sparWins || 0) + 1; else state.sparLosses = Number(state.sparLosses || 0) + 1;
    const xpPercent = won ? 0.07 : 0.025;
    const request = queueShopAction({ action: "training_xp", viewer: valid.viewer, companionName: valid.companionName, xpPercent, trainingType: "sparring", cost: PRICES.TRAINING_SPARRING });
    addMastery(state, won ? 18 : 7);
    addTrainingHistory(state, `Sparring vs ${opponent}: ${won ? "won" : "lost"}, ${Math.round(xpPercent * 100)}% TNL XP queued.`);
    saveTraining();
    res.json({ ok: true, won, request, wallet: spend, training: publicTrainingState(state) });
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
function adminTrainingAndForgeryState(viewer, companionName) {
    const training = getTrainingState(viewer, companionName);
    const forgery = getForgeryState(viewer, companionName);
    finalizeTrainingState(training);
    return {
        training: publicTrainingState(training),
        forgery: publicForgeryState(forgery),
        wallet: publicWallet(getWallet(viewer))
    };
}

function validateAdminCompanionBody(req) {
    const viewer = normalizeViewer(req.body.viewer || req.body.identifier);
    const companionName = String(req.body.companionName || req.body.companion || "").trim();
    if (!viewer || !companionName) {
        return { ok: false, status: 400, error: "Missing viewer or companionName." };
    }
    return { ok: true, viewer, companionName };
}

app.get("/admin/training/:viewer/:companionName", requireApiKey, (req, res) => {
    const viewer = normalizeViewer(req.params.viewer);
    const companionName = String(req.params.companionName || "").trim();
    if (!viewer || !companionName) return res.status(400).json({ ok: false, error: "Missing viewer or companionName." });
    res.json({ ok: true, ...adminTrainingAndForgeryState(viewer, companionName) });
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
    const viewer = normalizeViewer(req.body.viewer);
    const twitchId = String(req.body.twitchId || "").trim();
    const displayName = String(req.body.displayName || viewer).trim();
    const companionName = String(req.body.companionName || "").trim();

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    const wallet = linkWalletCompanion(
            viewer,
            twitchId,
            displayName,
            companionName
    );

    res.json({
        ok: true,
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
    const viewer = normalizeViewer(req.body.viewer);
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
    const viewer = normalizeViewer(req.body.viewer);
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
