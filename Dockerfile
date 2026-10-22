FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DOCKER=1 PORT=3000 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "server/index.js"]
