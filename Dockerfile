FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        libpcre2-8-0=10.46-1~deb13u3 \
        libssl3t64=3.5.7-1~deb13u3 \
        openssl-provider-legacy=3.5.7-1~deb13u3 \
    && rm -rf /var/lib/apt/lists/*

COPY LICENSE ./
COPY src ./src
COPY examples ./examples
COPY mcp/records ./mcp/records
RUN find /usr -xdev -type f -perm /6000 -exec chmod a-s {} +
RUN mkdir /state \
    && chown 1000:1000 /state \
    && chmod 0700 /state

USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["--help"]
