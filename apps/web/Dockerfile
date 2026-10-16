FROM node:24-alpine
WORKDIR /app
ENV API_INTERNAL_URL=http://api:3001
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/web
RUN chown -R node:node /app/apps/web/.next
EXPOSE 3000
USER node
CMD ["npm", "run", "start", "-w", "@goldis/web"]
