FROM node:22-slim
WORKDIR /app
COPY . .
ENV PORT=3000 DB_PATH=/app/data/cinemetrics.db
VOLUME /app/data
EXPOSE 3000
CMD ["node","--no-warnings","server.js"]
