# The MCP server as a container, for directories that check a server starts
# and answers introspection (Glama). Installs the published package; stdio.
#   docker build -t context-doctor . && docker run -i --rm context-doctor
FROM node:22-slim
RUN npm install -g context-doctor@latest && npm cache clean --force
ENTRYPOINT ["context-doctor-mcp"]
