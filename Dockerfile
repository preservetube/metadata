FROM node:alpine

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata
RUN apk add --no-cache python3 alpine-sdk

COPY . /usr/src/preservetube/metadata
RUN yarn

CMD ["node", "index.js"]