FROM node:22-bookworm-slim

# Install Ghostscript, pstoedit, and standard vector fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    pstoedit \
    ca-certificates \
    fonts-freefont-ttf \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js health.html ./
RUN mkdir -p public runtime/tmp runtime/sources && mv health.html public/index.html

ENV NODE_ENV=production
ENV PORT=10000
ENV HOST=0.0.0.0

EXPOSE 10000

CMD ["node", "server.js"]
