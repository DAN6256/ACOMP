FROM node:22-bookworm-slim

# Space-separated cores to install, e.g. "arduino:avr esp32:esp32".
ARG ARDUINO_CORES="arduino:avr"
# Extra board manager URLs for third-party cores (comma-separated), e.g. ESP32:
# https://espressif.github.io/arduino-esp32/package_esp32_index.json
ARG ARDUINO_BOARD_URLS=""
ARG ARDUINO_CLI_VERSION="1.5.1"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh -s "${ARDUINO_CLI_VERSION}" \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Install cores as the unprivileged user that runs the server.
USER node
ENV ARDUINO_DIRECTORIES_DATA=/home/node/.arduino15 \
    ARDUINO_DIRECTORIES_USER=/home/node/Arduino \
    ARDUINO_BUILD_CACHE_PATH=/home/node/.cache/arduino
RUN arduino-cli core update-index --additional-urls "${ARDUINO_BOARD_URLS}" \
 && arduino-cli core install ${ARDUINO_CORES} --additional-urls "${ARDUINO_BOARD_URLS}" \
 && arduino-cli core list

WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src

# Hosts like Render set their own PORT at runtime; 3000 is only the fallback.
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.js"]
