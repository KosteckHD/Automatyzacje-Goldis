FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build -w @goldis/worker
RUN mkdir -p /home/pwuser/goldis-profile /home/pwuser/goldis-staging && chown -R pwuser:pwuser /home/pwuser/goldis-profile /home/pwuser/goldis-staging
USER pwuser
ENV WORKER_PROFILE_DIR=/home/pwuser/goldis-profile
CMD ["node", "apps/worker/dist/run-worker.js"]
