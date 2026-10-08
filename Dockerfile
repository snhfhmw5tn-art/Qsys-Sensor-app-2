FROM node:22-alpine
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server ./server
COPY shared ./shared
COPY client ./client
COPY vendor ./vendor
COPY sw.js ./sw.js
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
