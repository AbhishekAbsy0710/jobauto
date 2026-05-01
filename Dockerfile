FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium --with-deps 2>/dev/null || true
COPY . .
RUN mkdir -p db output
EXPOSE 3000
CMD ["node", "src/server.js"]
