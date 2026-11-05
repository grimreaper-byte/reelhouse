# Reelhouse media server
#   docker build -t reelhouse .
#   docker compose up -d        (see docker-compose.yml)

# The app tunnel helper (tunnel/, Go), built without needing Go on the machine. A plain stage (no
# --platform=$BUILDPLATFORM) so older Docker installs without BuildKit can build the image too.
FROM golang:1.25 AS tunnel
WORKDIR /src
COPY tunnel/go.mod tunnel/go.sum ./
RUN go mod download
COPY tunnel/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/reelhouse-tunnel .

FROM node:24-slim

# ffmpeg for scanning and transcoding; Mesa (AMD) and Intel VA-API drivers for hardware
# encoding. Intel's driver only exists for amd64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini mesa-va-drivers \
 && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY web ./web
COPY LICENSE ./
# The Kodi add-on, handed out at /kodi/ (its tests stay out of the image).
COPY kodi/plugin.video.reelhouse ./kodi/plugin.video.reelhouse
COPY --from=tunnel /out/reelhouse-tunnel ./tunnel/bin/reelhouse-tunnel
COPY docker/entrypoint.sh /usr/local/bin/reelhouse-entrypoint
RUN chmod 755 /usr/local/bin/reelhouse-entrypoint

# NVIDIA_* tell the NVIDIA Container Toolkit (installed on the *host*) which GPUs and driver
# libraries to inject: "video" brings NVENC, "utility" brings nvidia-smi for diagnostics.
# Without the toolkit these variables are simply ignored.
ENV NODE_ENV=production \
    REELHOUSE_DATA=/config \
    REELHOUSE_DOCKER=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

# The commit the image is built from, shown beside the version (Settings → Activity, the startup log line):
#   docker build --build-arg REELHOUSE_COMMIT=$(git rev-parse --short HEAD) -t reelhouse .
ARG REELHOUSE_COMMIT=""
ENV REELHOUSE_COMMIT=$REELHOUSE_COMMIT

VOLUME ["/config"]
# 51821/udp: the app tunnel (Settings → Remote access), once turned on.
EXPOSE 8484 8443 51821/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/reelhouse-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
