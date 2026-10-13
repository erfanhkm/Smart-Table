FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
