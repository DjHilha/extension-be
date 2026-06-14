# Meowtys Backend

## Render settings

Build Command:

```bash
npm install
```

Start Command:

```bash
npm start
```

## Environment variables

Set this in Render:

```text
API_KEY=make-a-long-secret-key
```

Use the same key later in the Minecraft uploader/mod bridge.

## Public endpoints

```text
GET /companions
GET /tasks
POST /shop/trail
```

## Private endpoints

Require header:

```text
x-api-key: YOUR_API_KEY
```

```text
POST /companions
POST /tasks
GET /shop/trail/queue
POST /shop/trail/queue/clear
```
