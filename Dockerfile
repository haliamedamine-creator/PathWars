FROM node:22-alpine
WORKDIR /srv/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY app/ ../app/
EXPOSE 3000
CMD ["node", "server.js"]
