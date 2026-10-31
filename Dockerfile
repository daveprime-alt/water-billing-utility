FROM node:22-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN npm ci && npm run db:generate

COPY . .

EXPOSE 4000
CMD ["npm", "start"]
