FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/Jashan-randhawa/Job-mail-Automation"
LABEL org.opencontainers.image.description="WhatsApp Outreach Microservice"

# Baileys talks to WhatsApp over a raw WebSocket, not a headless browser —
# no Chromium, so none of the Puppeteer shared-library installs the old
# whatsapp-web.js-based image needed. Just CA certs for outbound TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data

EXPOSE 4000
CMD ["node", "server.js"]
