FROM node:alpine

RUN mkdir -p /usr/src/preservetube/metadata
WORKDIR /usr/src/preservetube/metadata

COPY . /usr/src/preservetube/metadata
RUN yarn

CMD ["node", "index.js"]