const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

let companionsData = {
    companions: []
};

let tasksData = {
    active: false,
    tasks: []
};

let trailQueue = [];

let wallets = {};

function normalizeViewer(viewer) {
    return String(viewer || "")
        .trim()
        .toLowerCase();
}

function getWallet(viewer) {
    const key = normalizeViewer(viewer);

    if (!key) {
        return null;
    }

    if (!wallets[key]) {
        wallets[key] = {
            viewer: key,
            dirt: 0
        };
    }

    return wallets[key];
}

function requireApiKey(req, res, next) {
    const key = req.headers["x-api-key"];

    if (!key || key !== API_KEY) {
        return res.status(401).json({
            ok: false,
            error: "Unauthorized"
        });
    }

    next();
}

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Meowtys backend"
    });
});

app.get("/companions", (req, res) => {
    res.json(companionsData);
});

app.post("/companions", requireApiKey, (req, res) => {
    if (!req.body || !Array.isArray(req.body.companions)) {
        return res.status(400).json({
            ok: false,
            error: "Expected body with companions array"
        });
    }

    companionsData = req.body;

    res.json({
        ok: true,
        count: companionsData.companions.length
    });
});

app.get("/tasks", (req, res) => {
    res.json(tasksData);
});

app.post("/tasks", requireApiKey, (req, res) => {
    if (!req.body || typeof req.body.active !== "boolean" || !Array.isArray(req.body.tasks)) {
        return res.status(400).json({
            ok: false,
            error: "Expected body with active boolean and tasks array"
        });
    }

    tasksData = req.body;

    res.json({
        ok: true,
        active: tasksData.active,
        count: tasksData.tasks.length
    });
});

app.get("/wallet/:viewer", (req, res) => {
    const wallet = getWallet(req.params.viewer);

    if (!wallet) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    res.json({
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt
    });
});

app.post("/wallet/add", requireApiKey, (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "manual");

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            ok: false,
            error: "Invalid amount"
        });
    }

    const wallet = getWallet(viewer);

    wallet.dirt += Math.floor(amount);

    console.log(
        `[WALLET] +${Math.floor(amount)} Dirt to ${viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`
    );

    res.json({
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt,
        added: Math.floor(amount),
        reason
    });
});

app.post("/wallet/spend", requireApiKey, (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const amount = Number(req.body.amount || 0);
    const reason = String(req.body.reason || "spend");

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
            ok: false,
            error: "Invalid amount"
        });
    }

    const wallet = getWallet(viewer);
    const cost = Math.floor(amount);

    if (wallet.dirt < cost) {
        return res.status(400).json({
            ok: false,
            error: "Not enough Dirt",
            viewer: wallet.viewer,
            dirt: wallet.dirt,
            required: cost
        });
    }

    wallet.dirt -= cost;

    console.log(
        `[WALLET] -${cost} Dirt from ${viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`
    );

    res.json({
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt,
        spent: cost,
        reason
    });
});

app.post("/shop/trail", (req, res) => {

    const viewer =
            String(req.body.viewer || "").trim();

    const trailType =
            Number(req.body.trailType);

    const color =
            Number(req.body.color);

    const trailTypeName =
            String(req.body.trailTypeName || "").trim();

    const colorName =
            String(req.body.colorName || "").trim();

    const allowedTrailTypes =
            new Set([0, 1, 2, 3]);

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (!allowedTrailTypes.has(trailType)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid trail type"
        });
    }

    if (Number.isNaN(color)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid color"
        });
    }

    const request = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,

        viewer,

        trailType,
        trailTypeName,

        color,
        colorName,

        createdAt: new Date().toISOString()
    };

    trailQueue.push(request);

    console.log(
        `[SHOP] ${viewer} bought ${colorName} ${trailTypeName}`
    );

    res.json({
        ok: true,
        request
    });
});

app.get("/shop/trail/queue", requireApiKey, (req, res) => {
    res.json({
        ok: true,
        queue: trailQueue
    });
});

app.post("/shop/trail/queue/clear", requireApiKey, (req, res) => {
    const ids =
            Array.isArray(req.body.ids)
                    ? req.body.ids
                    : [];

    trailQueue =
            trailQueue.filter(item => !ids.includes(item.id));

    res.json({
        ok: true,
        remaining: trailQueue.length
    });
});

app.listen(PORT, () => {
    console.log(`Meowtys backend running on port ${PORT}`);
});
