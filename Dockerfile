# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# Dependências primeiro (melhor cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Código da aplicação
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "start"]
