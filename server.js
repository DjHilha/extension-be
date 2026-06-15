const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "change-me";

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PRICES = {
    BUY_TRAIL: 100,
    BUY_RELIC: 125,
    BUY_ANCIENT_RELIC: 200,
    REROLL_RELIC: 150,
    REROLL_ANCIENT_RELIC: 200
};

let companionsData = {
    companions: []
};

let tasksData = {
    active: false,
    tasks: []
};

let shopActionQueue = [];

let wallets = {};

function normalizeViewer(viewer) {
    return String(viewer || "")
        .trim()
        .toLowerCase();
}

function getWallet(viewer) {
    const key = normalizeViewer(viewer);

    if (!key) return null;

    if (!wallets[key]) {
        wallets[key] = {
            viewer: key,
            dirt: 0
        };
    }

    return wallets[key];
}

function spendDirt(viewer, amount, reason) {
    const wallet = getWallet(viewer);
    const cost = Math.floor(Number(amount || 0));

    if (!wallet) {
        return {
            ok: false,
            error: "Missing viewer"
        };
    }

    if (!Number.isFinite(cost) || cost <= 0) {
        return {
            ok: false,
            error: "Invalid amount"
        };
    }

    if (wallet.dirt < cost) {
        return {
            ok: false,
            error: "Not enough Dirt",
            viewer: wallet.viewer,
            dirt: wallet.dirt,
            required: cost
        };
    }

    wallet.dirt -= cost;

    console.log(
        `[WALLET] -${cost} Dirt from ${wallet.viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`
    );

    return {
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt,
        spent: cost,
        reason
    };
}

function queueShopAction(action) {
    const request = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: new Date().toISOString(),
        ...action
    };

    shopActionQueue.push(request);

    console.log(
        `[SHOP] Queued ${request.action} for ${request.viewer}`
    );

    return request;
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
        service: "Meowtys backend",
        prices: PRICES
    });
});

app.get("/prices", (req, res) => {
    res.json({
        ok: true,
        prices: PRICES
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
    const added = Math.floor(amount);

    wallet.dirt += added;

    console.log(
        `[WALLET] +${added} Dirt to ${viewer} | Reason: ${reason} | Balance: ${wallet.dirt}`
    );

    res.json({
        ok: true,
        viewer: wallet.viewer,
        dirt: wallet.dirt,
        added,
        reason
    });
});

app.post("/wallet/spend", requireApiKey, (req, res) => {
    const result = spendDirt(
        req.body.viewer,
        req.body.amount,
        String(req.body.reason || "spend")
    );

    if (!result.ok) {
        return res.status(400).json(result);
    }

    res.json(result);
});

app.post("/shop/buy-trail", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();

    const trailType = Number(req.body.trailType);
    const color = Number(req.body.color);
    const trailTypeName = String(req.body.trailTypeName || "").trim();
    const colorName = String(req.body.colorName || "").trim();

    const allowedTrailTypes = new Set([0, 1, 2, 3]);

    if (!viewer || !companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer or companion"
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

    const spend = spendDirt(
        viewer,
        PRICES.BUY_TRAIL,
        "buy_trail"
    );

    if (!spend.ok) {
        return res.status(400).json(spend);
    }

    const request = queueShopAction({
        action: "buy_trail",
        viewer,
        companionName,
        trailType,
        trailTypeName,
        color,
        colorName,
        cost: PRICES.BUY_TRAIL
    });

    res.json({
        ok: true,
        request,
        wallet: spend
    });
});

app.post("/shop/trail", (req, res) => {
    req.body.companionName = req.body.companionName || req.body.viewer;
    return app._router.handle({
        ...req,
        url: "/shop/buy-trail",
        method: "POST"
    }, res, () => {});
});

app.post("/shop/buy-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();

    if (!viewer || !companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer or companion"
        });
    }

    const spend = spendDirt(
        viewer,
        PRICES.BUY_RELIC,
        "buy_relic"
    );

    if (!spend.ok) {
        return res.status(400).json(spend);
    }

    const request = queueShopAction({
        action: "buy_relic",
        viewer,
        companionName,
        cost: PRICES.BUY_RELIC
    });

    res.json({
        ok: true,
        request,
        wallet: spend
    });
});

app.post("/shop/buy-ancient-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();

    if (!viewer || !companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer or companion"
        });
    }

    const spend = spendDirt(
        viewer,
        PRICES.BUY_ANCIENT_RELIC,
        "buy_ancient_relic"
    );

    if (!spend.ok) {
        return res.status(400).json(spend);
    }

    const request = queueShopAction({
        action: "buy_ancient_relic",
        viewer,
        companionName,
        cost: PRICES.BUY_ANCIENT_RELIC
    });

    res.json({
        ok: true,
        request,
        wallet: spend
    });
});

app.post("/shop/reroll-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const slot = Number(req.body.slot);

    if (!viewer || !companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer or companion"
        });
    }

    if (!Number.isInteger(slot) || slot < 0 || slot > 3) {
        return res.status(400).json({
            ok: false,
            error: "Invalid relic slot"
        });
    }

    const spend = spendDirt(
        viewer,
        PRICES.REROLL_RELIC,
        "reroll_relic"
    );

    if (!spend.ok) {
        return res.status(400).json(spend);
    }

    const request = queueShopAction({
        action: "reroll_relic",
        viewer,
        companionName,
        slot,
        cost: PRICES.REROLL_RELIC
    });

    res.json({
        ok: true,
        request,
        wallet: spend
    });
});

app.post("/shop/reroll-ancient-relic", (req, res) => {
    const viewer = normalizeViewer(req.body.viewer);
    const companionName = String(req.body.companionName || req.body.viewer || "").trim();
    const slot = Number(req.body.slot || 0);

    if (!viewer || !companionName) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer or companion"
        });
    }

    if (!Number.isInteger(slot) || slot < 0 || slot > 0) {
        return res.status(400).json({
            ok: false,
            error: "Invalid ancient relic slot"
        });
    }

    const spend = spendDirt(
        viewer,
        PRICES.REROLL_ANCIENT_RELIC,
        "reroll_ancient_relic"
    );

    if (!spend.ok) {
        return res.status(400).json(spend);
    }

    const request = queueShopAction({
        action: "reroll_ancient_relic",
        viewer,
        companionName,
        slot,
        cost: PRICES.REROLL_ANCIENT_RELIC
    });

    res.json({
        ok: true,
        request,
        wallet: spend
    });
});

app.get("/shop/actions/queue", requireApiKey, (req, res) => {
    res.json({
        ok: true,
        queue: shopActionQueue
    });
});

app.post("/shop/actions/queue/clear", requireApiKey, (req, res) => {
    const ids =
        Array.isArray(req.body.ids)
            ? req.body.ids
            : [];

    shopActionQueue =
        shopActionQueue.filter(item => !ids.includes(item.id));

    res.json({
        ok: true,
        remaining: shopActionQueue.length
    });
});

app.get("/shop/trail/queue", requireApiKey, (req, res) => {
    res.json({
        ok: true,
        queue: shopActionQueue.filter(item => item.action === "buy_trail")
    });
});

app.post("/shop/trail/queue/clear", requireApiKey, (req, res) => {
    const ids =
        Array.isArray(req.body.ids)
            ? req.body.ids
            : [];

    shopActionQueue =
        shopActionQueue.filter(item => !ids.includes(item.id));

    res.json({
        ok: true,
        remaining: shopActionQueue.length
    });
});

app.listen(PORT, () => {
    console.log(`Meowtys backend running on port ${PORT}`);
});
