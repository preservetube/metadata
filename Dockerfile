FROM node:alpine

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata

COPY . /usr/src/preservetube/metadata
RUN -mount=type=secret,id=npmrc,target=/root/.npmrc yarn

CMD ["node", "index.js"]