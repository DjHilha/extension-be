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
    REROLL_LEGENDARY: 500
};

let companionsData = { companions: [] };
let tasksData = { active: false, tasks: [] };
let shopActionQueue = [];
let wallets = {};
let watchers = {};

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

    await loadWalletsFromSupabase();

    console.log(`[DATA] Loaded ${Object.keys(wallets).length} wallets and ${shopActionQueue.length} queued shop actions and ${Object.keys(watchers).length} watchers.`);
}


function saveWallets() {
    writeJsonFile(WALLETS_FILE, wallets);
    syncWalletsToSupabaseSoon();
}

function saveQueue() { writeJsonFile(QUEUE_FILE, shopActionQueue); }
function saveWatchers() { writeJsonFile(WATCHERS_FILE, watchers); }

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

function updateWalletIdentity(viewer, twitchId, displayName) {
    const wallet = getWallet(viewer);
    if (!wallet) return null;

    const cleanTwitchId = String(twitchId || "").trim();
    const cleanDisplayName = String(displayName || "").trim();

    if (cleanTwitchId) wallet.twitchId = cleanTwitchId;
    if (cleanDisplayName) wallet.displayName = cleanDisplayName;

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
    const voteKey = String(req.body.voteKey || "current");

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (!companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing companionName"
        });
    }

    const request = queueShopAction({
        action: "task_join",
        viewer,
        companionName,
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
    const vote = String(req.body.vote || "").toLowerCase();
    const voteKey = String(req.body.voteKey || "current");

    if (!viewer || !["support", "doubt"].includes(vote)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid vote"
        });
    }

    if (!companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing companionName"
        });
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
