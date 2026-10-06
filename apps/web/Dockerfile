FROM node:24-alpine
WORKDIR /app
ENV API_INTERNAL_URL=http://api:3001
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/web
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@goldis/web"]
