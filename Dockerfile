# ---- dependencies ----
# Installed in a separate stage so npm's cache and any transient build files
# never reach the runtime image.
FROM node:24.12.0-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
# npm install (not ci) because the committed package-lock.json is out of sync
# with package.json; switch to `npm ci` once the lockfile is regenerated.
RUN npm install --omit=dev --silent --no-audit --no-fund \
    && npm cache clean --force

# ---- runtime ----
FROM node:24.12.0-alpine

# set working directory
WORKDIR /app

EXPOSE 3000/tcp

# variables to configure the swagger doc
ENV ANGLES_API_BASE_URL=127.0.0.1:3000
ENV ANGLES_API_BASE_PATH=/rest/api/v1.0
ENV SWAGGER_SCHEMES=http

VOLUME /app/screenshots
VOLUME /app/compares

# runtime tools required by the clean-up crontab:
# bash (clean-up.sh uses readarray), curl + jq (query the API), dcron (scheduler)
# tini: minimal init so SIGTERM reaches node (node ignores it as PID 1)
RUN apk add --no-cache bash curl jq dcron tini

# crontab
COPY cleanup /app/cleanup
RUN cp /app/cleanup/crontab /etc/crontabs/root \
    && chmod 0644 /etc/crontabs/root

# install app dependencies
COPY --from=deps /app/node_modules ./node_modules

# add app
COPY . ./

# start app
# tini runs as PID 1 and forwards SIGTERM to node; `exec` replaces the startup
# shell with node so the signal reaches it. Without this, node ignores SIGTERM
# as PID 1 and `docker stop` SIGKILLs it after the 10s grace period.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "sh /app/cleanup/entrypoint.sh && crond && touch /var/log/cron.log && exec node server.js"]
