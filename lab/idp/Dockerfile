# Minimal lab OIDC IdP. Zero npm deps — node:slim only. See server.mjs.
FROM node:20-bookworm-slim
WORKDIR /app
COPY server.mjs ./
EXPOSE 5556
# Exec form so SIGTERM reaches Node.
CMD ["node", "server.mjs"]
