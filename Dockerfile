FROM oven/bun:1 AS base

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential curl xz-utils ca-certificates

COPY . /usr/src/preservetube/metadata
RUN bun install

RUN curl -L https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz \
  | tar -xJ --strip-components=1 -C /tmp ffmpeg-master-latest-linux64-gpl/bin/ffmpeg \
  && mv /tmp/bin/ffmpeg /usr/local/bin/ffmpeg

CMD ["bun", "run", "index.ts"]