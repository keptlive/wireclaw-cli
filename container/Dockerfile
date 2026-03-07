# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    git \
    # File parsing: PDF text extraction (pdftotext, pdfinfo)
    poppler-utils \
    # File parsing: document format conversion (docx/xlsx/pptx/markdown to text)
    pandoc \
    # File parsing: image manipulation and conversion
    imagemagick \
    # File parsing: audio/video metadata and processing
    ffmpeg \
    # File parsing: OCR for images
    tesseract-ocr \
    tesseract-ocr-eng \
    # File parsing: JSON processing on CLI
    jq \
    # File parsing: archive extraction
    unzip \
    # File parsing: file type detection
    file \
    && rm -rf /var/lib/apt/lists/*

# Install Python research libraries
RUN pip3 install --break-system-packages requests arxiv semanticscholar beautifulsoup4 lxml

# Install Python file parsing libraries
RUN pip3 install --break-system-packages \
    pdfplumber \
    openpyxl \
    python-docx \
    python-pptx \
    Pillow \
    pytesseract \
    pandas \
    chardet \
    markdown \
    striprtf

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
