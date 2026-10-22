FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:20-slim AS runner
WORKDIR /app
RUN groupadd -r valles && useradd -r -g valles valles
COPY --from=deps --chown=valles:valles /app/node_modules ./node_modules
COPY --chown=valles:valles package.json ./
COPY --chown=valles:valles src ./src
COPY --chown=valles:valles frontend ./frontend
USER valles
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
