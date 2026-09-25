FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Install CA certificates for outbound TLS / SMTP
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
