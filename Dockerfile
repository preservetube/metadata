FROM node:alpine

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata
RUN apk add --no-cache python3 alpine-sdk

COPY . /usr/src/preservetube/metadata
RUN bun install

CMD ["bun", "run", "index.ts"]