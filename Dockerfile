# Use official Node.js runtime as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY src ./src
COPY keys ./keys

# Create logs directory
RUN mkdir -p logs

# Start the application in daemon mode
CMD ["node", "src/index.js"]
