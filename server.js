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

app.post("/shop/trail", (req, res) => {
    const viewer = String(req.body.viewer || "").trim();
    const color = String(req.body.color || "").trim().toLowerCase();

    const allowedColors = new Set([
        "white",
        "orange",
        "magenta",
        "light_blue",
        "yellow",
        "lime",
        "pink",
        "cyan",
        "purple",
        "blue",
        "gold",
        "green",
        "red",
        "black",
        "gray",
        "light_gray",
        "brown"
    ]);

    if (!viewer) {
        return res.status(400).json({
            ok: false,
            error: "Missing viewer"
        });
    }

    if (!allowedColors.has(color)) {
        return res.status(400).json({
            ok: false,
            error: "Invalid trail color"
        });
    }

    const request = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        viewer,
        color,
        createdAt: new Date().toISOString()
    };

    trailQueue.push(request);

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
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

    trailQueue = trailQueue.filter(item => !ids.includes(item.id));

    res.json({
        ok: true,
        remaining: trailQueue.length
    });
});

app.listen(PORT, () => {
    console.log(`Meowtys backend running on port ${PORT}`);
});
