FROM oven/bun:1 AS base

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata
RUN apt-get update && apt-get install -y python3 build-essential

COPY . /usr/src/preservetube/metadata
RUN bun install

CMD ["bun", "run", "index.ts"]