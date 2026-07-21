FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci
RUN npm run build --workspace @ira/web-chat

FROM nginx:1.27-alpine

COPY infra/docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web-chat/dist /usr/share/nginx/html

EXPOSE 80

