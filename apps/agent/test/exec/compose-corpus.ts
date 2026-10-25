/**
 * Corpus for the compose guard: realistic benign repositories (all accepted) and one malicious
 * compose file per escape vector (all refused, with the message matching `refused`).
 *
 * The resolved models (`docker compose config --format json` with the real CLI) are stored in
 * compose-corpus.snapshots.json, with the case directory written as @ROOT@ and its parent as
 * @PARENT@. Regenerate them after changing a case (needs a docker CLI with compose):
 *   cd apps/agent && npx tsx test/exec/compose-corpus.regen.ts && npx prettier --write test/exec/compose-corpus.snapshots.json
 */

export interface CorpusCase {
  name: string;
  /** Files of the repository; `compose.yaml` is the compose file. */
  files: Record<string, string>;
  /** Malicious cases: a problem must match this. Benign cases have none. */
  refused?: RegExp;
}

export const CORPUS_PROJECT = 'orch-task-corpus';
export const CORPUS_NETWORK = 'orch-net-corpus';

const DOCKERFILE =
  'FROM node:24-alpine AS dev\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n';

const one = (svc: string, top = ''): Record<string, string> => ({
  'compose.yaml': `services:\n  evil:\n    image: alpine:3\n${svc}${top}`,
});

export const BENIGN: CorpusCase[] = [
  {
    name: 'postgres with healthcheck and named volume',
    files: {
      'compose.yaml': `services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-secret}
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    shm_size: 256m
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 5s
      retries: 10
volumes:
  pgdata:
`,
      'db/init.sql': 'create table t (id int);\n',
    },
  },
  {
    name: 'redis with command, sysctl and tmpfs',
    files: {
      'compose.yaml': `services:
  cache:
    image: redis:8-alpine
    command: ["redis-server", "--appendonly", "yes"]
    sysctls:
      net.core.somaxconn: 1024
    tmpfs:
      - /tmp:size=64m,mode=1777
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
    volumes:
      - redis:/data
volumes:
  redis: {}
`,
    },
  },
  {
    name: 'mysql with ulimits, cap_add SYS_NICE (dropped) and env_file',
    files: {
      'compose.yaml': `services:
  mysql:
    image: mysql:8.4
    container_name: myapp-mysql
    cap_add:
      - SYS_NICE
    env_file:
      - .env.example
    environment:
      MYSQL_DATABASE: app
    ulimits:
      nofile:
        soft: 65536
        hard: 65536
    ports:
      - "127.0.0.1:3306:3306"
    volumes:
      - mysql:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      retries: 20
volumes:
  mysql:
`,
      '.env.example': 'MYSQL_ROOT_PASSWORD=root\n',
    },
  },
  {
    name: 'minio with console and mc healthcheck',
    files: {
      'compose.yaml': `services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio123
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
    deploy:
      resources:
        limits:
          memory: 512m
volumes:
  minio:
`,
    },
  },
  {
    name: 'localstack without the docker socket',
    files: {
      'compose.yaml': `services:
  localstack:
    image: localstack/localstack:4
    ports:
      - "127.0.0.1:4566:4566"
    environment:
      - SERVICES=s3,sqs,dynamodb
      - DEBUG=\${DEBUG:-0}
    volumes:
      - ./localstack/init:/etc/localstack/init/ready.d
      - localstack:/var/lib/localstack
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4566/_localstack/health"]
      interval: 10s
volumes:
  localstack:
`,
      'localstack/init/setup.sh': '#!/bin/sh\nawslocal s3 mb s3://bucket\n',
    },
  },
  {
    name: 'mailhog with published ports',
    files: {
      'compose.yaml': `services:
  mailhog:
    image: mailhog/mailhog:v1.0.1
    ports:
      - "1025:1025"
      - "8025:8025"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://localhost:8025 > /dev/null"]
      interval: 5s
`,
    },
  },
  {
    name: 'app built from the repo Dockerfile with depends_on, networks, profiles and x- anchors',
    files: {
      'compose.yaml': `x-common: &common
  restart: on-failure
  logging:
    driver: json-file
    options:
      max-size: 50m
services:
  app:
    <<: *common
    build:
      context: .
      dockerfile: docker/Dockerfile
      args:
        NODE_ENV: development
      target: dev
    image: ghcr.io/acme/app:dev
    init: true
    read_only: true
    user: "1000:1000"
    tmpfs: ["/tmp"]
    environment:
      DATABASE_URL: postgres://app:secret@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    networks: [back]
    volumes:
      - .:/app
    extra_hosts:
      - "api.local:10.0.0.5"
    dns: [1.1.1.1]
    stop_grace_period: 10s
    cpus: 1.5
    mem_limit: 1g
    pids_limit: 512
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]
  db:
    <<: *common
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: secret
    networks: [back]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 2s
  docs:
    image: nginx:alpine
    profiles: [docs]
    volumes:
      - ./docs:/usr/share/nginx/html:ro
networks:
  back: {}
`,
      'docker/Dockerfile': DOCKERFILE,
      'server.js': 'setInterval(() => undefined, 1 << 30);\n',
      'docs/index.html': '<p>docs</p>\n',
    },
  },
];

export const MALICIOUS: CorpusCase[] = [
  {
    name: 'privileged',
    files: one('    privileged: true\n'),
    refused: /privileged is not allowed/,
  },
  {
    name: 'cap_add SYS_ADMIN',
    files: one('    cap_add: [SYS_ADMIN]\n'),
    refused: /cap_add "SYS_ADMIN" is not allowed/,
  },
  {
    name: 'cap_add NET_RAW (lowercase, CAP_ prefix)',
    files: one('    cap_add: [cap_net_raw]\n'),
    refused: /cap_add "cap_net_raw" is not allowed/,
  },
  {
    name: 'cap_add ALL',
    files: one('    cap_add: [ALL]\n'),
    refused: /cap_add "ALL" is not allowed/,
  },
  {
    name: 'seccomp unconfined',
    files: one('    security_opt: ["seccomp:unconfined"]\n'),
    refused: /security_opt "seccomp:unconfined"/,
  },
  {
    name: 'apparmor unconfined',
    files: one('    security_opt: ["apparmor=unconfined"]\n'),
    refused: /security_opt "apparmor=unconfined"/,
  },
  {
    name: 'selinux label disable',
    files: one('    security_opt: ["label=disable"]\n'),
    refused: /security_opt "label=disable"/,
  },
  {
    name: 'devices',
    files: one('    devices: ["/dev/sda:/dev/sda"]\n'),
    refused: /devices is not allowed/,
  },
  {
    name: 'device_cgroup_rules',
    files: one('    device_cgroup_rules: ["b *:* rwm"]\n'),
    refused: /device_cgroup_rules is not allowed/,
  },
  { name: 'pid host', files: one('    pid: host\n'), refused: /pid "host" is not allowed/ },
  { name: 'ipc host', files: one('    ipc: host\n'), refused: /ipc "host" is not allowed/ },
  { name: 'uts host', files: one('    uts: host\n'), refused: /uts "host" is not allowed/ },
  {
    name: 'userns_mode host',
    files: one('    userns_mode: host\n'),
    refused: /userns_mode "host" is not allowed/,
  },
  {
    name: 'cgroup host',
    files: one('    cgroup: host\n'),
    refused: /cgroup "host" is not allowed/,
  },
  {
    name: 'cgroup_parent',
    files: one('    cgroup_parent: system.slice\n'),
    refused: /cgroup_parent is not allowed/,
  },
  {
    name: 'network_mode host',
    files: one('    network_mode: host\n'),
    refused: /network_mode "host" is not allowed/,
  },
  {
    name: 'network_mode container',
    files: one('    network_mode: "container:orch-task-12-other"\n'),
    refused: /network_mode "container:orch-task-12-other" is not allowed/,
  },
  {
    name: 'external network of another task',
    files: one(
      '    networks: [other]\n',
      'networks:\n  other:\n    external: true\n    name: orch-net-other-task\n',
    ),
    refused: /external networks are not allowed/,
  },
  {
    name: 'network attached to the host bridge',
    files: one(
      '    networks: [lan]\n',
      'networks:\n  lan:\n    driver_opts:\n      com.docker.network.bridge.name: docker0\n',
    ),
    refused: /driver_opts are not allowed/,
  },
  {
    name: 'macvlan network',
    files: one('    networks: [lan]\n', 'networks:\n  lan:\n    driver: macvlan\n'),
    refused: /driver "macvlan" is not allowed/,
  },
  {
    name: 'docker socket bind mount',
    files: one('    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n'),
    refused: /bind mount of "\/var\/run\/docker.sock" is outside the repository/,
  },
  {
    name: 'host root bind mount',
    files: one('    volumes: ["/:/host"]\n'),
    refused: /bind mount of "\/" is outside the repository/,
  },
  {
    name: 'bind mount of the parent directory',
    files: one('    volumes: ["../:/up"]\n'),
    refused: /bind mount of .* is outside the repository/,
  },
  {
    name: 'bind mount with shared propagation',
    files: one(
      '    volumes:\n      - type: bind\n        source: ./data\n        target: /d\n        bind:\n          propagation: rshared\n',
    ),
    refused: /bind propagation "rshared" is not allowed/,
  },
  {
    name: 'local volume driver bind trick',
    files: one(
      '    volumes: ["etc:/x"]\n',
      'volumes:\n  etc:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /etc\n',
    ),
    refused: /driver_opts are not allowed/,
  },
  {
    name: 'external volume',
    files: one(
      '    volumes: ["data:/x"]\n',
      'volumes:\n  data:\n    external: true\n    name: orch-agent-data\n',
    ),
    refused: /external volumes are not allowed/,
  },
  {
    name: "volume of another task's project",
    files: one('    volumes: ["data:/x"]\n', 'volumes:\n  data:\n    name: orch-task-other_data\n'),
    refused: /must be named orch-task-corpus_\*/,
  },
  {
    name: 'volumes_from a container',
    files: one('    volumes_from: ["container:orch-task-12-other"]\n'),
    refused: /volumes_from "container:orch-task-12-other" is not allowed/,
  },
  {
    name: 'tmpfs with dev option',
    files: one('    tmpfs: ["/x:dev,size=10m"]\n'),
    refused: /tmpfs option "dev" is not allowed/,
  },
  {
    name: 'ulimit rtprio',
    files: one('    ulimits:\n      rtprio: 99\n'),
    refused: /ulimit "rtprio" is not allowed/,
  },
  {
    name: 'ulimit core dumps',
    files: one('    ulimits:\n      core: -1\n'),
    refused: /ulimit "core" -1 is above the cap 0/,
  },
  {
    name: 'ulimit nofile above the cap',
    files: one('    ulimits:\n      nofile: 99999999\n'),
    refused: /ulimit "nofile" 99999999 is above the cap/,
  },
  {
    name: 'host-wide sysctl',
    files: one('    sysctls:\n      kernel.core_pattern: "|/tmp/x"\n'),
    refused: /sysctl "kernel.core_pattern" is not allowed/,
  },
  {
    name: 'extra_hosts host-gateway',
    files: one('    extra_hosts: ["host.docker.internal:host-gateway"]\n'),
    refused: /extra_hosts "host-gateway" is not allowed/,
  },
  {
    name: 'oom_score_adj negative',
    files: one('    oom_score_adj: -1000\n'),
    refused: /oom_score_adj -1000 is not allowed/,
  },
  {
    name: 'oom_kill_disable',
    files: one('    oom_kill_disable: true\n'),
    refused: /oom_kill_disable is not allowed/,
  },
  { name: 'runtime', files: one('    runtime: nvidia\n'), refused: /runtime is not allowed/ },
  {
    name: 'isolation',
    files: one('    isolation: hyperv\n'),
    refused: /isolation is not allowed/,
  },
  { name: 'gpus', files: one('    gpus: all\n'), refused: /gpus is not allowed/ },
  {
    name: 'use_api_socket',
    files: one('    use_api_socket: true\n'),
    refused: /use_api_socket is not allowed/,
  },
  {
    name: 'cpu_rt_runtime',
    files: one('    cpu_rt_runtime: 950000\n'),
    refused: /cpu_rt_runtime is not allowed/,
  },
  {
    name: 'blkio_config',
    files: one('    blkio_config:\n      weight: 1000\n'),
    refused: /blkio_config is not allowed/,
  },
  {
    name: 'storage_opt',
    files: one('    storage_opt:\n      size: 1T\n'),
    refused: /storage_opt is not allowed/,
  },
  {
    name: 'external_links',
    files: one('    external_links: ["orch-task-12-other:db"]\n'),
    refused: /external_links is not allowed/,
  },
  {
    name: 'syslog logging to the host socket',
    files: one(
      '    logging:\n      driver: syslog\n      options:\n        syslog-address: unix:///dev/log\n',
    ),
    refused: /logging driver "syslog" is not allowed/,
  },
  {
    name: 'privileged post_start hook',
    files: one('    post_start:\n      - command: ["id"]\n        privileged: true\n'),
    refused: /privileged post_start hook is not allowed/,
  },
  {
    name: 'label impersonating orch',
    files: one('    labels:\n      orch.task: asg_other\n'),
    refused: /label "orch.task" is reserved for orch/,
  },
  {
    name: 'label impersonating another compose project',
    files: one('    labels:\n      com.docker.compose.project: orch-task-other\n'),
    refused: /label "com.docker.compose.project" is reserved/,
  },
  {
    name: 'scale above the cap',
    files: one('    scale: 50\n'),
    refused: /scale 50 is above the cap 3/,
  },
  {
    name: 'deploy replicas above the cap',
    files: one('    deploy:\n      replicas: 100\n'),
    refused: /deploy.replicas 100 is above the cap 3/,
  },
  {
    name: 'too many services',
    files: {
      'compose.yaml': `services:\n${Array.from({ length: 17 }, (_, i) => `  s${i}:\n    image: alpine:3\n`).join('')}`,
    },
    refused: /17 services: at most 16 are allowed/,
  },
  {
    name: 'build context outside the repository',
    files: one('    build:\n      context: ..\n'),
    refused: /build context .* is outside the repository/,
  },
  {
    name: 'remote build context',
    files: one('    build: https://github.com/acme/evil.git#main\n'),
    refused: /remote build context/,
  },
  {
    name: 'build ssh forwarding',
    files: {
      ...one('    build:\n      context: .\n      ssh: [default]\n'),
      Dockerfile: DOCKERFILE,
    },
    refused: /build ssh is not allowed/,
  },
  {
    name: 'build secrets',
    files: {
      ...one(
        '    build:\n      context: .\n      secrets: [token]\n',
        'secrets:\n  token:\n    file: ./token.txt\n',
      ),
      Dockerfile: DOCKERFILE,
      'token.txt': 'x\n',
    },
    refused: /build secrets is not allowed/,
  },
  {
    name: 'additional build context outside the repository',
    files: {
      ...one('    build:\n      context: .\n      additional_contexts:\n        etc: /etc\n'),
      Dockerfile: DOCKERFILE,
    },
    refused: /additional build context "\/etc" is outside the repository/,
  },
  {
    name: 'build network host',
    files: {
      ...one('    build:\n      context: .\n      network: host\n'),
      Dockerfile: DOCKERFILE,
    },
    refused: /build network "host" is not allowed/,
  },
  {
    name: 'build cache from a host directory',
    files: {
      ...one('    build:\n      context: .\n      cache_from: ["type=local,src=/root"]\n'),
      Dockerfile: DOCKERFILE,
    },
    refused: /build cache_from "type=local,src=\/root" is not allowed/,
  },
  {
    name: 'build entitlements',
    files: {
      ...one('    build:\n      context: .\n      entitlements: [security.insecure]\n'),
      Dockerfile: DOCKERFILE,
    },
    refused: /build entitlements is not allowed/,
  },
  {
    name: 'secret file outside the repository',
    files: one('    secrets: [shadow]\n', 'secrets:\n  shadow:\n    file: /etc/shadow\n'),
    refused: /secret "shadow": file "\/etc\/shadow" is outside the repository/,
  },
  {
    name: "secret from the agent's environment",
    files: one('    secrets: [tok]\n', 'secrets:\n  tok:\n    environment: GITHUB_TOKEN\n'),
    refused: /secret "tok": "environment" is not allowed/,
  },
  {
    name: 'config file outside the repository',
    files: one('    configs: [pw]\n', 'configs:\n  pw:\n    file: /etc/passwd\n'),
    refused: /config "pw": file "\/etc\/passwd" is outside the repository/,
  },
  {
    name: 'env_file outside the repository',
    files: one('    env_file: [/etc/environment]\n'),
    refused: /env_file "\/etc\/environment" is outside the repository/,
  },
  {
    name: 'remote include',
    files: {
      'compose.yaml':
        'include:\n  - oci://docker.io/acme/evil:latest\nservices:\n  a:\n    image: alpine:3\n',
    },
    refused: /include "oci:\/\/docker.io\/acme\/evil:latest" is a remote reference/,
  },
  {
    name: 'include outside the repository',
    files: {
      'compose.yaml': 'include:\n  - ../other/compose.yaml\nservices:\n  a:\n    image: alpine:3\n',
    },
    refused: /include "..\/other\/compose.yaml" is outside the repository/,
  },
  {
    name: 'interpolated include',
    files: {
      'compose.yaml': 'include:\n  - ${HOME}/compose.yaml\nservices:\n  a:\n    image: alpine:3\n',
    },
    refused: /uses variable interpolation/,
  },
  {
    name: 'extends a file outside the repository',
    files: {
      'compose.yaml':
        'services:\n  a:\n    extends:\n      file: /etc/orch/compose.yaml\n      service: x\n',
    },
    refused: /extends file "\/etc\/orch\/compose.yaml" is outside the repository/,
  },
  {
    // One sidecar gets a writable bind of a parent directory; before a second sidecar mounts a
    // path under it, the first replaces that path with a symlink to the host (e.g. /etc). The
    // source scan cannot see it (the symlink is planted at run time), so the overlap is refused.
    name: 'writable bind mount redirecting another sidecar to the host',
    files: {
      'compose.yaml':
        'services:\n' +
        '  planter:\n' +
        '    image: alpine:3\n' +
        '    volumes:\n' +
        '      - ./:/repo\n' +
        '    command: ["sh", "-c", "ln -sfn /etc /repo/data"]\n' +
        '  victim:\n' +
        '    image: alpine:3\n' +
        '    depends_on:\n' +
        '      planter:\n' +
        '        condition: service_completed_successfully\n' +
        '    volumes:\n' +
        '      - ./data:/host:ro\n',
    },
    refused: /writable bind mount of ".*" is a parent of .*'s bind mount/,
  },
];
