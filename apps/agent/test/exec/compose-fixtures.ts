/**
 * Compose shapes of real repositories that broke the agent (structure only, no project content).
 *
 * BOT_REPO mirrors a public bot repository: one built service reading a gitignored `.env` through
 * a list-form, service-level `env_file`, a committed `.env.example`, fixed `container_name`s,
 * interpolated published ports, a bind mount, comments with quotes and backticks, and a healthy
 * sidecar it depends on. No include / extends / devcontainer.
 */
export const BOT_REPO_COMPOSE = `services:
  bot:
    # Users: \`docker compose pull && docker compose up -d\` (set BOT_TAG to
    # pin a version). Developers: \`docker compose up -d --build\`.
    build: .
    image: ghcr.io/example/bot:\${BOT_TAG:-latest}
    container_name: bot
    restart: unless-stopped
    # Reads BOT_TOKEN and the optional settings from your local .env file (never committed).
    env_file:
      - .env
    volumes:
      - ./data:/app/data
    ports:
      - "\${WEB_BIND:-127.0.0.1}:\${WEB_PORT:-47823}:\${WEB_PORT:-47823}"
    depends_on:
      helper:
        condition: service_healthy

  # Token provider. Upstream answers datacenter IPs with ("Sign in to confirm you're not a bot");
  # only the bot needs it, over the compose network.
  helper:
    image: busybox:1.36
    container_name: bot-helper
    command: ["sleep", "infinity"]
    restart: unless-stopped
    expose:
      - "4416"
    healthcheck:
      test:
        - CMD
        - "true"
      interval: 2s
      timeout: 5s
      retries: 5
`;

export const BOT_REPO_FILES: Record<string, string> = {
  'docker-compose.yml': BOT_REPO_COMPOSE,
  '.env.example': '# Copy to .env and fill in. Never commit .env.\nBOT_TOKEN=\nWEB_PORT=47823\n',
  '.gitignore': '.env\n',
  'data/.gitkeep': '',
  Dockerfile: 'FROM busybox:1.36\nCMD ["sleep", "infinity"]\n',
};

/** What `docker compose config --format json` resolves BOT_REPO to (with the env_file override). */
export function botRepoModel(clone: string): Record<string, unknown> {
  return {
    name: 'orch-task-asg-1',
    services: {
      bot: {
        build: { context: clone, dockerfile: 'Dockerfile' },
        image: 'ghcr.io/example/bot:latest',
        container_name: 'bot',
        restart: 'unless-stopped',
        environment: { BOT_TOKEN: '', WEB_PORT: '47823' },
        volumes: [{ type: 'bind', source: `${clone}/data`, target: '/app/data', bind: {} }],
        ports: [
          {
            mode: 'ingress',
            host_ip: '127.0.0.1',
            target: 47823,
            published: '47823',
            protocol: 'tcp',
          },
        ],
        depends_on: { helper: { condition: 'service_healthy', required: true } },
        networks: { default: null },
      },
      helper: {
        image: 'busybox:1.36',
        container_name: 'bot-helper',
        restart: 'unless-stopped',
        expose: ['4416'],
        networks: { default: null },
      },
    },
    networks: { default: { name: 'orch-task-asg-1_default' } },
  };
}
