# KyPost Demo Mail Server.
#
# OpenPGP.js encrypts trigger replies to the submitting user's public key.
FROM node:24-alpine

# openssl: generates the sandbox certificate on first start. 443/587/993 need no
# capability — Docker sets ip_unprivileged_port_start=0 inside the container.
RUN apk add --no-cache openssl

RUN addgroup -S -g 10001 kypost \
 && adduser -S -u 10001 -G kypost kypost

WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY corpus ./corpus

# Private key material lives here and is never a volume: a container restart
# regenerates it. The published certificate goes to /srv/tls-public, which the
# compose file shares read-only with KyPost Server.
RUN mkdir -p /run/kypost-tls /srv/tls-public \
 && chown kypost:kypost /run/kypost-tls /srv/tls-public \
 && chmod 700 /run/kypost-tls

USER kypost

ENV NODE_ENV=production \
    IMAP_PORT=993 \
    SMTP_PORT=587 \
    HTTPS_PORT=443 \
    TLS_KEY_DIR=/run/kypost-tls \
    TLS_PUBLISH_DIR=/srv/tls-public \
    RESET_ENABLED=false

# Documentation only. These ports are reachable on KyPost-Net and are never
# published to the host — see docker-compose.yml.
EXPOSE 993 587 443

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/src/healthcheck.js"]

CMD ["node", "/app/src/index.js"]
