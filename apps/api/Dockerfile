FROM node:24-alpine
WORKDIR /app
COPY . .
COPY deploy/docker/load-runtime-secrets.sh /usr/local/bin/load-runtime-secrets.sh
RUN chmod 0755 /usr/local/bin/load-runtime-secrets.sh
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/api
RUN mkdir -p /var/lib/goldis/exports /var/lib/goldis/deletion-journal \
  && chown -R node:node /app /var/lib/goldis
EXPOSE 3001
USER node
ENTRYPOINT ["/usr/local/bin/load-runtime-secrets.sh"]
CMD ["node", "apps/api/dist/main.js"]
