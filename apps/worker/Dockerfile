FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY . .
COPY deploy/docker/load-runtime-secrets.sh /usr/local/bin/load-runtime-secrets.sh
RUN chmod 0755 /usr/local/bin/load-runtime-secrets.sh
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/worker
RUN mkdir -p /home/pwuser/goldis-profile /home/pwuser/goldis-staging && chown -R pwuser:pwuser /home/pwuser/goldis-profile /home/pwuser/goldis-staging
USER pwuser
ENTRYPOINT ["/usr/local/bin/load-runtime-secrets.sh"]
ENV WORKER_PROFILE_DIR=/home/pwuser/goldis-profile
CMD ["node", "apps/worker/dist/run-worker.js"]
