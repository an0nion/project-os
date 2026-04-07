FROM node:20-alpine
WORKDIR /app

# Only install production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Only copy what the bot needs
COPY slack/ ./slack/

CMD ["node", "slack/bot.js"]
