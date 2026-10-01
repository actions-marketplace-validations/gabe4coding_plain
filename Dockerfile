# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev && \
    mkdir -p /work && chown pwuser:pwuser /work

USER pwuser
WORKDIR /work
ENTRYPOINT ["node", "/app/dist/cli.js", "--headless"]
