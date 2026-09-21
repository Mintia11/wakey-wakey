# wakey-wakey

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

Required env vars:

```bash
BOT_TOKEN=...
OWNER_ID=...
GOOGLE_MAPS_KEY=...
HOME="..."
DESTINATION="..."
IMAGE_BASE_URL="https://your-public-base-url"
```

Optional env vars:

```bash
IMAGE_PORT=3000
IMAGE_TTL_SECONDS=900
SEND_AT="30 7 * * *"
TZ="Europe/Rome"
```

Inline usage on Telegram:

1. In any chat, type `@your_bot_username eta` (or `wenclair`, `wens`, `enid`).
2. Pick the inline result to send the ETA card with the hosted map image.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
