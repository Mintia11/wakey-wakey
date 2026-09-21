FROM oven/bun:1-alpine
WORKDIR /app

# Install deps first so this layer is cached until the lockfile changes
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production

COPY . .

USER bun
CMD ["bun", "run", "index.js"]