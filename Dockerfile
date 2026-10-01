FROM node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY LICENSE ./
COPY src ./src
COPY examples ./examples
COPY mcp/records ./mcp/records
RUN mkdir -p /runtime-root/state \
    && chown 1000:1000 /runtime-root/state \
    && chmod 0700 /runtime-root/state

FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2

WORKDIR /app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /app /app
COPY --from=build --chown=1000:1000 /runtime-root/ /
USER 1000:1000
ENV NODE_ENV=production
ENV PATH=/usr/local/bin
ENTRYPOINT ["/usr/local/bin/node", "/app/src/cli.mjs"]
CMD ["--help"]
