FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/api
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]
