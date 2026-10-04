# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# The image installs the npm release of the version in package.json. Its shrinkwrap pins the same Playwright
# as this base image, so the image's Chromium is used and nothing is downloaded at run time.
COPY package.json /tmp/plainwright-package.json
RUN npm install --global --no-audit --no-fund "plainwright@$(node -p "require('/tmp/plainwright-package.json').version")" && \
    rm /tmp/plainwright-package.json && \
    mkdir -p /work && chown pwuser:pwuser /work

USER pwuser
WORKDIR /work
ENTRYPOINT ["plainwright", "--headless"]
