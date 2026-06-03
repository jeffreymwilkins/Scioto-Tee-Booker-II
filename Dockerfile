FROM node:18-bookworm-slim

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package*.json ./

# Install dependencies (skip postinstall -- we handle Playwright below)
RUN npm ci --ignore-scripts --production

# Install Playwright Chromium with ALL required system dependencies
# The --with-deps flag installs libatk, libcups, libgbm, libnss3, etc.
RUN npx playwright install --with-deps chromium

# Copy application code
COPY . .

# Render sets PORT dynamically
EXPOSE 3000

CMD ["node", "server.js"]
