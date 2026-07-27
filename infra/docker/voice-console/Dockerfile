FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

ARG VITE_VOICE_SENSITIVITY_LEVEL
ENV VITE_VOICE_SENSITIVITY_LEVEL=$VITE_VOICE_SENSITIVITY_LEVEL

RUN npm ci
RUN npm run build --workspace @ira/voice-console

FROM nginx:1.27-alpine

COPY infra/docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/voice-console/dist /usr/share/nginx/html

EXPOSE 80

