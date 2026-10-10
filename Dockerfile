# The free hosted page: sitesnap with the email gate on and the local-only
# features (modern site mode, sign-in window, folders) switched off.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    SITESNAP_HOSTED=1 \
    HOST=0.0.0.0 \
    SITESNAP_LIBRARY=/tmp/sitesnap-library \
    SITESNAP_DATA=/tmp/sitesnap-data

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bin ./bin
COPY lib ./lib
COPY public ./public

USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/server.js"]
