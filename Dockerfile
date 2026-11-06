FROM caddy:2-alpine AS caddy

FROM node:22-alpine
# caddy-Binary nur für `caddy fmt` / `caddy validate` (der Server selbst läuft nicht darin)
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=8080 CADDYFILE=/config/Caddyfile BACKUP_DIR=/data/backups NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server.js"]
